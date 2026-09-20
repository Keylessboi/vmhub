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
  ExecOptions,
  ExecResult,
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
import { readFileSync, writeFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { closeVmTunnels, vmTunnel } from '../transport.ts';

/** Default CursorTouch endpoint — override with CURSORTOUCH_PORT. */
export const CURSORTOUCH_PORT = 8000;

/** Auth key for the CursorTouch server (set at golden build). */
export function cursorTouchAuthKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.CURSORTOUCH_AUTH_KEY ?? '';
}

interface WindowsConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** Name of CursorTouch's PowerShell tool (renamed across versions), resolved once. */
  shellTool?: string | null;
}

/** CursorTouch/Windows-MCP has shipped its shell tool as Shell, Powershell and Powershell-Tool. */
export const SHELL_TOOL_PATTERN = /^(power)?shell(-tool)?$/i;

/** A cold Windows desktop can take minutes to answer the first UI call. */
export const UI_CALL_TIMEOUT_MS = Number(process.env.CURSORTOUCH_TIMEOUT_MS ?? 180_000);

/** Base64 characters per PowerShell call when moving files (well under the 32K command-line cap). */
const FILE_CHUNK_B64 = 24_000;

/** PowerShell single-quoted string literal. */
export function psq(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * Wrap a command so the exit code survives CursorTouch's text response:
 * all streams merged, then a sentinel line with $LASTEXITCODE (or 1 when a
 * terminating error was thrown).
 */
export function wrapPowerShell(cmd: string, cwd?: string): string {
  const body = cwd ? `Set-Location -LiteralPath ${psq(cwd)}; ${cmd}` : cmd;
  return `$global:LASTEXITCODE=0; try { & { ${body} } *>&1 | Out-String -Width 4096 } catch { $_ | Out-String; $global:LASTEXITCODE=1 }; "__vmhub_rc=$LASTEXITCODE"`;
}

/** Split CursorTouch's shell reply into output + exit code. */
export function parseShellReply(text: string): { exitCode: number; output: string } {
  const body = text.replace(/^Response:\s*/, '').replace(/\n?Status Code:\s*-?\d+\s*$/, '');
  const m = /__vmhub_rc=(-?\d+)\s*$/.exec(body.trimEnd());
  if (m) return { exitCode: Number(m[1]), output: body.trimEnd().slice(0, m.index).trimEnd() };
  const code = /Status Code:\s*(-?\d+)/.exec(text);
  return { exitCode: code ? Number(code[1]) : 0, output: body };
}

export class WindowsAdapter implements DesktopAdapter {
  readonly id = 'windows';
  readonly capability = {
    adapter: 'windows',
    os: 'windows' as const,
    windowing: ['windows'] as WindowingSystem[],
    input: ['click', 'type', 'key', 'paste', 'drag'] as InputCapability[],
    semantic: 'uia' as const,
    files: ['powershell'] as FileCapability[],
    exec: true,
    notes: 'Real Windows golden via in-VM CursorTouch (Windows-MCP) server; PowerShell for exec and chunked file transfer.',
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
      CAPABILITIES.exec,
      CAPABILITIES.putFile,
      CAPABILITIES.getFile,
    ];
  }

  private async ensureConnection(vm: Vm): Promise<WindowsConnection> {
    const existing = this.conns.get(vm.uuid);
    if (existing) return existing;

    if (vm.status === 'error' || vm.status === 'destroyed') {
      throw vmError('PROVISION_FAILED', `VM ${vm.uuid} does not exist on Proxmox — provisioning may have failed`);
    }
    if (!vm.ip) {
      throw vmError('INTERNAL', 'windows adapter: VM has no IP (not leased?)', 'Lease the VM first');
    }
    const ep = await vmTunnel(vm, Number(process.env.CURSORTOUCH_PORT ?? CURSORTOUCH_PORT));
    const url = `http://${ep.host}:${ep.port}/mcp/`;
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

  async screenshot(vm: Vm, opts?: { jpeg?: boolean }): Promise<ScreenshotResult> {
    const conn = await this.ensureConnection(vm);
    const res = await conn.client.callTool({ name: 'Screenshot', arguments: {} }, { timeout: UI_CALL_TIMEOUT_MS });
    const image = extractImage(res.content);
    const { width, height } = pngDimensions(image.data);
    if (width === 0 || height === 0) {
      throw vmError('INTERNAL', 'windows screenshot returned no dimensions');
    }
    return {
      image: image.data,
      format: 'png',
      width,
      height,
      coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    };
  }

  /**
   * CursorTouch's input tools take a point as `loc: [x, y]`, a chord as
   * `shortcut`, a drag as Move{from_loc, loc, drag} and a clipboard write as
   * Clipboard{mode:'set', text} — not the field names vmhub uses internally.
   */
  async input(vm: Vm, action: InputAction): Promise<void> {
    const conn = await this.ensureConnection(vm);
    const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
      conn.client.callTool({ name, arguments: args }, { timeout: UI_CALL_TIMEOUT_MS });
    switch (action.kind) {
      case 'click':
        await call('Click', { loc: [action.x, action.y], button: action.button ?? 'left', clicks: 1 });
        return;
      case 'type':
        await call('Type', { text: action.text, press_enter: false });
        return;
      case 'key':
        await call('Shortcut', { shortcut: action.chord });
        return;
      case 'drag':
        await call('Move', { from_loc: [action.from.x, action.from.y], loc: [action.to.x, action.to.y], drag: true });
        return;
      case 'paste':
        await call('Clipboard', { mode: 'set', text: action.text });
        await call('Shortcut', { shortcut: 'ctrl+v' });
        return;
      case 'gesture':
        throw vmError('CAPABILITY_UNAVAILABLE', 'windows adapter: gestures not supported');
    }
  }


  async listWindows(vm: Vm, filter?: string): Promise<WindowInfo[]> {
    const conn = await this.ensureConnection(vm);
    const res = await conn.client.callTool({ name: 'Snapshot', arguments: {} }, { timeout: UI_CALL_TIMEOUT_MS });
    return parseSnapshotWindows(textContent(res.content as unknown[]) ?? '', filter);
  }

  async inspect(vm: Vm): Promise<SemanticElement> {
    const conn = await this.ensureConnection(vm);
    const res = await conn.client.callTool({ name: 'Snapshot', arguments: {} }, { timeout: UI_CALL_TIMEOUT_MS });
    const text = decodeSnapshotText(textContent(res.content as unknown[]) ?? '');
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

  private async shellTool(conn: WindowsConnection): Promise<string> {
    if (conn.shellTool === undefined) {
      const { tools } = await conn.client.listTools();
      conn.shellTool = tools.find((t) => SHELL_TOOL_PATTERN.test(t.name))?.name ?? null;
    }
    if (!conn.shellTool) {
      throw vmError('CAPABILITY_UNAVAILABLE', 'windows adapter: this CursorTouch build exposes no PowerShell tool');
    }
    return conn.shellTool;
  }

  private async ps(vm: Vm, script: string, timeoutMs = 120_000): Promise<{ exitCode: number; output: string }> {
    const conn = await this.ensureConnection(vm);
    const tool = await this.shellTool(conn);
    const res = await conn.client.callTool(
      { name: tool, arguments: { command: script, timeout: Math.ceil(timeoutMs / 1000) } },
      { timeout: timeoutMs + 15_000 },
    );
    return parseShellReply(textContent(res.content as unknown[]) ?? '');
  }

  /** PowerShell via CursorTouch, with a real exit code. */
  async exec(vm: Vm, cmd: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const full = [cmd, ...args.map(psq)].join(' ');
    const script = opts.detach
      ? `$p = Start-Process -PassThru -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command',${psq(full)} -RedirectStandardOutput "$env:TEMP\\vmhub-bg-$PID.log"; "pid=$($p.Id)"`
      : full;
    const { exitCode, output } = await this.ps(vm, wrapPowerShell(script, opts.cwd), opts.timeoutMs ?? 120_000);
    const cap = opts.outputCap ?? 200_000;
    // CursorTouch reports its own timeout as prose, not a signal: surface it
    // as timedOut so agents see the same contract as on Linux.
    const timedOut = /command execution timed out/i.test(output);
    return {
      exitCode,
      stdout: output.length > cap ? output.slice(-cap) : output,
      stderr: timedOut ? `[vmhub: the guest stopped the command at its timeout]` : '',
      timedOut,
      truncated: output.length > cap,
      durationMs: Date.now() - t0,
    };
  }

  /** Upload in base64 chunks through PowerShell (CursorTouch has no file channel). */
  async putFile(vm: Vm, localPath: string, remotePath: string): Promise<void> {
    const b64 = readFileSync(localPath).toString('base64');
    for (let i = 0, first = true; first || i < b64.length; i += FILE_CHUNK_B64, first = false) {
      const chunk = b64.slice(i, i + FILE_CHUNK_B64);
      const mode = i === 0 ? 'Create' : 'Append';
      const r = await this.ps(vm, wrapPowerShell(
        `$b=[Convert]::FromBase64String('${chunk}'); $f=[IO.File]::Open(${psq(remotePath)},'${mode}'); $f.Write($b,0,$b.Length); $f.Close()`,
      ));
      if (r.exitCode !== 0) throw vmError('INTERNAL', `put_file ${remotePath} failed: ${r.output.slice(-500)}`);
    }
  }

  async getFile(vm: Vm, remotePath: string, localPath: string): Promise<void> {
    const size = await this.ps(vm, wrapPowerShell(`(Get-Item -LiteralPath ${psq(remotePath)}).Length`));
    const total = Number(size.output.trim());
    if (size.exitCode !== 0 || !Number.isFinite(total)) throw vmError('NOT_FOUND', `get_file: ${remotePath}: ${size.output.slice(-300)}`);
    const chunkBytes = (FILE_CHUNK_B64 / 4) * 3;
    const parts: Buffer[] = [];
    for (let off = 0; off < total; off += chunkBytes) {
      const r = await this.ps(vm, wrapPowerShell(
        `$f=[IO.File]::OpenRead(${psq(remotePath)}); $f.Position=${off}; $b=New-Object byte[] ([Math]::Min(${chunkBytes}, $f.Length-${off})); [void]$f.Read($b,0,$b.Length); $f.Close(); [Convert]::ToBase64String($b)`,
      ));
      if (r.exitCode !== 0) throw vmError('INTERNAL', `get_file ${remotePath} failed at ${off}: ${r.output.slice(-300)}`);
      parts.push(Buffer.from(r.output.trim(), 'base64'));
    }
    writeFileSync(localPath, Buffer.concat(parts));
  }

  /**
   * Map a vm_* window verb onto CursorTouch's own tools. Its App tool takes
   * {mode, name|executable}, not vmhub's argument names, and has no close
   * mode at all — closing a program is Process(kill). Passing vmhub's
   * arguments straight through "succeeded" while doing nothing.
   */
  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = await this.ensureConnection(vm);
    const call = async (name: string, argv: Record<string, unknown>): Promise<unknown> => {
      const res = await conn.client.callTool({ name, arguments: argv }, { timeout: 120_000 });
      return textContent(res.content as unknown[]) ?? res.content;
    };
    switch (verb) {
      case 'launch': {
        const command = String(args.command ?? args.name ?? '');
        const extra = Array.isArray(args.args) ? (args.args as string[]) : [];
        // A path (or an .exe with one) launches directly; a bare name goes
        // through the Start menu, which is what App(launch) searches.
        const out = /[\\/]/.test(command)
          ? await call('App', { mode: 'launch_executable', executable: command, ...(extra.length ? { args: extra } : {}), ...(args.cwd ? { cwd: args.cwd } : {}) })
          : await call('App', { mode: 'launch', name: command });
        if (args.wait_for_window === false) return out;
        const deadline = Date.now() + Number(args.timeout_ms ?? 15_000);
        const wanted = command.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase();
        while (Date.now() < deadline) {
          const windows = await this.listWindows(vm);
          const hit = windows.find((w) => `${w.title} ${w.className}`.toLowerCase().includes(wanted));
          if (hit) return { launched: command, window: hit };
          await new Promise((r) => setTimeout(r, 1000));
        }
        return { launched: command, note: `no window matching "${wanted}" appeared; it may be a console program` };
      }
      case 'focus':
        return call('App', { mode: 'switch', name: String(args.window ?? args.name ?? '') });
      case 'close': {
        const target = String(args.window ?? args.name ?? '');
        return /^\d+$/.test(target)
          ? call('Process', { mode: 'kill', pid: Number(target) })
          : call('Process', { mode: 'kill', name: target.split(/[\\/]/).pop()!.replace(/\.exe$/i, '') });
      }
      default:
        return call(verb, args);
    }
  }


  releaseConnection(vm: Vm): void {
    const conn = this.conns.get(vm.uuid);
    if (conn) {
      conn.transport.close().catch(() => {});
      this.conns.delete(vm.uuid);
    }
    closeVmTunnels(vm);
  }
}

/** Parse PNG dimensions from the IHDR chunk (bytes 16-23). */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    return { width: 0, height: 0 };
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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
export function textContent(content: unknown[]): string | undefined {
  const block = content.find(
    (c): c is { type: 'text'; text: string } => typeof c === 'object' && c !== null && (c as { type: string }).type === 'text' && typeof (c as { text?: unknown }).text === 'string',
  );
  return block?.text;
}

export const windowsAdapter = new WindowsAdapter();

/**
 * CursorTouch returns Snapshot/Screenshot text as a JSON-encoded string (or
 * array of them), so the report arrives with escaped newlines. Decode it
 * before parsing; plain text passes through untouched.
 */
export function decodeSnapshotText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('"')) return raw;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === 'string').join('\n');
  } catch {
    // not JSON after all — fall through
  }
  return raw;
}

