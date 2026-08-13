/**
 * Shared base for the mock adapters (x11 / windows / macos / android).
 *
 * Mocks drive the E2E demo: every DesktopAdapter method succeeds with fake
 * state — deterministic fake screenshots (real PNG bytes), fake window lists,
 * fake semantic trees — and records every call for auditability. They are
 * honest about being stubs via the template catalog (availability: "stub").
 */
import type {
  Capability,
  CapabilityId,
  DesktopAdapter,
  ExecResult,
  InputAction,
  ScreenshotResult,
  SemanticElement,
  Vm,
  WindowInfo,
} from '../src/shared/types.ts';
import { CAPABILITIES } from '../src/shared/types.ts';
import { vmError } from '../src/mcp/errors.ts';

export interface MockAdapterOptions {
  id: string;
  os: Capability['os'];
  windowing: Capability['windowing'];
  input: Capability['input'];
  semantic: Capability['semantic'];
  files: Capability['files'];
  exec: boolean;
  notes?: string;
  /** Fake screenshot geometry + a per-adapter tint color. */
  screenshot: { width: number; height: number; color: [number, number, number]; orientation?: 'portrait' | 'landscape' };
  windowCount: number;
}

/** Derive the 22-tool-surface capabilities from the Capability declaration. */
export function toolsFromCapability(cap: Capability): CapabilityId[] {
  const tools: CapabilityId[] = [];
  const hasDisplay = cap.windowing.length > 0;
  if (hasDisplay) tools.push(CAPABILITIES.screenshot);
  if (cap.semantic !== 'none') tools.push(CAPABILITIES.inspect);
  if (hasDisplay) tools.push(CAPABILITIES.listWindows);
  for (const m of cap.input) {
    if (m === 'click') tools.push(CAPABILITIES.click);
    if (m === 'type') tools.push(CAPABILITIES.type);
    if (m === 'key') tools.push(CAPABILITIES.key);
    if (m === 'paste') tools.push(CAPABILITIES.paste);
    if (m === 'drag') tools.push(CAPABILITIES.drag);
  }
  if (hasDisplay) {
    tools.push(CAPABILITIES.launch, CAPABILITIES.focus, CAPABILITIES.close, CAPABILITIES.dispatch);
  }
  if (cap.files.length > 0) {
    tools.push(CAPABILITIES.putFile, CAPABILITIES.getFile, CAPABILITIES.cloneRepo);
  }
  return tools;
}

export class MockAdapter implements DesktopAdapter {
  readonly id: string;
  readonly capability: Capability;
  /** Every call recorded — tests and the E2E demo can audit. */
  readonly calls: Array<{ method: string; vm: string; args: unknown }> = [];

  constructor(private readonly opts: MockAdapterOptions) {
    this.id = opts.id;
    this.capability = {
      adapter: opts.id,
      os: opts.os,
      windowing: opts.windowing,
      input: opts.input,
      semantic: opts.semantic,
      files: opts.files,
      exec: opts.exec,
      ...(opts.notes ? { notes: opts.notes } : {}),
    };
  }

  availableTools(): CapabilityId[] {
    return toolsFromCapability(this.capability);
  }

  private record(method: string, vm: Vm, args: unknown): void {
    this.calls.push({ method, vm: vm.uuid, args });
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    this.record('screenshot', vm, {});
    return {
      image: fakePng(this.opts.screenshot.width, this.opts.screenshot.height, this.opts.screenshot.color),
      format: 'png',
      width: this.opts.screenshot.width,
      height: this.opts.screenshot.height,
      ...(this.opts.screenshot.orientation ? { orientation: this.opts.screenshot.orientation } : {}),
      coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    };
  }

  async input(vm: Vm, action: InputAction): Promise<void> {
    this.record('input', vm, action);
  }

  async listWindows(vm: Vm): Promise<WindowInfo[]> {
    this.record('listWindows', vm, {});
    const wins: WindowInfo[] = [];
    for (let i = 0; i < this.opts.windowCount; i++) {
      wins.push({
        id: `${this.id}-win-${i}`,
        title: `${this.opts.os} mock window ${i}`,
        className: `${this.id}.Mock`,
        x: 40 + i * 30,
        y: 40 + i * 20,
        width: 640,
        height: 400,
        focused: i === 0,
        visible: true,
      });
    }
    return wins;
  }

  async inspect(vm: Vm): Promise<SemanticElement> {
    this.record('inspect', vm, {});
    return {
      role: 'root',
      name: `${this.opts.os} mock desktop`,
      x: 0,
      y: 0,
      width: this.opts.screenshot.width,
      height: this.opts.screenshot.height,
      children: [
        {
          role: 'window',
          name: `${this.opts.os} mock window 0`,
          x: 40,
          y: 40,
          width: 640,
          height: 400,
          children: [{ role: 'button', name: 'OK', x: 500, y: 380, width: 80, height: 30, children: [] }],
          properties: { focused: 'true' },
        },
      ],
      properties: { adapter: this.id, mock: 'true' },
    };
  }

  async exec(vm: Vm, cmd: string, args: string[] = []): Promise<ExecResult> {
    this.record('exec', vm, { cmd, args });
    return { exitCode: 0, stdout: `[mock-${this.id}] ${cmd} ${args.join(' ')}`, stderr: '' };
  }

  async putFile(vm: Vm, localPath: string, remotePath: string): Promise<void> {
    this.record('putFile', vm, { localPath, remotePath });
    if (vm.scratchDir) {
      const { mkdir, copyFile } = await import('node:fs/promises');
      const { basename } = await import('node:path');
      await mkdir(vm.scratchDir, { recursive: true });
      await copyFile(localPath, `${vm.scratchDir}/${basename(remotePath)}`);
    }
  }

  async getFile(vm: Vm, remotePath: string, localPath: string): Promise<void> {
    this.record('getFile', vm, { remotePath, localPath });
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, Buffer.from(`mock artifact from ${remotePath}`));
  }

  async cloneRepo(vm: Vm, repoUrl: string, destPath: string): Promise<void> {
    this.record('cloneRepo', vm, { repoUrl, destPath });
  }

  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    this.record('dispatch', vm, { verb, args });
    if (verb === 'paste') return { pasted: true, mode: 'mock' };
    return { verb, args, mock: true };
  }
}

// ---------------------------------------------------------------------------
// Minimal deterministic PNG encoder (stored deflate blocks — no deps)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** zlib stream: header + deflate stored blocks (max 65535 bytes each). */
function zlibStored(data: Uint8Array): Buffer {
  const out: Buffer[] = [Buffer.from([0x78, 0x01])];
  let off = 0;
  for (;;) {
    const remaining = data.length - off;
    const final = remaining <= 65535;
    const len = Math.min(remaining, 65535);
    const block = Buffer.alloc(5 + len);
    block[0] = final ? 1 : 0;
    block.writeUInt16LE(len, 1);
    block.writeUInt16LE(~len & 0xffff, 3);
    block.set(data.subarray(off, off + len), 5);
    out.push(block);
    off += len;
    if (final) break;
  }
  return Buffer.concat(out);
}

/** Solid-color RGB PNG. Deterministic — same input, same bytes. */
export function fakePng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  // rows: filter byte 0 + RGB pixels
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Guard for methods that exist on the interface but not on this adapter. */
export function unsupported(adapterId: string, method: string): never {
  throw vmError('CAPABILITY_UNAVAILABLE', `adapter "${adapterId}": ${method} is not supported`);
}
