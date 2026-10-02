/**
 * Screen recording of the VMs an agent is driving.
 *
 * While a recording runs, one sampler per VM pulls frames through the VM's
 * adapter (the same screenshot path vm_screenshot uses, so it works on every
 * desktop template) and keeps only frames that changed. Every vm_* tool call
 * the agent makes is logged on the same clock. stop() renders it all with
 * ffmpeg: the VMs tiled on one canvas, each labelled, with a caption for each
 * action and a ripple where the agent clicked.
 *
 * "The VMs the agent is driving" are the ones this server process has seen a
 * successful tool call or a ready lease for. With no explicit vm_ids a
 * recording follows them: a VM leased mid-recording joins the canvas from the
 * moment it is first touched.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DesktopAdapter, ScreenshotResult, Vm } from '../shared/types.ts';
import { CAPABILITIES } from '../shared/types.ts';
import { isVmError, vmError } from './errors.ts';

export const DEFAULT_RECORD_FPS = 2;
export const DEFAULT_RECORD_MAX_MS = 30 * 60 * 1000;
export const DEFAULT_RECORD_MAX_BYTES = 1024 * 1024 * 1024;
/** Output frame rate. Sources are a few fps; this only smooths the overlay animations. */
const OUT_FPS = 15;
const BG = '0x0b0d12';
const TILE_BG = '0x161a22';

export function recordingDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_RECORDING_DIR ?? join(homedir(), 'Videos', 'vmhub');
}

// ── geometry ────────────────────────────────────────────────────────────────

/** Native pixel size of PNG/JPEG bytes, or null when the header is unreadable. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      // SOF0..SOF15 carry the frame size; C4/C8/CC are not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

export interface Rect { x: number; y: number; w: number; h: number }

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * Tile n screens on a width×height canvas under a header bar. Columns are
 * chosen for the 16:9-ish screens VMs have; a short last row is centred.
 */
export function computeLayout(n: number, width: number, height: number, header = 56, gutter = 16): Rect[] {
  if (n <= 0) return [];
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  const rows = Math.ceil(n / cols);
  const tw = even((width - gutter * (cols + 1)) / cols);
  const th = even((height - header - gutter * (rows + 1)) / rows);
  const tiles: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const rowWidth = inRow * tw + (inRow - 1) * gutter;
    const x0 = Math.floor((width - rowWidth) / 2);
    tiles.push({ x: even(x0 + (i % cols) * (tw + gutter)), y: even(header + gutter + row * (th + gutter)), w: tw, h: th });
  }
  return tiles;
}

/** Where a frame of imgW×imgH lands inside a tile (scaled to fit, centred). */
export function fitInTile(tile: Rect, imgW: number, imgH: number): Rect {
  const s = Math.min(tile.w / imgW, tile.h / imgH);
  const w = imgW * s;
  const h = imgH * s;
  return { x: tile.x + (tile.w - w) / 2, y: tile.y + (tile.h - h) / 2, w, h };
}

// ── timeline ────────────────────────────────────────────────────────────────

export interface Frame {
  /** ms since the recording started. */
  t: number;
  file: string;
  /** Native image size. */
  width: number;
  height: number;
  /** Logical screen size the adapter reported, and its logical→image mapping. */
  logicalWidth: number;
  logicalHeight: number;
  mapping: ScreenshotResult['coordMapping'];
}

export interface ActionEvent {
  t: number;
  vmUuid: string;
  tool: string;
  caption: string;
  /** Logical screen points to mark (a click, or a drag's two ends). */
  points?: Array<{ x: number; y: number }>;
  ok: boolean;
}

