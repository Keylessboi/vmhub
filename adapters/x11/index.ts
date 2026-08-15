/**
 * X11 adapter — thin MCP-client wrapper over computer-use-linux running
 * inside the x11-2404 golden VM.
 *
 * Transport (same pattern as the hyprland adapter): each VM gets its own
 * StdioClientTransport that SSHes through the Proxmox host into the VM
 * (ProxyJump) and runs the in-VM launcher /usr/local/bin/launch-x11-mcp,
 * which starts `computer-use-linux mcp` against the autologin Xorg+openbox
 * session. The connection is spawned lazily on first use, so vmhub-mcp
 * starts and serves the catalog even when the VM is down — degradation is a
 * typed VmError, never a crash.
 *
 * Tool mapping (computer-use-linux src/server.rs):
 *   vm_screenshot  → screenshot      vm_click   → click
 *   vm_inspect     → get_app_state   vm_type    → type_text
 *   vm_list_windows→ list_windows    vm_key     → press_key
 *   vm_drag        → drag
 *   focus          → activate_window (dispatch)
 *   doctor         → doctor          (dispatch)
 *   exec/launch    → /usr/local/bin/vmhub-exec over ssh (adapters/x11/exec.ts)
 *   close          → wmctrl -ic/-c over the same ssh exec transport
 *
 * Exec, launch and close are NOT computer-use-linux tools; they run through
 * the golden's in-VM vmhub-exec helper (which wraps commands in the autologin
 * Xorg session env), so wmctrl and GUI launches reach the real desktop.
 *
 * Responses come back as structured content for Json<T> tools and as
 * {image, text-caption} for the screenshot tool; parse defensively so a
 * missing structuredContent field degrades to the text payload, exactly like
 * hyprland's screenshot geometry fallback.
 */
