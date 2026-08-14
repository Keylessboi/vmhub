/**
 * Hyprland adapter — thin MCP-client wrapper over the compiled hyprland-mcp
 * binary.
 *
 * Verification note (2026-08-12): hyprland-mcp/src/index.ts DOES export
 * buildServer and registerCoreTools, so an inline import is possible in
 * principle. It was tried and rejected: embedding hyprland-mcp's source in
 * vmhub's strict program (verbatimModuleSyntax) fails typecheck on their files
 * (their tsconfig is less strict), and constructing their ServerDeps requires
 * a live Hyprland at adapter build time. The compiled binary at
 * /home/travis/Projects/hyprland-mcp/dist/hyprland-mcp is the sanctioned
 * fallback: spawn it as an MCP client (SDK v2 stdio transport) and map the
 * vm_* surface onto hyprland-mcp's TOOLS via HYPRLAND_TOOL_MAP.
 *
 * The binary is spawned lazily on first use, so vmhub-mcp starts and serves
 * the catalog even when Hyprland or the binary is absent — degradation is a
 * typed VmError, never a crash.
 */
import { existsSync } from 'node:fs';
import { Client, type Client as ClientType } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type {
  CapabilityId,
  DesktopAdapter,
  FileCapability,
  InputAction,
  InputCapability,
  ScreenshotResult,
  SemanticElement,
  Vm,
  VmError,
  WindowInfo,
  WindowingSystem,
} from '../../src/shared/types.ts';
import { CAPABILITIES } from '../../src/shared/types.ts';
import { vmError } from '../../src/mcp/errors.ts';
import { vmSshMcpTransport } from '../transport.ts';

/** Default compiled binary — override with HYPRLAND_MCP_BIN. */
export const DEFAULT_HYPRLAND_MCP_BIN = '/home/travis/Projects/hyprland-mcp/dist/hyprland-mcp';

export function hyprlandMcpBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.HYPRLAND_MCP_BIN ?? DEFAULT_HYPRLAND_MCP_BIN;
}

/** In-VM launcher path installed at golden build (runs bun-baseline + session env). */
export const IN_VM_LAUNCHER = '/usr/local/bin/launch-hypr-mcp';
export { sshJumpTarget, vmSshUser } from '../transport.ts';

/**
 * Capability → hyprland-mcp tool mapping. Every vm_* operation delegates to
 * exactly the tool named here. Capabilities absent from this table are not
 * available on hyprland (no exec / file-transfer path in hyprland-mcp).
 */
export const HYPRLAND_TOOL_MAP = {
  screenshot: 'screenshot',
  inspect: 'read_text_on_screen',
  list_windows: 'list_windows',
  click: 'input_click',
  type: 'input_type',
  key: 'input_key',
  paste: 'input_paste',
  drag: 'input_drag',
  launch: 'launch',
  focus: 'focus',
  close: 'close',
  dispatch: 'dispatch',
} as const;

interface HyprlandConnection {
  client: ClientType;
  transport: StdioClientTransport;
}

export class HyprlandAdapter implements DesktopAdapter {
  readonly id = 'hyprland';
  readonly capability = {
    adapter: 'hyprland',
    os: 'hyprland' as const,
    windowing: ['hyprland'] as WindowingSystem[],
    input: ['click', 'type', 'key', 'paste', 'drag'] as InputCapability[],
    semantic: 'wayland' as const,
    files: [] as FileCapability[],
    exec: false,
    notes: 'Host Hyprland desktop via the compiled hyprland-mcp binary.',
  };