/** Calls that only look at the VM: not worth a caption. */
const QUIET_TOOLS = new Set(['vm_screenshot', 'vm_inspect', 'vm_list_windows', 'vm_capabilities', 'vm_record', 'vm_lease_status', 'vm_health', 'vm_list_vms', 'vm_list_templates']);

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** A one-line description of a tool call for the video, or null to stay quiet. */
export function describeAction(tool: string, args: Record<string, unknown>): Pick<ActionEvent, 'caption' | 'points'> | null {
  if (QUIET_TOOLS.has(tool)) return null;
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  const n = (k: string) => (typeof args[k] === 'number' ? (args[k] as number) : NaN);
  switch (tool) {
    case 'vm_click': {
      const button = s('button') && s('button') !== 'left' ? `${s('button')} ` : '';
      return { caption: `${button}click  ${Math.round(n('x'))}, ${Math.round(n('y'))}`, points: [{ x: n('x'), y: n('y') }] };
    }
    case 'vm_drag':
      return {
        caption: `drag  ${Math.round(n('from_x'))},${Math.round(n('from_y'))} → ${Math.round(n('to_x'))},${Math.round(n('to_y'))}`,
        points: [{ x: n('from_x'), y: n('from_y') }, { x: n('to_x'), y: n('to_y') }],
      };
    case 'vm_type': return { caption: `type  “${clip(s('text'), 48)}”` };
    case 'vm_paste': return { caption: `paste  “${clip(s('text'), 48)}”` };
    case 'vm_key': return { caption: `key  ${s('chord')}` };
    case 'vm_exec': return { caption: `$ ${clip(s('command'), 60)}` };
    case 'vm_launch': {
      const argv = Array.isArray(args.args) ? (args.args as unknown[]).map(String).join(' ') : '';
      return { caption: `launch  ${clip(`${s('command')} ${argv}`, 56)}` };
    }
    case 'vm_focus': return { caption: `focus  ${clip(s('target') || s('window') || s('selector') || '', 48)}` };
    case 'vm_close': return { caption: `close  ${clip(s('target') || s('window') || s('selector') || '', 48)}` };
    case 'vm_dispatch': return { caption: `dispatch  ${clip(`${s('dispatcher')} ${s('args') || s('arg')}`, 52)}` };
    case 'vm_put_file': return { caption: `upload  ${clip(s('remote_path'), 52)}` };
    case 'vm_get_file': return { caption: `download  ${clip(s('remote_path'), 52)}` };
    case 'vm_clone_repo': return { caption: `git clone  ${clip(s('repo_url'), 52)}` };
    case 'vm_snapshot': return { caption: `snapshot ${s('action')}  ${s('name')}`.trim() };
    case 'vm_network': return { caption: s('mode') ? `network → ${s('mode')}` : 'network?' };
    case 'vm_capture': return { caption: `packet capture ${s('action')}` };
    case 'vm_lease_create': return { caption: `lease ${s('template_id')}` };
    case 'vm_lease_release': return { caption: 'release' };
    default: return { caption: tool.replace(/^vm_/, '') };
  }
}

// ── ASS overlay ─────────────────────────────────────────────────────────────

