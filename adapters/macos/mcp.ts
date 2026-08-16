/**
 * macOS MCP channel — response parsing + error mapping for the in-VM
 * mac-control-mcp server. Mirrors the x11 adapter's defensive parsing:
 * structuredContent first, JSON text content as fallback, typed VmError on
 * every failure. The exact agent payload shape is confirmed by live e2e;
 * every parser degrades honestly instead of guessing.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ScreenshotResult, SemanticElement, Vm, VmError, WindowInfo } from '../../src/shared/types.ts';
import { vmError } from '../../src/mcp/errors.ts';
import { macosSshArgs } from './ssh.ts';

/** In-VM launcher path installed at golden build (runs mac-control-mcp). */
export const IN_VM_LAUNCHER = '/usr/local/bin/launch-macos-mcp';

/** The slice of the MCP client the adapter needs — injectable for tests. */
export interface MacosMcpClient {
  callTool(input: { name: string; arguments: Record<string, unknown> }): Promise<MacosToolResponse>;
}

/** CallToolResult-shaped response (SDK v2): content blocks + optional metadata. */
export interface MacosToolResponse {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** First text content block, if any. */
export function firstMacosText(content: unknown[]): string | undefined {
  const t = content.find(
    (c): c is { type: string; text?: string } =>
      typeof c === 'object' && c !== null && (c as { type: string }).type === 'text',
  );
  return t?.text;
}

/** structuredContent first (Json<T> tools), JSON text content as fallback. */
export function parseMacosPayload(structuredContent: unknown, content: unknown[]): Record<string, unknown> | null {
  if (structuredContent && typeof structuredContent === 'object' && Object.keys(structuredContent as object).length > 0) {
    return structuredContent as Record<string, unknown>;
  }
  const text = firstMacosText(content);
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch { /* not JSON — leave it to the caller */ }
  }
  return null;
}

/** The image content block, base64-decoded. */
export function extractMacosImage(content: unknown[]): { data: Buffer; mime: string } {
  const img = content.find(
    (c): c is { type: string; data?: string; mimeType?: string } =>
      typeof c === 'object' && c !== null && (c as { type: string }).type === 'image',
  );
  if (img?.data) {
    return { data: Buffer.from(img.data, 'base64'), mime: img.mimeType ?? 'image/png' };
  }
  throw vmError('INTERNAL', 'macos screenshot returned no image content');
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : typeof v === 'string' ? (Number(v) || undefined) : undefined;
}

/** Build a ScreenshotResult from a tool payload + content (dims from result/text/PNG header). */
export function parseMacosScreenshot(payload: Record<string, unknown> | null, content: unknown[]): ScreenshotResult {
  const image = extractMacosImage(content);
  const p = payload ?? {};
  const r = (typeof p.result === 'object' && p.result !== null ? p.result : {}) as Record<string, unknown>;
  const width = num(r.width) ?? num(p.width) ?? pngDim(image.data, 16) ?? 0;
  const height = num(r.height) ?? num(p.height) ?? pngDim(image.data, 20) ?? 0;
  const cw = num(r.coordinate_width) ?? width;
  const ch = num(r.coordinate_height) ?? height;
  return {
    image: image.data,
    format: image.mime === 'image/jpeg' ? 'jpg' : 'png',
    width,
    height,
    coordMapping: { scaleX: cw > 0 ? width / cw : 1, scaleY: ch > 0 ? height / ch : 1, offsetX: 0, offsetY: 0 },
  };
}

/** Map a tool response onto the WindowInfo contract (filter by title/class). */
export function parseMacosWindows(payload: Record<string, unknown> | null, filter?: string): WindowInfo[] {
  const r = (payload?.result && typeof payload.result === 'object' ? payload.result : payload ?? {}) as Record<string, unknown>;
  const windows = Array.isArray(r.windows) ? r.windows : [];
  const q = filter?.toLowerCase();
  return windows.flatMap((w): WindowInfo[] => {
    if (typeof w !== 'object' || w === null) return [];
    const win = w as Record<string, unknown>;
    const title = String(win.title ?? win.name ?? '');
    if (q && !title.toLowerCase().includes(q)) return [];
    const frame = (typeof win.frame === 'object' && win.frame !== null ? win.frame : {}) as Record<string, unknown>;
    return [
      {
        id: String(win.id ?? win.ax_id ?? ''),
        title,
        ...(typeof win.className === 'string' && win.className !== '' ? { className: win.className } : {}),
        x: num(frame.x) ?? 0,
        y: num(frame.y) ?? 0,
        width: num(frame.width) ?? 0,
        height: num(frame.height) ?? 0,
        focused: win.focused === true,
        visible: win.visible !== false,
      },
    ];
  });
}