  private conns = new Map<string, HyprlandConnection>();

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
    ];
  }

  /** Per-VM Hyprland MCP connection. Keyed by uuid; the host desktop is "local". */
  private async ensureConnection(vm: Vm): Promise<HyprlandConnection> {
    const key = vm.ip ? vm.uuid : "local";
    const existing = this.conns.get(key);
    if (existing) return existing;

    const transport = this.buildTransport(vm);
    const client = new Client({ name: 'vmhub-mcp-hyprland', version: '0.1.0' });
    try {
      await client.connect(transport);
    } catch (e) {
      throw vmError(
        'INTERNAL',
        `hyprland adapter: failed to connect (${e instanceof Error ? e.message : String(e)})`,
        vm.ip
          ? `Could not reach Hyprland in VM at ${vm.ip}. Ensure the VM is running and the desktop session is up.`
          : 'Hyprland must be running for hyprland-template VMs. Retry when the desktop session is up.',
      );
    }
    const conn = { client, transport };
    this.conns.set(key, conn);
    return conn;
  }

  /**
   * VM-aware transport:
   *  - vm.ip set → SSH through the Proxmox host into the VM, running the
   *    in-VM launcher (/usr/local/bin/launch-hypr-mcp). The host key + VM
   *    key are installed at golden build; -T keeps stdio clean for MCP.
   *  - no ip (host desktop) → spawn the local compiled binary, as before.
   */
  private buildTransport(vm: Vm): StdioClientTransport {
    if (vm.ip) {
      return vmSshMcpTransport(vm, IN_VM_LAUNCHER);
    }
    const bin = hyprlandMcpBin();
    if (!existsSync(bin)) {
      throw vmError(
        'INTERNAL',
        `hyprland adapter: compiled binary not found at ${bin}`,
        `Set HYPRLAND_MCP_BIN or build hyprland-mcp (bun run build in /home/travis/Projects/hyprland-mcp).`,
      );
    }
    return new StdioClientTransport({ command: bin });
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    const res = await this.call(vm, 'screenshot', { target: 'screen', jpeg: false });
    const result = res.result as {
      geometry?: { x: number; y: number; w: number; h: number };
      empty?: boolean;
    };
    if (result.empty) throw vmError('INTERNAL', 'hyprland screenshot produced no bytes');

    const image = await extractImage(res.content);
    // hyprland-mcp puts geometry in the text payload, not structuredContent.
    const text = res.content.find((c): c is { type: string; text?: string } => typeof c === 'object' && c !== null && (c as { type: string }).type === 'text')?.text;
    let geometry = result.geometry;
    if (!geometry && text) {
      try { geometry = JSON.parse(text).geometry; } catch { /* keep fallback */ }
    }
    const g = geometry ?? { x: 0, y: 0, w: 0, h: 0 };
    return {
      image: image.data,
      format: image.mime === 'image/jpeg' ? 'jpg' : 'png',
      width: g.w,
      height: g.h,
      coordMapping: { scaleX: 1, scaleY: 1, offsetX: g.x, offsetY: g.y },
    };
  }

  async input(vm: Vm, action: InputAction): Promise<void> {
    switch (action.kind) {
      case 'click':
        await this.call(vm, 'input_click', { x: action.x, y: action.y, button: action.button ?? 'left' });
        return;
      case 'type':
        await this.call(vm, 'input_type', { text: action.text });
        return;
      case 'key':
        await this.call(vm, 'input_key', { chord: action.chord });
        return;
      case 'drag':
        await this.call(vm, 'input_drag', {
          start_x: action.from.x,
          start_y: action.from.y,
          end_x: action.to.x,
          end_y: action.to.y,
        });
        return;
      case 'gesture':
        throw vmError('CAPABILITY_UNAVAILABLE', 'hyprland adapter: gestures are not supported');
    }
  }

  async listWindows(vm: Vm, filter?: string): Promise<WindowInfo[]> {
    const res = await this.call(vm, 'get_state', {});
    const state = res.result as unknown as {
      windows?: Array<{
        address: string;
        class: string;
        title: string;
        at: [number, number];
        size: [number, number];
        hidden?: boolean;
        minimized?: boolean;
        focused?: boolean;
      }>;
    };
    const q = filter?.toLowerCase();
    return (state.windows ?? [])
      .filter((w) => !q || w.class.toLowerCase().includes(q) || w.title.toLowerCase().includes(q))
      .map((w) => ({
        id: w.address,
        title: w.title,
        className: w.class,
        x: w.at[0] ?? 0,
        y: w.at[1] ?? 0,
        width: w.size[0] ?? 0,
        height: w.size[1] ?? 0,
        focused: w.focused ?? false,
        visible: !w.hidden && !w.minimized,
      }));
  }

  async inspect(vm: Vm): Promise<SemanticElement> {
    const res = await this.call(vm, 'read_text_on_screen', { target: 'screen' });
    const result = res.result as {
      region: { x: number; y: number; w: number; h: number };
      words?: Array<{
        text: string;
        confidence?: number;
        logical: { x: number; y: number; w: number; h: number };
      }>;
    };
    const words = result.words ?? [];
    return {
      role: 'screen',
      name: 'Hyprland desktop (OCR)',
      x: result.region.x,
      y: result.region.y,
      width: result.region.w,
      height: result.region.h,
      children: words.map((word) => ({
        role: 'text',
        name: word.text,
        x: word.logical.x,
        y: word.logical.y,
        width: word.logical.w,
        height: word.logical.h,
        children: [],
        properties: word.confidence !== undefined ? { confidence: String(word.confidence) } : undefined,
      })),
      properties: { semantic: 'wayland-ocr', adapter: 'hyprland' },
    };
  }

  async exec(_vm: Vm, _cmd: string, _args?: string[]): Promise<never> {
    throw vmError('CAPABILITY_UNAVAILABLE', 'hyprland adapter: no exec path (hyprland-mcp has no exec tool)');
  }

  /**
   * Validated escape hatch. Verbs launch/focus/close/paste map to hyprland
   * tools; anything else forwards to hyprctl dispatch as argv — never shell
   * strings (hyprland-mcp validates args server-side too).
   */
  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    switch (verb) {
      case 'launch': {
        const launchArgs: Record<string, unknown> = {
          command: String(args.command),
          args: Array.isArray(args.args) ? args.args.map(String) : [],
          wait_for_window: args.wait_for_window ?? true,
          timeout_ms: args.timeout_ms ?? 10_000,
        };
        if (args.workspace !== undefined) launchArgs.workspace = args.workspace;
        return (await this.call(vm, 'launch', launchArgs)).result;
      }
      case 'focus':
        return (await this.call(vm, 'focus', { window: String(args.window) })).result;
      case 'close':
        return (await this.call(vm, 'close', { window: String(args.window) })).result;
      case 'paste':
        // hyprland-mcp input_paste: wl-copy + Ctrl+V, gated by its config.
        return (await this.call(vm, 'input_paste', { text: String(args.text) })).result;
      default: {
        // Raw hyprctl dispatch. Keys + values flatten to argv (validated, typed).
        const argv = [verb, ...Object.entries(args).flatMap(([k, v]) => [k, String(v)])];
        return (await this.call(vm, 'dispatch', { args: argv })).result;
      }
    }
  }

  /** Call a hyprland tool and normalize every failure to a typed VmError. */
  private async call(vm: Vm, name: string, args: Record<string, unknown>): Promise<{ result: Record<string, unknown>; content: unknown[] }> {
    const conn = await this.ensureConnection(vm);
    const res = await conn.client.callTool({ name, arguments: args });
    const sc = res.structuredContent as
      | { ok?: boolean; error?: { code?: string; message?: string; hint?: string; recoverable?: boolean }; result?: Record<string, unknown> }
      | undefined;
    if (res.isError || sc?.ok === false || sc?.error) {
      throw mapHyprlandError(sc?.error, name);
    }
    return { result: sc?.result ?? {}, content: res.content };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractImage(content: unknown[]): Promise<{ data: Buffer; mime: string }> {
  const img = content.find(
    (c): c is { type: string; data?: string; mimeType?: string } => typeof c === 'object' && c !== null && (c as { type: string }).type === 'image',
  );
  if (img?.data) {
    return Promise.resolve({ data: Buffer.from(img.data, 'base64'), mime: img.mimeType ?? 'image/png' });
  }
  return Promise.reject(vmError('INTERNAL', 'hyprland screenshot returned no image content'));
}

/** Map hyprland-mcp McpError codes onto the shared VmError contract. */
export function mapHyprlandError(e: { code?: string; message?: string; hint?: string; recoverable?: boolean } | undefined, tool: string): VmError {
  const code = e?.code ?? 'UNKNOWN';
  const message = e?.message ?? `hyprland tool "${tool}" failed`;
  switch (code) {
    case 'WINDOW_NOT_FOUND':
    case 'NO_MATCH':
      return vmError('NOT_FOUND', message, `hyprland ${tool}: ${e?.hint ?? ''}`.trim());
    case 'INVALID_ARGUMENTS':
      return vmError('INVALID_REQUEST', message);
    case 'PERMISSION_DENIED':
      return vmError('CAPABILITY_UNAVAILABLE', message);
    case 'MISSING_BINARY':
      return vmError('INTERNAL', message, `hyprland ${tool}: install the missing binary`);
    default:
      return vmError('INTERNAL', message, `hyprland ${tool}: code=${code}${e?.recoverable ? ' (recoverable)' : ''}`);
  }
}

export const hyprlandAdapter = new HyprlandAdapter();
