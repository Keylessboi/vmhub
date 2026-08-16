/**
 * macOS adapter — thin MCP-client wrapper over the in-VM mac-control-mcp
 * server, plus an SSH channel for exec/scp/git. Follows the x11 real-adapter
 * pattern exactly: the adapter is a transport + command-construction layer,
 * never a reimplementation of mac-control-mcp's logic.
 *
 * Transport: each VM gets a StdioClientTransport that SSHes through the
 * Proxmox host (ProxyJump) and runs /usr/local/bin/launch-macos-mcp in the
 * macOS guest. Connections spawn lazily on first use, so vmhub-mcp serves the
 * catalog even when the guest is down — degradation is a typed VmError.
 *
 * Tool mapping (mac-control-mcp surface → vm_* contract):
 *   vm_screenshot → screenshot (screencapture/CGWindowList)
 *   vm_click/type/key/paste/drag → click/type/key/paste/drag (CGEventPost)
 *   vm_list_windows / vm_inspect → list_windows / inspect (AX)
 *   vm_launch/focus/close → launch/focus/close (AX app control)
 *   vm_exec → ssh; vm_put_file/vm_get_file → scp; vm_clone_repo → ssh git
 *   dispatch 'health' → dual-channel screenshot/inspect report
 */
import type {
  CapabilityId,
  Capability,
  DesktopAdapter,
  ExecResult,
  FileCapability,
  InputAction,
  InputCapability,
  ScreenshotResult,
  SemanticElement,
  TemplateConstraint,
  Vm,
  WindowInfo,
  WindowingSystem,
} from '../../src/shared/types.ts';
import { CAPABILITIES } from '../../src/shared/types.ts';
import { vmError } from '../../src/mcp/errors.ts';
import { nodeSshRunner, type SshRunner } from '../transport.ts';
import { gitCloneIntoMacosArgs, macosSshArgs, scpIntoMacosArgs } from './ssh.ts';
import {
  defaultMacosClient,
  firstMacosText,
  mapMacosError,
  parseMacosPayload,
  parseMacosScreenshot,
  parseMacosTree,
  parseMacosWindows,
  type MacosMcpClient,
} from './mcp.ts';

/** Capability → mac-control-mcp tool mapping. */
export const MACOS_TOOL_MAP = {
  screenshot: 'screenshot',
  inspect: 'inspect',
  list_windows: 'list_windows',
  click: 'click',
  type: 'type',
  key: 'key',
  paste: 'paste',
  drag: 'drag',
  launch: 'launch',
  focus: 'focus',
  close: 'close',
} as const;

export interface MacosAdapterOptions {
  ssh?: SshRunner;
  clientFactory?: (vm: Vm) => Promise<MacosMcpClient> | MacosMcpClient;
}

export class MacosAdapter implements DesktopAdapter {
  readonly id = 'macos';
  readonly templateConstraints: TemplateConstraint[] = [{ cpu: { avx2: true }, nestedVirt: false }];
  readonly capability: Capability = {
    adapter: 'macos',
    os: 'macos',
    windowing: ['macos'] as WindowingSystem[],
    input: ['click', 'type', 'key', 'paste', 'drag'] as InputCapability[],
    semantic: 'ax',
    files: ['scp'] as FileCapability[],
    exec: true,
    notes: 'Real macOS golden via in-VM mac-control-mcp over SSH (macos-sequoia-15.7.9).',
  };

  private readonly ssh: SshRunner;
  private readonly clientFactory: (vm: Vm) => Promise<MacosMcpClient> | MacosMcpClient;
  private readonly conns = new Map<string, MacosMcpClient>();

  constructor(opts: MacosAdapterOptions = {}) {
    this.ssh = opts.ssh ?? nodeSshRunner;
    this.clientFactory = opts.clientFactory ?? defaultMacosClient;
  }

  availableTools(): CapabilityId[] {
    return [
      CAPABILITIES.screenshot,
      CAPABILITIES.inspect,
      CAPABILITIES.listWindows,
      CAPABILITIES.click,
      CAPABILITIES.type,
      CAPABILITIES.key,
      CAPABILITIES.paste,
      CAPABILITIES.drag,
      CAPABILITIES.launch,
      CAPABILITIES.focus,
      CAPABILITIES.close,
      CAPABILITIES.dispatch,
      CAPABILITIES.exec,
      CAPABILITIES.putFile,
      CAPABILITIES.getFile,
      CAPABILITIES.cloneRepo,
    ];
  }

  /** Per-VM mac-control-mcp connection, keyed by uuid. */
  private async ensureConnection(vm: Vm): Promise<MacosMcpClient> {
    const existing = this.conns.get(vm.uuid);
    if (existing) return existing;
    const client = await this.clientFactory(vm);
    this.conns.set(vm.uuid, client);
    return client;
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    const res = await this.call(vm, MACOS_TOOL_MAP.screenshot, {});
    return parseMacosScreenshot(res.result, res.content);
  }