/** Convert a tool response's AX payload into a semantic tree, with a raw fallback. */
export function parseMacosTree(payload: Record<string, unknown> | null, fallback: string): SemanticElement {
  const r = (payload?.result && typeof payload.result === 'object' ? payload.result : payload ?? {}) as Record<string, unknown>;
  const candidate = r.tree ?? r.element_tree;
  const root = candidate ?? (looksLikeAxNode(r) ? r : undefined);
  if (root !== undefined) {
    const converted = convertAxNode(root);
    if (converted) return converted;
  }
  return {
    role: 'screen',
    name: 'macOS desktop (AX)',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    children: [],
    properties: { semantic: 'ax', adapter: 'macos', raw: fallback.slice(0, 2000) },
  };
}

/** A payload is a tree node only when it carries AX-ish fields. */
function looksLikeAxNode(n: Record<string, unknown>): boolean {
  return (
    typeof n.role === 'string' ||
    typeof n.type === 'string' ||
    Array.isArray(n.children) ||
    Array.isArray(n.accessibility_elements) ||
    typeof n.frame === 'object'
  );
}

/** Map an ActionOutput-style ok:false payload onto the shared VmError contract. */
export function mapMacosError(payload: Record<string, unknown>, tool: string): VmError {
  const message = typeof payload.message === 'string' ? payload.message : `macos tool "${tool}" reported failure`;
  const hint = typeof payload.hint === 'string' ? payload.hint : typeof payload.permissions_hint === 'string' ? payload.permissions_hint : undefined;
  if (hint) return vmError('CAPABILITY_UNAVAILABLE', message, hint);
  if (/not found|no window|unknown window|no match/i.test(message)) {
    return vmError('NOT_FOUND', message, `macos ${tool}: target not found`);
  }
  if (typeof payload.code === 'string') {
    return vmError(payload.code === 'INVALID_ARGUMENTS' ? 'INVALID_REQUEST' : 'INTERNAL', message, `macos ${tool}: ${payload.code}`);
  }
  return vmError('INTERNAL', message, `macos ${tool}: ok=false`);
}

/** Recursive tolerant AX-node → SemanticElement converter. */
function convertAxNode(node: unknown): SemanticElement | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as Record<string, unknown>;
  const role = typeof n.role === 'string' ? n.role : typeof n.type === 'string' ? n.type : 'element';
  const name = typeof n.name === 'string' ? n.name : typeof n.title === 'string' ? n.title : typeof n.label === 'string' ? n.label : '';
  const frame = (typeof n.frame === 'object' && n.frame !== null ? n.frame : {}) as Record<string, unknown>;
  const childList = Array.isArray(n.children) ? n.children : Array.isArray(n.accessibility_elements) ? n.accessibility_elements : [];
  const children = childList.map(convertAxNode).filter((c): c is SemanticElement => c !== null);
  const properties: Record<string, string> = {};
  if (n.focused === true) properties.focused = 'true';
  if (typeof n.value === 'string' && n.value !== '') properties.value = n.value;
  return {
    role,
    ...(name !== '' ? { name } : {}),
    x: num(frame.x) ?? 0,
    y: num(frame.y) ?? 0,
    width: num(frame.width) ?? 0,
    height: num(frame.height) ?? 0,
    children,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

/** PNG IHDR width/height (big-endian at offset 16/20) — fallback when no dims. */
function pngDim(buf: Buffer, offset: 16 | 20): number | undefined {
  return buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 ? buf.readUInt32BE(offset) : undefined;
}

/** Production MCP client: SSH through the host into the guest, run the launcher. */
export async function defaultMacosClient(vm: Vm): Promise<MacosMcpClient> {
  if (!vm.ip) throw new Error(`vmhub macos transport: VM ${vm.uuid} has no ip — the static NAT address is unset`);
  const transport = new StdioClientTransport({ command: 'ssh', args: [...macosSshArgs(vm), IN_VM_LAUNCHER] });
  const client = new Client({ name: 'vmhub-mcp-macos', version: '0.1.0' });
  try {
    await client.connect(transport);
  } catch (e) {
    throw vmError(
      'INTERNAL',
      `macos adapter: failed to connect (${e instanceof Error ? e.message : String(e)})`,
      'Ensure the macOS golden is running (launch-macos-mcp) and Remote Login is enabled for the vmhub user.',
    );
  }
  return {
    async callTool(input) {
      const res = await client.callTool({ name: input.name, arguments: input.arguments });
      return { content: res.content, isError: res.isError, structuredContent: res.structuredContent };
    },
  };
}