import { Client, type Client as ClientType } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type {
  CapabilityId,
  DesktopAdapter,
  ExecResult,
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
import { makeVmError, vmError } from '../../src/mcp/errors.ts';
import { vmSshMcpTransport } from '../transport.ts';
import { execInVm, x11CloseArgs } from './exec.ts';
export { vmhubExecArgs, x11CloseArgs } from './exec.ts';

/** In-VM launcher path installed at golden build (runs computer-use-linux mcp). */
export const IN_VM_LAUNCHER = '/usr/local/bin/launch-x11-mcp';

/**
 * Session env restored on the remote command line: the golden launcher's SSH
 * context looks like "tty" (no XDG_SESSION_TYPE, no DISPLAY), which makes
 * computer-use-linux skip the X11/EWMH window backend. Prefixing these lets
 * the in-VM MCP server reach the autologin Xorg+openbox session.
 */
export const X11_SESSION_ENV: Record<string, string> = {
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  XAUTHORITY: '/home/vmuser/.Xauthority',
  DISPLAY: ':0',
  XDG_RUNTIME_DIR: '/run/user/1000',
  XDG_SESSION_TYPE: 'x11',
};

/** Capability → computer-use-linux tool mapping (src/server.rs tool names). */
export const X11_TOOL_MAP = {
  screenshot: 'screenshot',
  inspect: 'get_app_state',
  list_windows: 'list_windows',
  click: 'click',
  type: 'type_text',
  key: 'press_key',
  drag: 'drag',
  focus: 'activate_window',
} as const;

interface X11Connection {
  client: ClientType;
  transport: StdioClientTransport;
}

/** A node in computer-use-linux's compact AT-SPI tree (src/atspi_tree.rs). */
interface AtspiNode {
  index: number;
  parent_index?: number | null;
  role?: string;
  name?: string;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  states?: string[];
  text?: { content?: string };
}

interface ScreenshotCaption {
  width?: number;
  height?: number;
  coordinate_width?: number;
  coordinate_height?: number;
}

export class X11Adapter implements DesktopAdapter {
  readonly id = 'x11';
  readonly capability = {
    adapter: 'x11',
    os: 'x11' as const,
    windowing: ['x11'] as WindowingSystem[],
    input: ['click', 'type', 'key', 'drag'] as InputCapability[],
    semantic: 'uia' as const,
    files: [] as FileCapability[],
    exec: true,
    notes: 'X11 desktop VM via computer-use-linux in-VM MCP (launch-x11-mcp); exec via vmhub-exec over ssh.',
  };

  private conns = new Map<string, X11Connection>();

  availableTools(): CapabilityId[] {
    return [
      CAPABILITIES.screenshot,
      CAPABILITIES.inspect,
      CAPABILITIES.listWindows,
      CAPABILITIES.click,
      CAPABILITIES.type,
      CAPABILITIES.key,
      CAPABILITIES.drag,
      CAPABILITIES.focus,
      CAPABILITIES.dispatch,
      CAPABILITIES.exec,
      CAPABILITIES.launch,
      CAPABILITIES.close,
    ];
  }

  /** Per-VM computer-use-linux MCP connection, keyed by uuid. */
  private async ensureConnection(vm: Vm): Promise<X11Connection> {
    const key = vm.uuid;
    const existing = this.conns.get(key);
    if (existing) return existing;

    // The golden launcher leaves the X session vars unset (its SSH context
    // looks like "tty"), which makes computer-use-linux skip the X11/EWMH
    // window backend. Restore them on the remote command line — no golden
    // changes. The transport composes `KEY=value ... launcher`.
    const transport = vmSshMcpTransport(vm, IN_VM_LAUNCHER, process.env, X11_SESSION_ENV);
    const client = new Client({ name: 'vmhub-mcp-x11', version: '0.1.0' });
    try {
      await client.connect(transport);
    } catch (e) {
      throw vmError(
        'INTERNAL',
        `x11 adapter: failed to connect (${e instanceof Error ? e.message : String(e)})`,
        `Could not reach computer-use-linux MCP in VM at ${vm.ip}. Ensure the VM is running and the Xorg+openbox session is up.`,
      );
    }
    const conn = { client, transport };
    this.conns.set(key, conn);
    return conn;
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    const res = await this.call(vm, X11_TOOL_MAP.screenshot, {});
    const image = extractImage(res.content);
    // computer-use-linux puts the caption (width/height/coordinate dims) in a
    // text content block next to the image — same pattern as hyprland.
    let caption: ScreenshotCaption | null = null;
    const text = firstText(res.content);
    if (text) {
      try { caption = JSON.parse(text) as ScreenshotCaption; } catch { /* keep fallback */ }
    }
    const width = caption?.width ?? pngWidth(image.data);
    const height = caption?.height ?? pngHeight(image.data);
    const cw = caption?.coordinate_width ?? width;
    const ch = caption?.coordinate_height ?? height;
    return {
      image: image.data,
      format: image.mime === 'image/jpeg' ? 'jpg' : 'png',
      width,
      height,
      coordMapping: {
        scaleX: cw > 0 ? width / cw : 1,
        scaleY: ch > 0 ? height / ch : 1,
        offsetX: 0,
        offsetY: 0,
      },
    };
  }

  async input(vm: Vm, action: InputAction): Promise<void> {
    switch (action.kind) {
      case 'click':
        await this.call(vm, X11_TOOL_MAP.click, { x: action.x, y: action.y, button: action.button ?? 'left' });
        return;
      case 'type':
        await this.call(vm, X11_TOOL_MAP.type, { text: action.text });
        return;
      case 'key':
        await this.call(vm, X11_TOOL_MAP.key, { key: action.chord });
        return;
      case 'drag':
        await this.call(vm, X11_TOOL_MAP.drag, {
          start_x: action.from.x,
          start_y: action.from.y,
          end_x: action.to.x,
          end_y: action.to.y,
        });
        return;
      case 'gesture':
        throw vmError('CAPABILITY_UNAVAILABLE', 'x11 adapter: gestures are not supported');
    }
  }

  async listWindows(vm: Vm, filter?: string): Promise<WindowInfo[]> {
    const res = await this.call(vm, X11_TOOL_MAP.list_windows, {});
    const out = res.result as {
      windows?: Array<{
        window_id: number;
        title?: string;
        app_id?: string;
        wm_class?: string;
        bounds?: { x?: number; y?: number; width?: number; height?: number };
        focused?: boolean;
        hidden?: boolean;
      }>;
    };
    const q = filter?.toLowerCase();
    return (out.windows ?? [])
      .filter((w) => !q || (w.title ?? '').toLowerCase().includes(q) || (w.wm_class ?? '').toLowerCase().includes(q))
      .map((w) => ({
        id: String(w.window_id),
        title: w.title ?? '',
        className: w.wm_class ?? w.app_id,
        x: w.bounds?.x ?? 0,
        y: w.bounds?.y ?? 0,
        width: w.bounds?.width ?? 0,
        height: w.bounds?.height ?? 0,
        focused: w.focused ?? false,
        visible: !w.hidden,
      }));
  }

  async inspect(vm: Vm): Promise<SemanticElement> {
    const res = await this.call(vm, X11_TOOL_MAP.inspect, {});
    const out = res.result as {
      screenshot?: { coordinate_width?: number; coordinate_height?: number };
      accessibility_tree?: AtspiNode[];
      accessibility_error?: string;
    };
    if (typeof out.accessibility_error === 'string' && out.accessibility_error.length > 0) {
      throw vmError('CAPABILITY_UNAVAILABLE', out.accessibility_error, 'Enable AT-SPI accessibility in the VM desktop session.');
    }
    const width = out.screenshot?.coordinate_width ?? 0;
    const height = out.screenshot?.coordinate_height ?? 0;
    return {
      role: 'screen',
      name: 'X11 desktop (AT-SPI accessibility tree)',
      x: 0,
      y: 0,
      width,
      height,
      children: buildAtspiTree(out.accessibility_tree ?? []),
      properties: {
        semantic: 'uia-atspi',
        adapter: 'x11',
      },
    };
  }

  async exec(vm: Vm, cmd: string, args: string[] = []): Promise<ExecResult> {
    return execInVm(vm, cmd, args);
  }

  /** Validated escape hatch. focus → activate_window, paste → type_text; the rest are honest gaps. */
  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    switch (verb) {
      case 'focus': {
        const window = String(args.window);
        const selector: Record<string, unknown> = {};
        if (/^\d+$/.test(window)) selector.window_id = Number(window);
        else selector.title = window;
        return (await this.call(vm, X11_TOOL_MAP.focus, selector)).result;
      }
      case 'paste':
        // computer-use-linux has no clipboard tool; type_text is the closest.
        return (await this.call(vm, X11_TOOL_MAP.type, { text: String(args.text) })).result;
      case 'doctor': {
        const res = await this.call(vm, 'doctor', {});
        // The doctor tool wraps its payload in a nested `result` envelope.
        return 'result' in res.result ? res.result.result : res.result;
      }
      case 'exec': {
        const { cmd, args: cmdArgs = [] } = args as { cmd: string; args?: string[] };
        return this.exec(vm, cmd, cmdArgs);
      }
      case 'launch': {
        const { command, args: cmdArgs = [] } = args as { command: string; args?: string[] };
        return this.exec(vm, command, cmdArgs);
      }
      case 'close': {
        const window = String(args.window);
        return this.exec(vm, 'wmctrl', x11CloseArgs(window));
      }
      default:
        throw vmError('CAPABILITY_UNAVAILABLE', `x11 adapter: unknown dispatch verb "${verb}"`);
    }
  }

  /** Call a computer-use-linux tool and normalize failures to a typed VmError. */
  private async call(vm: Vm, name: string, args: Record<string, unknown>): Promise<{ result: Record<string, unknown>; content: unknown[] }> {
    const conn = await this.ensureConnection(vm);
    const res = await conn.client.callTool({ name, arguments: args });
    const payload = parsePayload(res.structuredContent, res.content);
    if (res.isError) {
      const text = firstText(res.content);
      throw vmError('INTERNAL', `x11 tool "${name}" failed: ${text ?? 'unknown error'}`);
    }
    // Action-style tools report failure in `ok`; informational `error` fields
    // (e.g. list_windows noting an unreachable X server) are surfaced too —
    // dropping them would turn a real failure into an empty successful result.
    if (payload && payload.ok === false) {
      throw mapX11ActionError(payload, name);
    }
    if (payload && payload.error !== undefined && payload.error !== null) {
      const hint = typeof payload.permissions_hint === 'string' ? payload.permissions_hint : undefined;
      const message = payloadErrorMessage(payload.error);
      if (hint) {
        // permissions_hint is free-form operator guidance; carry it as the
        // VmError hint so agents can surface it verbatim.
        throw makeVmError('CAPABILITY_UNAVAILABLE', message, { hint: hint as VmError['hint'] });
      }
      throw vmError('INTERNAL', message);
    }
    return { result: payload ?? {}, content: res.content };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function firstText(content: unknown[]): string | undefined {
  const t = content.find(
    (c): c is { type: string; text?: string } =>
      typeof c === 'object' && c !== null && (c as { type: string }).type === 'text',
  );
  return t?.text;
}

/** structuredContent first (rmcp Json<T> tools), JSON text content as fallback. */
function parsePayload(structuredContent: unknown, content: unknown[]): Record<string, unknown> | null {
  if (structuredContent && typeof structuredContent === 'object' && Object.keys(structuredContent as object).length > 0) {
    return structuredContent as Record<string, unknown>;
  }
  const text = firstText(content);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* not JSON — leave it to the caller */ }
  }
  return null;
}

