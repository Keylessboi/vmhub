/**
 * Windows adapter — real driver for the in-VM CursorTouch (Windows-MCP) server.
 *
 * CursorTouch exposes MCP over streamable-http at `http://<vm-ip>:8000/mcp/`
 * with an auth key (Bearer). The golden runs it bound to 0.0.0.0:8000, so the
 * control plane reaches the VM directly over the vmbr1 NAT network.
 *
 * Tool mapping (CursorTouch surface -> vm_* contract):
 *   screenshot -> Screenshot, click -> Click, type -> Type,
 *   key -> Shortcut, drag -> Move(drag), list_windows -> Snapshot/App,
 *   inspect -> Snapshot (UIA tree), launch/focus/close -> App.
 */
import type {
  CapabilityId,
  DesktopAdapter,
  FileCapability,
  InputAction,
  InputCapability,
  ScreenshotResult,
  SemanticElement,
  Vm,
  WindowInfo,
  WindowingSystem,
} from '../../src/shared/types.ts';
import { CAPABILITIES } from '../../src/shared/types.ts';
import { vmError } from '../../src/mcp/errors.ts';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

/** Default CursorTouch endpoint — override with CURSORTOUCH_PORT. */
export const CURSORTOUCH_PORT = 8000;

/** Auth key for the CursorTouch server (set at golden build). */
export function cursorTouchAuthKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.CURSORTOUCH_AUTH_KEY ?? '';
}

interface WindowsConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

export class WindowsAdapter implements DesktopAdapter {
  readonly id = 'windows';
  readonly capability = {
    adapter: 'windows',
    os: 'windows' as const,
    windowing: ['windows'] as WindowingSystem[],
    input: ['click', 'type', 'key', 'paste', 'drag'] as InputCapability[],
    semantic: 'uia' as const,
    files: [] as FileCapability[],
    exec: false,
    notes: 'Real Windows golden via in-VM CursorTouch (Windows-MCP) server.',
  };

  private conns = new Map<string, WindowsConnection>();

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
    ];
  }

  private async ensureConnection(vm: Vm): Promise<WindowsConnection> {
    const existing = this.conns.get(vm.uuid);
    if (existing) return existing;

    if (!vm.ip) {
      throw vmError('INTERNAL', 'windows adapter: VM has no IP (not leased?)', 'Lease the VM first');
    }
    const port = process.env.CURSORTOUCH_PORT ?? String(CURSORTOUCH_PORT);
    const url = `http://${vm.ip}:${port}/mcp/`;
    const authKey = cursorTouchAuthKey();
    if (!authKey) {
      throw vmError('INTERNAL', 'windows adapter: CURSORTOUCH_AUTH_KEY not set', 'Set it via Doppler/environment');
    }

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: { Authorization: `Bearer ${authKey}` },
      },
    });
    const client = new Client({ name: 'vmhub-mcp-windows', version: '0.1.0' });
    try {
      await client.connect(transport);
    } catch (e) {
      throw vmError(
        'INTERNAL',
        `windows adapter: failed to connect to CursorTouch at ${url} (${e instanceof Error ? e.message : String(e)})`,
        'Ensure the Windows golden is running CursorTouch on 0.0.0.0:8000 and the auth key matches.',
      );
    }
    const conn = { client, transport };
    this.conns.set(vm.uuid, conn);
    return conn;
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    const conn = await this.ensureConnection(vm);
    const res = await conn.client.callTool({ name: 'Screenshot', arguments: {} });
    const image = extractImage(res.content);
    return {
      image: image.data,
      format: 'png',
      width: 0,
      height: 0,
      coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    };
  }

  async input(vm: Vm, action: InputAction): Promise<void> {
    const conn = await this.ensureConnection(vm);
    switch (action.kind) {
      case 'click':
        await conn.client.callTool({ name: 'Click', arguments: { x: action.x, y: action.y } });
        return;
      case 'type':
        await conn.client.callTool({ name: 'Type', arguments: { text: action.text } });
        return;
      case 'key':
        await conn.client.callTool({ name: 'Shortcut', arguments: { keys: action.chord } });
        return;
      case 'drag':
        await conn.client.callTool({
          name: 'Move',
          arguments: { start_x: action.from.x, start_y: action.from.y, end_x: action.to.x, end_y: action.to.y, drag: true },
        });
        return;
      case 'paste':
        await conn.client.callTool({ name: 'Clipboard', arguments: { text: action.text } });
        return;
      case 'gesture':
        throw vmError('CAPABILITY_UNAVAILABLE', 'windows adapter: gestures not supported');
    }
  }

  async listWindows(vm: Vm, filter?: string): Promise<WindowInfo[]> {
    const conn = await this.ensureConnection(vm);
    const res = await conn.client.callTool({ name: 'Snapshot', arguments: {} });
    // CursorTouch Snapshot returns a UIA tree; extract top-level windows.
    const text = textContent(res.content);
    const windows: WindowInfo[] = [];
    if (text) {
      const lines = text.split('\n').filter((l) => l.trim() && !l.includes('Window') && !l.includes('Root'));
      const q = filter?.toLowerCase();
      for (const line of lines.slice(0, 10)) {
        if (q && !line.toLowerCase().includes(q)) continue;
        windows.push({ id: line.trim(), title: line.trim(), className: '', x: 0, y: 0, width: 0, height: 0, focused: false, visible: true });
      }
    }
    return windows;
  }

  async inspect(vm: Vm): Promise<SemanticElement> {
    const conn = await this.ensureConnection(vm);
    const res = await conn.client.callTool({ name: 'Snapshot', arguments: {} });
    const text = textContent(res.content);
    return {
      role: 'window',
      name: 'Windows desktop (UIA)',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: [],
      properties: { semantic: 'uia', adapter: 'windows', raw: text?.slice(0, 2000) ?? '' },
    };
  }

  async exec(): Promise<never> {
    throw vmError('CAPABILITY_UNAVAILABLE', 'windows adapter: no exec path (use PowerShell tool via dispatch)');
  }

  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = await this.ensureConnection(vm);
    const tool = verb === 'launch' ? 'App' : verb === 'focus' ? 'App' : verb === 'close' ? 'App' : verb;
    const res = await conn.client.callTool({ name: tool, arguments: args });
    return res.content;
  }
}

function extractImage(content: unknown[]): { data: Buffer; mime: string } {
  const img = content.find(
    (c): c is { type: string; data?: string; mimeType?: string } => typeof c === 'object' && c !== null && (c as { type: string }).type === 'image',
  );
  if (img?.data) {
    return { data: Buffer.from(img.data, 'base64'), mime: img.mimeType ?? 'image/png' };
  }
  throw vmError('INTERNAL', 'windows screenshot returned no image content');
}

/** Pull the text from an MCP text content block, if present. */
function textContent(content: unknown[]): string | undefined {
  const block = content.find(
    (c): c is { type: 'text'; text: string } => typeof c === 'object' && c !== null && (c as { type: string }).type === 'text' && typeof (c as { text?: unknown }).text === 'string',
  );
  return block?.text;
}

export const windowsAdapter = new WindowsAdapter();