/** ASS timestamp H:MM:SS.cc */
export function assTime(ms: number): string {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Text that cannot open an override block or a line break. */
export function assText(s: string): string {
  return s.replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')).replace(/\\/g, '/').replace(/\r?\n/g, ' ');
}

function circlePath(r: number): string {
  const k = Math.round(r * 0.5523);
  return `m 0 ${-r} b ${k} ${-r} ${r} ${-k} ${r} 0 b ${r} ${k} ${k} ${r} 0 ${r} b ${-k} ${r} ${-r} ${k} ${-r} 0 b ${-r} ${-k} ${-k} ${-r} 0 ${-r}`;
}

const mmss = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export interface OverlaySource {
  uuid: string;
  label: string;
  sublabel: string;
  tile: Rect;
  frames: Frame[];
  /** First frame time, or the end when there are none. */
  joinedAt: number;
  note?: string;
}

/** Where a logical point lands on the canvas, using the frame on screen at time t. */
export function canvasPoint(src: OverlaySource, t: number, x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let frame: Frame | undefined;
  for (const f of src.frames) { if (f.t <= t) frame = f; else break; }
  frame ??= src.frames[0];
  if (!frame) return null;
  const m = frame.mapping;
  const toNative = frame.logicalWidth > 0 ? frame.width / frame.logicalWidth : 1;
  const toNativeY = frame.logicalHeight > 0 ? frame.height / frame.logicalHeight : 1;
  const ix = (x - m.offsetX) * m.scaleX * toNative;
  const iy = (y - m.offsetY) * m.scaleY * toNativeY;
  const box = fitInTile(src.tile, frame.width, frame.height);
  return { x: Math.round(box.x + ix * (box.w / frame.width)), y: Math.round(box.y + iy * (box.h / frame.height)) };
}

export function buildOverlay(opts: {
  width: number; height: number; durationMs: number; title: string; font: string;
  sources: OverlaySource[]; events: ActionEvent[];
}): string {
  const { width, height, durationMs, title, font, sources, events } = opts;
  const small = Math.max(14, Math.round(height / 60));
  const lines: string[] = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Colours are &HAABBGGRR.
    `Style: Title,${font},${Math.round(small * 1.35)},&H00F2EEE8,&H00F2EEE8,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,0,0,4,24,24,0,1`,
    `Style: Rec,${font},${small},&H00F2EEE8,&H00F2EEE8,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,6,24,24,0,1`,
    `Style: Label,${font},${small},&H00F2EEE8,&H00F2EEE8,&H40221A16,&H40221A16,1,0,0,0,100,100,0,0,3,6,0,7,0,0,0,1`,
    `Style: Sub,${font},${Math.round(small * 0.85)},&H00B4A89C,&H00B4A89C,&H40221A16,&H40221A16,0,0,0,0,100,100,0,0,3,6,0,7,0,0,0,1`,
    `Style: Caption,${font},${Math.round(small * 1.1)},&H00FFFFFF,&H00FFFFFF,&H30E8813A,&H30E8813A,1,0,0,0,100,100,0,0,3,10,0,2,0,0,0,1`,
    `Style: Note,${font},${small},&H00B4A89C,&H00B4A89C,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`,
    `Style: Mark,${font},10,&HFF000000,&HFF000000,&H003A81E8,&H00000000,0,0,0,0,100,100,0,0,1,4,0,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ev = (layer: number, a: number, b: number, style: string, text: string) =>
    lines.push(`Dialogue: ${layer},${assTime(a)},${assTime(b)},${style},,0,0,0,,${text}`);
  const end = durationMs;

  ev(0, 0, end, 'Title', `{\\pos(24,${Math.round(56 / 2)})}${assText(title)}`);
  // A blinking REC dot and the elapsed time, one event per second.
  for (let s = 0; s * 1000 < end; s++) {
    const a = s * 1000;
    const b = Math.min(end, a + 1000);
    const dot = s % 2 === 0 ? '{\\c&H3A3AE8&}●{\\c&HF2EEE8&}' : '{\\alpha&HFF&}●{\\alpha&H00&}';
    ev(0, a, b, 'Rec', `{\\pos(${width - 24},28)}${dot} REC  ${mmss(a)}`);
  }

  for (const src of sources) {
    const t = src.tile;
    ev(2, 0, end, 'Label', `{\\pos(${t.x + 12},${t.y + 12})}${assText(src.label)}`);
    ev(2, 0, end, 'Sub', `{\\pos(${t.x + 12},${t.y + 12 + Math.round(small * 1.9)})}${assText(src.sublabel)}`);
    if (src.joinedAt > 0) {
      const msg = src.frames.length ? 'waiting for the first frame…' : (src.note ?? 'no frames captured');
      ev(1, 0, src.joinedAt, 'Note', `{\\pos(${t.x + t.w / 2},${t.y + t.h / 2})}${assText(msg)}`);
    }
  }

  const byVm = new Map<string, ActionEvent[]>();
  for (const e of events) byVm.set(e.vmUuid, [...(byVm.get(e.vmUuid) ?? []), e]);
  for (const src of sources) {
    const list = (byVm.get(src.uuid) ?? []).sort((a, b) => a.t - b.t);
    const t = src.tile;
    list.forEach((e, i) => {
      const a = Math.max(0, e.t);
      if (a >= end) return;
      const next = list[i + 1]?.t ?? Infinity;
      const b = Math.min(end, a + 3500, Math.max(a + 900, next));
      const text = e.ok ? e.caption : `${e.caption}  (failed)`;
      ev(3, a, b, 'Caption', `{\\pos(${Math.round(t.x + t.w / 2)},${t.y + t.h - 18})\\fad(120,200)}${assText(text)}`);
      for (const p of e.points ?? []) {
        const at = canvasPoint(src, a, p.x, p.y);
        if (!at) continue;
        const r = Math.max(10, Math.round(t.h / 40));
        ev(4, a, Math.min(end, a + 700), 'Mark', `{\\an5\\pos(${at.x},${at.y})\\fscx60\\fscy60\\t(0,700,\\fscx260\\fscy260\\alpha&HFF&)\\p1}${circlePath(r)}`);
        ev(4, a, Math.min(end, a + 900), 'Mark', `{\\an5\\pos(${at.x},${at.y})\\bord0\\1c&H3A81E8&\\1a&H20&\\fad(0,300)\\p1}${circlePath(Math.round(r / 3))}`);
      }
    });
  }
  return `${lines.join('\n')}\n`;
}

// ── ffmpeg ──────────────────────────────────────────────────────────────────

export function ffmpegBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_FFMPEG ?? 'ffmpeg';
}

/** concat-demuxer playlist: each frame holds until the next one (the last until `endMs`). */
export function concatList(frames: Frame[], endMs: number): string {
  const out = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const until = frames[i + 1]?.t ?? endMs;
    out.push(`file '${f.file}'`, `duration ${(Math.max(until - f.t, 40) / 1000).toFixed(3)}`);
  });
  // The demuxer ignores the last entry's duration unless the file repeats.
  const last = frames.at(-1);
  if (last) out.push(`file '${last.file}'`);
  return `${out.join('\n')}\n`;
}

/** The -filter_complex graph: background, tile panels, each source overlaid on its tile, then the overlay. */
export function filterGraph(opts: { width: number; height: number; durationMs: number; tiles: Rect[]; inputs: Array<{ tile: Rect; offsetMs: number }>; overlayFile: string }): string {
  const { width, height, durationMs, tiles, inputs, overlayFile } = opts;
  const d = (durationMs / 1000).toFixed(3);
  const parts: string[] = [];
  const panels = tiles.map((t) => `drawbox=x=${t.x}:y=${t.y}:w=${t.w}:h=${t.h}:color=${TILE_BG}:t=fill`).join(',');
  parts.push(`color=c=${BG}:s=${width}x${height}:r=${OUT_FPS}:d=${d}${panels ? `,${panels}` : ''}[bg]`);
  inputs.forEach(({ tile, offsetMs }, i) => {
    parts.push(
      `[${i}:v]setpts=PTS-STARTPTS+${(offsetMs / 1000).toFixed(3)}/TB,` +
        `scale=w=${tile.w}:h=${tile.h}:force_original_aspect_ratio=decrease:eval=frame:flags=lanczos,setsar=1,format=yuv420p[s${i}]`,
    );
  });
  let prev = 'bg';
  inputs.forEach(({ tile }, i) => {
    const out = `o${i}`;
    parts.push(`[${prev}][s${i}]overlay=x='${tile.x}+(${tile.w}-overlay_w)/2':y='${tile.y}+(${tile.h}-overlay_h)/2':eval=frame:eof_action=repeat[${out}]`);
    prev = out;
  });
  parts.push(`[${prev}]ass=${overlayFile},format=yuv420p[out]`);
  return parts.join(';');
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-6000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim().split('\n').slice(-6).join(' | ')}`));
    });
  });
}