function extractImage(content: unknown[]): { data: Buffer; mime: string } {
  const img = content.find(
    (c): c is { type: string; data?: string; mimeType?: string } => typeof c === 'object' && c !== null && (c as { type: string }).type === 'image',
  );
  if (img?.data) {
    return { data: Buffer.from(img.data, 'base64'), mime: img.mimeType ?? 'image/png' };
  }
  throw vmError('INTERNAL', 'x11 screenshot returned no image content');
}

/** Map an ActionOutput-style payload (ok:false) onto the shared VmError contract. */
function mapX11ActionError(payload: Record<string, unknown>, tool: string): VmError {
  const message = typeof payload.message === 'string' ? payload.message : `x11 tool "${tool}" reported failure`;
  const hint = typeof payload.permissions_hint === 'string' ? payload.permissions_hint : undefined;
  const lowered = message.toLowerCase();
  if (hint) {
    return vmError('CAPABILITY_UNAVAILABLE', message, hint);
  }
  if (/not found|no window|unknown window|no match/i.test(lowered)) {
    return vmError('NOT_FOUND', message, `x11 ${tool}: target not found`);
  }
  return vmError('INTERNAL', message, `x11 ${tool}: ok=false`);
}

/** Extract the human-readable message from a payload `error` field (string or {message}). */
function payloadErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.length > 0) return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  return 'x11 tool failed';
}