/**
 * Windows from a CursorTouch Snapshot. It prints a "Focused Window" table, an
 * "Opened Windows" table (or "No windows found") and a UI tree whose top level
 * is `window "Title"`. Rows: Name, Depth, Status, Width, Height, Handle.
 */
export function parseSnapshotWindows(raw: string, filter?: string): WindowInfo[] {
  const text = decodeSnapshotText(raw);
  const q = filter?.toLowerCase();
  const out = new Map<string, WindowInfo>();
  const add = (title: string, focused: boolean, size?: { w: number; h: number }, handle?: string): void => {
    const name = title.trim();
    if (!name || (q && !name.toLowerCase().includes(q))) return;
    const existing = out.get(name);
    if (existing) {
      if (focused) existing.focused = true;
      return;
    }
    out.set(name, {
      id: handle ?? name,
      title: name,
      className: name.split(/[\\/]/).pop() ?? name,
      x: 0,
      y: 0,
      width: size?.w ?? 0,
      height: size?.h ?? 0,
      focused,
      visible: true,
    });
  };
  const section = (heading: string): string[] => {
    const at = text.indexOf(heading);
    if (at < 0) return [];
    const rest = text.slice(at + heading.length).split(/\n\s*\n/)[0] ?? '';
    return rest.split('\n').map((l) => l.trim()).filter(Boolean);
  };
  // Table rows end with: Depth Status Width Height Handle
  const row = /^(.*?)\s{2,}(\d+)\s+(\w+)\s+(\d+)\s+(\d+)\s+(\d+)$/;
  for (const [heading, focused] of [['Focused Window:', true], ['Opened Windows:', false]] as const) {
    for (const line of section(heading)) {
      const m = row.exec(line);
      if (m) add(m[1]!, focused, { w: Number(m[4]), h: Number(m[5]) }, m[6]);
    }
  }
  for (const m of text.matchAll(/(?:^|├──|└──|│)\s*window\s+"([^"]*)"/g)) add(m[1]!, false);
  return [...out.values()];
}