export interface RenderedVideo {
  file: string;
  poster?: string;
  gif?: string;
  bytes: number;
  durationS: number;
  width: number;
  height: number;
}

export async function renderVideo(opts: {
  workDir: string; outFile: string; durationMs: number; width: number; height: number;
  title: string; sources: Array<Omit<OverlaySource, 'tile' | 'joinedAt'>>; events: ActionEvent[];
  gif?: boolean; env?: NodeJS.ProcessEnv;
}): Promise<RenderedVideo> {
  const env = opts.env ?? process.env;
  const bin = ffmpegBin(env);
  const durationMs = Math.max(opts.durationMs, 500);
  const tiles = computeLayout(Math.max(opts.sources.length, 1), opts.width, opts.height);
  const sources: OverlaySource[] = opts.sources.map((s, i) => ({ ...s, tile: tiles[i]!, joinedAt: s.frames[0]?.t ?? durationMs }));
  const overlayFile = 'overlay.ass';
  writeFileSync(join(opts.workDir, overlayFile), buildOverlay({
    width: opts.width, height: opts.height, durationMs, title: opts.title,
    font: env.VMHUB_RECORD_FONT ?? 'DejaVu Sans', sources, events: opts.events,
  }));
  const inputs: Array<{ tile: Rect; offsetMs: number }> = [];
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  sources.forEach((s, i) => {
    if (!s.frames.length) return;
    const list = `v${i}.ffconcat`;
    writeFileSync(join(opts.workDir, list), concatList(s.frames, durationMs));
    args.push('-f', 'concat', '-safe', '0', '-i', list);
    inputs.push({ tile: s.tile, offsetMs: s.frames[0]!.t });
  });
  args.push(
    '-filter_complex', filterGraph({ width: opts.width, height: opts.height, durationMs, tiles, inputs, overlayFile }),
    '-map', '[out]', '-t', (durationMs / 1000).toFixed(3), '-r', String(OUT_FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    opts.outFile,
  );
  const budget = 120_000 + durationMs * 2;
  try {
    await run(bin, args, opts.workDir, budget);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw vmError('CAPABILITY_UNAVAILABLE', `ffmpeg not found ("${bin}") — the frames are kept in ${opts.workDir}`, 'Install ffmpeg (with libx264 and libass) or set VMHUB_FFMPEG.');
    }
    throw vmError('INTERNAL', `rendering failed: ${(e as Error).message}`, `frames and the ffmpeg inputs are kept in ${opts.workDir}`);
  }

  // A contact sheet the agent can look at without playing the video.
  const poster = opts.outFile.replace(/\.mp4$/, '.jpg');
  const shots = 6;
  try {
    await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', opts.outFile, '-vf',
      `fps=${shots}/${Math.max(durationMs / 1000, 1).toFixed(3)},scale=640:-2,tile=3x2:padding=6:margin=6:color=${BG}`,
      '-frames:v', '1', '-q:v', '4', poster], opts.workDir, 60_000);
  } catch { /* the video is what matters */ }

  let gif: string | undefined;
  if (opts.gif) {
    gif = opts.outFile.replace(/\.mp4$/, '.gif');
    await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', opts.outFile, '-filter_complex',
      'fps=8,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      gif], opts.workDir, budget).catch((e: Error) => { throw vmError('INTERNAL', `gif conversion failed: ${e.message}`); });
  }
  return {
    file: opts.outFile,
    poster: exists(poster) ? poster : undefined,
    gif,
    bytes: statSync(opts.outFile).size,
    durationS: Math.round(durationMs / 100) / 10,
    width: opts.width,
    height: opts.height,
  };
}