/** Nest the flat AT-SPI node list (parent_index links) into a semantic tree. */
function buildAtspiTree(nodes: AtspiNode[]): SemanticElement[] {
  const childrenOf = new Map<number, AtspiNode[]>();
  for (const n of nodes) {
    if (n.parent_index === undefined || n.parent_index === null) continue;
    const list = childrenOf.get(n.parent_index) ?? [];
    list.push(n);
    childrenOf.set(n.parent_index, list);
  }
  const convert = (n: AtspiNode): SemanticElement => ({
    role: n.role ?? 'element',
    name: n.name ?? n.text?.content ?? '',
    x: n.bounds?.x ?? 0,
    y: n.bounds?.y ?? 0,
    width: n.bounds?.width ?? 0,
    height: n.bounds?.height ?? 0,
    children: (childrenOf.get(n.index) ?? []).map(convert),
    ...(n.states && n.states.length > 0 ? { properties: { states: n.states.join(',') } } : {}),
  });
  const roots = nodes.filter((n) => n.parent_index === undefined || n.parent_index === null);
  // No explicit roots (server-compacted tree): surface every node flat.
  if (roots.length === 0) {
    return nodes.map((n) => ({
      role: n.role ?? 'element',
      name: n.name ?? n.text?.content ?? '',
      x: n.bounds?.x ?? 0,
      y: n.bounds?.y ?? 0,
      width: n.bounds?.width ?? 0,
      height: n.bounds?.height ?? 0,
      children: [],
    }));
  }
  return roots.map(convert);
}

/** PNG IHDR width (big-endian at offset 16) — fallback when no caption. */
function pngWidth(buf: Buffer): number {
  return buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? buf.readUInt32BE(16) : 0;
}

/** PNG IHDR height (big-endian at offset 20) — fallback when no caption. */
function pngHeight(buf: Buffer): number {
  return buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? buf.readUInt32BE(20) : 0;
}

export const x11Adapter = new X11Adapter();