  async input(vm: Vm, action: InputAction): Promise<void> {
    switch (action.kind) {
      case 'click':
        await this.call(vm, MACOS_TOOL_MAP.click, { x: action.x, y: action.y, button: action.button ?? 'left' });
        return;
      case 'type':
        await this.call(vm, MACOS_TOOL_MAP.type, { text: action.text });
        return;
      case 'key':
        await this.call(vm, MACOS_TOOL_MAP.key, { chord: action.chord });
        return;
      case 'paste':
        await this.call(vm, MACOS_TOOL_MAP.paste, { text: action.text });
        return;
      case 'drag':
        await this.call(vm, MACOS_TOOL_MAP.drag, {
          start_x: action.from.x,
          start_y: action.from.y,
          end_x: action.to.x,
          end_y: action.to.y,
        });
        return;
      case 'gesture':
        throw vmError('CAPABILITY_UNAVAILABLE', 'macos adapter: gestures are not supported');
    }
  }

  async listWindows(vm: Vm, filter?: string): Promise<WindowInfo[]> {
    const res = await this.call(vm, MACOS_TOOL_MAP.list_windows, {});
    return parseMacosWindows(res.result, filter);
  }

  async inspect(vm: Vm): Promise<SemanticElement> {
    const res = await this.call(vm, MACOS_TOOL_MAP.inspect, {});
    return parseMacosTree(res.result, firstMacosText(res.content) ?? '');
  }

  async exec(vm: Vm, cmd: string, args: string[] = []): Promise<ExecResult> {
    if (!vm.ip) throw vmError('INTERNAL', `macos adapter: VM ${vm.uuid} has no ip — cannot exec`);
    const res = await this.ssh.run('ssh', [...macosSshArgs(vm), cmd, ...args]);
    return { exitCode: res.exitCode, stdout: String(res.stdout), stderr: res.stderr };
  }

  async putFile(vm: Vm, localPath: string, remotePath: string): Promise<void> {
    if (!vm.ip) throw vmError('INTERNAL', `macos adapter: VM ${vm.uuid} has no ip — cannot put_file`);
    await this.ssh.run('scp', scpIntoMacosArgs(vm, localPath, remotePath, 'put'));
  }

  async getFile(vm: Vm, remotePath: string, localPath: string): Promise<void> {
    if (!vm.ip) throw vmError('INTERNAL', `macos adapter: VM ${vm.uuid} has no ip — cannot get_file`);
    await this.ssh.run('scp', scpIntoMacosArgs(vm, localPath, remotePath, 'get'));
  }

  async cloneRepo(vm: Vm, repoUrl: string, destPath: string): Promise<void> {
    if (!vm.ip) throw vmError('INTERNAL', `macos adapter: VM ${vm.uuid} has no ip — cannot clone_repo`);
    await this.ssh.run('ssh', gitCloneIntoMacosArgs(vm, repoUrl, destPath));
  }

  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    switch (verb) {
      case 'launch':
        return (await this.call(vm, MACOS_TOOL_MAP.launch, { command: String(args.command), args: argvOf(args) })).result;
      case 'focus':
        return (await this.call(vm, MACOS_TOOL_MAP.focus, { window: String(args.window) })).result;
      case 'close':
        return (await this.call(vm, MACOS_TOOL_MAP.close, { window: String(args.window) })).result;
      case 'paste':
        return (await this.call(vm, MACOS_TOOL_MAP.paste, { text: String(args.text) })).result;
      case 'health':
        return this.health(vm);
      default:
        throw vmError('CAPABILITY_UNAVAILABLE', `macos adapter: unknown dispatch verb "${verb}"`);
    }
  }

  /** Dual-channel health: screenshot and inspect each reported independently. */
  async health(vm: Vm): Promise<{ screenshot: 'ok' | 'degraded'; inspect: 'ok' | 'degraded'; transport: 'ok' | 'degraded' }> {
    const screenshot = await this.probe(vm, MACOS_TOOL_MAP.screenshot);
    const inspect = await this.probe(vm, MACOS_TOOL_MAP.inspect);
    return { screenshot, inspect, transport: screenshot === 'ok' || inspect === 'ok' ? 'ok' : 'degraded' };
  }

  private async probe(vm: Vm, name: string): Promise<'ok' | 'degraded'> {
    try {
      await this.call(vm, name, {});
      return 'ok';
    } catch {
      return 'degraded';
    }
  }

  /** Call a mac-control-mcp tool and normalize failures to a typed VmError. */
  private async call(
    vm: Vm,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: Record<string, unknown>; content: unknown[] }> {
    const client = await this.ensureConnection(vm);
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) {
      throw vmError('INTERNAL', `macos tool "${name}" failed: ${firstMacosText(res.content) ?? 'unknown error'}`);
    }
    const payload = parseMacosPayload(res.structuredContent, res.content);
    if (payload && payload.ok === false) throw mapMacosError(payload, name);
    return { result: payload ?? {}, content: res.content };
  }
}

function argvOf(args: Record<string, unknown>): string[] {
  return Array.isArray(args.args) ? args.args.map(String) : [];
}

export const macosAdapter = new MacosAdapter();