function exists(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

// ── the recorder ────────────────────────────────────────────────────────────

export interface RecorderDeps {
  getVm(uuid: string): Promise<Vm>;
  listVms(): Promise<Vm[]>;
  adapterOf(vm: Vm): DesktopAdapter | undefined;
}

interface Source {
  vm: Vm;
  adapter: DesktopAdapter;
  label: string;
  sublabel: string;
  dir: string;
  frames: Frame[];
  lastHash?: string;
  errors: number;
  lastError?: string;
  stopped: boolean;
  loop?: Promise<void>;
}

interface Session {
  id: string;
  startedAt: number;
  workDir: string;
  intervalMs: number;
  maxBytes: number;
  bytes: number;
  follow: boolean;
  title?: string;
  sources: Map<string, Source>;
  events: ActionEvent[];
  timer: NodeJS.Timeout;
  stopReason?: string;
  sampling: boolean;
}

export interface RecordStartOptions {
  vmIds?: string[];
  fps?: number;
  maxMs?: number;
  maxBytes?: number;
  title?: string;
}

export interface RecordingStatus {
  active: boolean;
  recording_id?: string;
  elapsed_s?: number;
  follow?: boolean;
  vms?: Array<{ vm_id: string; label: string; frames: number; errors: number; last_error?: string; sampling: boolean }>;
  actions?: number;
  stop_reason?: string;
  note?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Recorder {
  /** VMs this server has driven, newest touch last. */
  private touched = new Map<string, number>();
  private session: Session | null = null;

  constructor(private readonly deps: RecorderDeps, private readonly env: NodeJS.ProcessEnv = process.env) {}

  /** The VMs this agent session is controlling. */
  controlled(): string[] {
    return [...this.touched.keys()];
  }

  /** Called after every tool call. Tracks controlled VMs and logs actions. */
  observe(tool: string, args: Record<string, unknown>, result: unknown, at: number): void {
    const sc = (result as { structuredContent?: { ok?: boolean; result?: { vm?: Partial<Vm>; lease_id?: string } } })?.structuredContent;
    const ok = sc?.ok !== false;
    const vmId = typeof args.vm_id === 'string' ? args.vm_id : undefined;
    const leased = sc?.result?.vm;

    if (tool === 'vm_lease_release' && ok && typeof args.lease_id === 'string') {
      this.forget(args.lease_id);
    }
    if (ok && vmId) this.touch(vmId);
    if (ok && leased?.uuid && leased.status === 'ready') this.touch(leased.uuid);

    const s = this.session;
    if (!s) return;
    const target = vmId ?? (tool === 'vm_lease_release' ? (args.lease_id as string | undefined) : leased?.uuid);
    if (!target) return;
    const described = describeAction(tool, args);
    if (described) s.events.push({ t: at - s.startedAt, vmUuid: target, tool, ok, ...described });
  }

  private touch(uuid: string): void {
    this.touched.delete(uuid);
    this.touched.set(uuid, Date.now());
    const s = this.session;
    if (s?.follow && s.sampling && !s.sources.has(uuid)) void this.addSource(s, uuid).catch(() => {});
  }

  private forget(uuid: string): void {
    this.touched.delete(uuid);
    const src = this.session?.sources.get(uuid);
    if (src) src.stopped = true;
  }

  status(): RecordingStatus {
    const s = this.session;
    if (!s) return { active: false, note: 'not recording' };
    return {
      active: true,
      recording_id: s.id,
      elapsed_s: Math.round((Date.now() - s.startedAt) / 100) / 10,
      follow: s.follow,
      vms: [...s.sources.values()].map((src) => ({
        vm_id: src.vm.uuid, label: src.label, frames: src.frames.length, errors: src.errors,
        ...(src.lastError ? { last_error: src.lastError } : {}), sampling: !src.stopped && s.sampling,
      })),
      actions: s.events.length,
      ...(s.stopReason ? { stop_reason: s.stopReason } : {}),
    };
  }

  async start(opts: RecordStartOptions = {}): Promise<RecordingStatus> {
    if (this.session) return { ...this.status(), note: 'already recording — call vm_record stop to get the video' };
    const fps = Math.min(Math.max(opts.fps ?? DEFAULT_RECORD_FPS, 0.2), 10);
    const follow = !opts.vmIds?.length;
    let ids = opts.vmIds ?? this.controlled();
    if (!ids.length) {
      // A fresh server process has no history yet: take every ready VM with a screen.
      const vms = await this.deps.listVms().catch(() => [] as Vm[]);
      ids = vms.filter((v) => v.status === 'ready').map((v) => v.uuid);
    }
    const id = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
    const workDir = join(recordingDir(this.env), `.work-${id}`);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const maxMs = opts.maxMs ?? DEFAULT_RECORD_MAX_MS;
    const s: Session = {
      id, startedAt: Date.now(), workDir, intervalMs: 1000 / fps, maxBytes: opts.maxBytes ?? DEFAULT_RECORD_MAX_BYTES, bytes: 0,
      follow, title: opts.title, sources: new Map(), events: [], sampling: true,
      timer: setTimeout(() => { s.stopReason ??= `time cap ${Math.round(maxMs / 1000)}s reached`; s.sampling = false; }, maxMs),
    };
    s.timer.unref();
    this.session = s;
    const added = await Promise.allSettled(ids.map((uuid) => this.addSource(s, uuid, !follow)));
    const failed = added.flatMap((r, i) => (r.status === 'rejected' ? [`${ids[i]}: ${(r.reason as Error)?.message ?? r.reason}`] : []));
    if (!follow && failed.length === ids.length) {
      this.discard();
      throw vmError('INVALID_REQUEST', `none of the requested VMs can be recorded — ${failed.join('; ')}`);
    }
    const note = s.sources.size === 0
      ? 'no VM is under control yet — the recording follows the next VM you lease or drive'
      : failed.length ? `skipped: ${failed.join('; ')}` : undefined;
    return { ...this.status(), ...(note ? { note } : {}) };
  }

  private async addSource(s: Session, uuid: string, strict = false): Promise<void> {
    if (s.sources.has(uuid)) return;
    const vm = await this.deps.getVm(uuid);
    const adapter = this.deps.adapterOf(vm);
    if (!adapter || !adapter.availableTools().includes(CAPABILITIES.screenshot)) {
      if (strict) throw vmError('CAPABILITY_UNAVAILABLE', `VM ${uuid} (${vm.adapter}) has no screen to record`);
      return;
    }
    if (s.sources.has(uuid) || this.session !== s) return;
    const dir = join(s.workDir, `vm-${s.sources.size}`);
    mkdirSync(dir, { recursive: true });
    const src: Source = {
      vm, adapter, dir, frames: [], errors: 0, stopped: false,
      label: vm.templateId && vm.templateId !== vm.adapter ? `${vm.adapter} · ${vm.templateId}` : vm.adapter,
      sublabel: `vm ${vm.uuid.slice(0, 8)}${vm.ip ? ` · ${vm.ip}` : ''}`,
    };
    s.sources.set(uuid, src);
    src.loop = this.sample(s, src);
  }

  private async sample(s: Session, src: Source): Promise<void> {
    let seq = 0;
    while (s.sampling && !src.stopped && this.session === s) {
      const t0 = Date.now();
      try {
        const shot = await Promise.race([
          src.adapter.screenshot(src.vm, { jpeg: true }),
          sleep(30_000).then(() => { throw new Error('screenshot timed out after 30s'); }),
        ]);
        const at = Math.round((t0 + Date.now()) / 2) - s.startedAt;
        const hash = createHash('sha1').update(shot.image).digest('hex');
        if (hash !== src.lastHash && s.sampling) {
          const size = imageSize(shot.image);
          const file = join(src.dir, `${String(++seq).padStart(6, '0')}.${shot.format}`);
          writeFileSync(file, shot.image);
          s.bytes += shot.image.length;
          src.frames.push({
            t: Math.max(0, at), file: file.slice(s.workDir.length + 1),
            width: size?.width ?? shot.width, height: size?.height ?? shot.height,
            logicalWidth: shot.width, logicalHeight: shot.height, mapping: shot.coordMapping,
          });
          src.lastHash = hash;
          if (s.bytes > s.maxBytes) { s.stopReason ??= `size cap ${s.maxBytes} bytes reached`; s.sampling = false; }
        }
        src.errors = 0;
      } catch (e) {
        src.errors++;
        src.lastError = isVmError(e) ? `${e.code}: ${e.message}` : (e as Error).message;
        if ((isVmError(e) && (e.code === 'NOT_FOUND' || e.code === 'CAPABILITY_UNAVAILABLE')) || src.errors >= 30) {
          src.stopped = true;
          break;
        }
        await sleep(Math.min(5000, 500 * src.errors));
        continue;
      }
      await sleep(Math.max(0, s.intervalMs - (Date.now() - t0)));
    }
  }

  /** Stop sampling and render. The session ends even when rendering fails. */
  async stop(opts: { gif?: boolean; width?: number; height?: number; keepFrames?: boolean } = {}): Promise<RecordingStatus & { video: RenderedVideo }> {
    const s = this.session;
    if (!s) throw vmError('NOT_FOUND', 'no recording is running', 'Start one with vm_record action "start" (or use action "clip" for a fixed-length clip).');
    const endedAt = Date.now();
    s.sampling = false;
    clearTimeout(s.timer);
    await Promise.race([Promise.allSettled([...s.sources.values()].map((src) => src.loop)), sleep(35_000)]);
    const status = this.status();
    this.session = null;

    const dir = recordingDir(this.env);
    const outFile = join(dir, `vmhub-${s.id}.mp4`);
    const sources = [...s.sources.values()];
    const n = sources.length;
    const video = await renderVideo({
      workDir: s.workDir, outFile, durationMs: endedAt - s.startedAt,
      width: opts.width ?? 1920, height: opts.height ?? 1080,
      title: s.title ?? (n === 1 ? `vmhub · ${sources[0]!.label}` : `vmhub · ${n} VMs`),
      sources: sources.map((src) => ({
        uuid: src.vm.uuid, label: src.label, sublabel: src.sublabel, frames: src.frames,
        ...(src.lastError && !src.frames.length ? { note: `no frames: ${src.lastError}` } : {}),
      })),
      events: s.events, gif: opts.gif, env: this.env,
    });
    if (!opts.keepFrames) rmSync(s.workDir, { recursive: true, force: true });
    return { ...status, active: false, video };
  }

  /** Drop a session without rendering (server teardown, failed start). */
  discard(): void {
    const s = this.session;
    if (!s) return;
    s.sampling = false;
    clearTimeout(s.timer);
    this.session = null;
    rmSync(s.workDir, { recursive: true, force: true });
  }
}

/** Read a rendered poster for inline display, if it is small enough to inline. */
export function posterContent(path: string | undefined, maxBytes = 1.5 * 1024 * 1024): { type: 'image'; data: string; mimeType: 'image/jpeg' } | null {
  if (!path) return null;
  try {
    const buf = readFileSync(path);
    return buf.length <= maxBytes ? { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' } : null;
  } catch {
    return null;
  }
}
