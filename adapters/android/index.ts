/**
 * Android adapter — real driver using host-side ADB (v1 path).
 *
 * The android-9-golden runs ADB-over-network on :5555 (baked into the golden's
 * init.sh). The control plane reaches it via `adb connect <vm-ip>:5555`, then
 * drives it with adb shell (screencap / input / am / dumpsys).
 *
 * Tool mapping (ADB -> vm_* contract):
 *   screenshot -> `adb exec-out screencap -p`
 *   click/type/key/drag -> `adb shell input`
 *   launch -> `adb shell am start`
 *   inspect -> `adb shell uiautomator dump` (+ pull the XML)
 *   list_windows -> dumpsys window windows (best-effort)
 *   exec -> `adb shell` (arbitrary command)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { closeVmTunnels, sshHostArgs, vmTunnel } from '../transport.ts';
import { runBounded, shq } from '../ssh-ops.ts';

const execFileP = promisify(execFile);

/** How the adapter reaches root inside the guest. */
export type Privilege = 'root' | 'su' | 'shell';

/** Default ADB port — override with ADB_PORT. */
export const ADB_PORT = 5555;

export class AndroidAdapter implements DesktopAdapter {
  readonly id = 'android';
  readonly capability = {
    adapter: 'android',
    os: 'android' as const,
    windowing: [] as WindowingSystem[],
    input: ['click', 'type', 'key', 'paste', 'drag', 'gesture', 'touch'] as InputCapability[],
    semantic: 'uiautomator' as const,
    files: ['adb'] as FileCapability[],
    exec: true,
    notes: 'Android via ADB (root when the image allows it); adb runs on the MCP host or the Proxmox host.',
  };

  /** vm uuid -> adb serial (host:port of the tunnel endpoint). */
  private serials = new Map<string, string>();
  private privilege = new Map<string, Privilege>();
  private location?: 'local' | 'jump';

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
      CAPABILITIES.exec,
      CAPABILITIES.putFile,
      CAPABILITIES.getFile,
    ];
  }

  /**
   * Where adb runs. The MCP host is the natural place, but a workstation
   * often has no android-tools while the Proxmox host does — and the host
   * also reaches the guest network directly, so no tunnel is needed there.
   * VMHUB_ADB=local|jump forces it; the default probes for a local adb once.
   */
  private async adbLocation(): Promise<'local' | 'jump'> {
    const forced = process.env.VMHUB_ADB;
    if (forced === 'local' || forced === 'jump') return forced;
    if (this.location) return this.location;
    try {
      await execFileP('adb', ['version']);
      this.location = 'local';
    } catch {
      this.location = 'jump';
    }
    return this.location;
  }

  /** Run one adb invocation, locally or on the Proxmox host. */
  private async adbRun(args: string[], opts: { buffer?: boolean; timeoutMs?: number } = {}): Promise<{ stdout: string | Buffer; stderr: string; exitCode: number }> {
    const where = await this.adbLocation();
    const max = 64 * 1024 * 1024;
    if (where === 'local') {
      const res = await runBounded('adb', args, { timeoutMs: opts.timeoutMs ?? 120_000, outputCap: max, binary: opts.buffer });
      return { stdout: res.stdoutRaw ?? res.stdout, stderr: res.stderr, exitCode: res.exitCode };
    }
    const remote = ['adb', ...args.map(shq)].join(' ');
    const res = await runBounded('ssh', [...sshHostArgs(), remote], { timeoutMs: opts.timeoutMs ?? 120_000, outputCap: max, binary: opts.buffer });
    return { stdout: res.stdoutRaw ?? res.stdout, stderr: res.stderr, exitCode: res.exitCode };
  }

  /**
   * Connect to the VM's adbd and escalate to root. Android-x86 lab images
   * run userdebug, where `adb root` restarts adbd as root — that is what
   * makes /data, /system and other apps' files reachable. A production
   * build refuses; then commands go through `su -c` if the image has su,
   * and otherwise run as the shell user (reported in capabilities).
   */
  private async ensureConnected(vm: Vm): Promise<string> {
    const known = this.serials.get(vm.uuid);
    if (known) return known;
    if (!vm.ip) throw vmError('INTERNAL', 'android adapter: VM has no IP (not leased?)', 'Lease the VM first');
    const port = Number(process.env.ADB_PORT ?? ADB_PORT);
    const endpoint = (await this.adbLocation()) === 'jump'
      ? { host: vm.ip, port } // the Proxmox host routes the guest network itself
      : await vmTunnel(vm, port);
    const serial = `${endpoint.host}:${endpoint.port}`;
    const connect = async (): Promise<void> => {
      const res = await this.adbRun(['connect', serial], { timeoutMs: 30_000 });
      const out = `${res.stdout}${res.stderr}`;
      if (/unable|failed|cannot|refused/i.test(out)) throw new Error(out.trim() || `adb connect ${serial} failed`);
    };
    try {
      await connect();
      this.serials.set(vm.uuid, serial);
      this.privilege.set(vm.uuid, await this.escalate(serial, connect));
      return serial;
    } catch (e) {
      this.serials.delete(vm.uuid);
      throw vmError(
        'INTERNAL',
        `android adapter: adb connect ${serial} failed (${e instanceof Error ? e.message : String(e)})`,
        'Ensure the Android golden has ADB-over-network enabled (:5555) and adb is available (locally or on VMHUB_JUMP_HOST).',
      );
    }
  }

  /** `adb root`, then `su` — whichever the image allows. */
  private async escalate(serial: string, reconnect: () => Promise<void>): Promise<Privilege> {
    const root = await this.adbRun(['-s', serial, 'root'], { timeoutMs: 30_000 });
    const said = `${root.stdout}${root.stderr}`;
    if (!/cannot run as root|production build/i.test(said)) {
      // adbd restarts: the socket drops, so reconnect and wait for the daemon.
      await new Promise((r) => setTimeout(r, 2000));
      for (let i = 0; i < 15; i++) {
        try {
          await reconnect();
          const who = await this.adbRun(['-s', serial, 'shell', 'id -u'], { timeoutMs: 20_000 });
          if (String(who.stdout).trim() === '0') return 'root';
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
    const su = await this.adbRun(['-s', serial, 'shell', 'su -c id -u'], { timeoutMs: 20_000 });
    if (String(su.stdout).trim() === '0') return 'su';
    return 'shell';
  }

  /** How commands reach root on this VM (set at connect). */
  privilegeOf(vm: Vm): Privilege {
    return this.privilege.get(vm.uuid) ?? 'shell';
  }

  /** Wrap a guest command so it runs as root when the image needs `su`. */
  private asRoot(vm: Vm, script: string): string {
    return this.privilegeOf(vm) === 'su' ? `su -c ${shq(script)}` : script;
  }

  /** adb text call for one VM (always with -s; errors carry adb's message). */
  private async adb(vm: Vm, args: string[], timeoutMs = 120_000): Promise<string> {
    const serial = await this.ensureConnected(vm);
    const res = await this.adbRun(['-s', serial, ...args], { timeoutMs });
    if (res.exitCode !== 0) {
      throw vmError(
        'INTERNAL',
        `android adapter: adb ${args[0] ?? ''} failed: ${(res.stderr || String(res.stdout)).trim().slice(-400)}`,
        'Retry; ADB-over-network can be slow on first call.',
      );
    }
    return String(res.stdout);
  }

  /** Binary adb exec-out (screencap, file reads). */
  private async adbOut(vm: Vm, args: string[], timeoutMs = 120_000): Promise<Buffer> {
    const serial = await this.ensureConnected(vm);
    const res = await this.adbRun(['-s', serial, 'exec-out', ...args], { buffer: true, timeoutMs });
    if (res.exitCode !== 0) {
      throw vmError('INTERNAL', `android adapter: adb exec-out ${args[0] ?? ''} failed: ${res.stderr.trim().slice(-400)}`);
    }
    return (res.stdout as Buffer) ?? Buffer.alloc(0);
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    await this.ensureConnected(vm);
    // screencap emits binary PNG — request a Buffer, not a string.
    const stdout = await this.adbOut(vm, ['screencap', '-p']);
    return {
      image: stdout,
      format: 'png',
      width: 0,
      height: 0,
      coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    };
  }

  async input(vm: Vm, action: InputAction): Promise<void> {
    switch (action.kind) {
      case 'click':
        await this.adb(vm, ['shell', 'input', 'tap', String(action.x), String(action.y)]);
        return;
      case 'type':
        await this.adb(vm, ['shell', 'input', 'text', action.text]);
        return;
      case 'key':
        await this.adb(vm, ['shell', 'input', 'keyevent', keycode(action.chord)]);
        return;
      case 'drag':
        await this.adb(vm, ['shell', 'input', 'swipe',
          String(action.from.x), String(action.from.y),
          String(action.to.x), String(action.to.y), '300']);
        return;
      case 'paste':
        // adb clipboard requires extra tooling; type as text fallback.
        await this.adb(vm, ['shell', 'input', 'text', action.text]);
        return;
      case 'gesture':
        throw vmError('CAPABILITY_UNAVAILABLE', 'android adapter: gestures not supported (use click/drag)');
    }
  }

  async listWindows(_vm: Vm, _filter?: string): Promise<WindowInfo[]> {
    // dumpsys window is verbose and best-effort; return empty for v1.
    return [];
  }

  async inspect(vm: Vm): Promise<SemanticElement> {
    await this.adb(vm, ['shell', 'uiautomator', 'dump', '/sdcard/window_dump.xml']);
    const stdout = (await this.adbOut(vm, ['cat', '/sdcard/window_dump.xml'])).toString('utf8');
    return {
      role: 'screen',
      name: 'Android screen (uiautomator)',
      x: 0, y: 0, width: 0, height: 0,
      children: [],
      properties: { semantic: 'uiautomator', adapter: 'android', raw: stdout.slice(0, 2000) },
    };
  }

  /**
   * adb shell with the real exit code (plain `adb shell` exits 0 on old
   * adbd), bounded output and timeout.
   */
  async exec(vm: Vm, cmd: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
    const t0 = Date.now();
    const serial = await this.ensureConnected(vm);
    const full = [cmd, ...args.map(shq)].join(' ');
    const script = opts.cwd ? `cd ${shq(opts.cwd)} && ${full}` : full;
    const res = await this.adbRun(['-s', serial, 'shell', `${this.asRoot(vm, script)}; echo "__vmhub_rc=$?"`], {
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    const stdout = String(res.stdout);
    const m = /__vmhub_rc=(\d+)\s*$/.exec(stdout);
    return {
      exitCode: m ? Number(m[1]) : res.exitCode,
      stdout: m ? stdout.slice(0, m.index) : stdout,
      stderr: res.stderr,
      durationMs: Date.now() - t0,
    };
  }

  async putFile(vm: Vm, localPath: string, remotePath: string): Promise<void> {
    await this.adb(vm, ['push', localPath, remotePath]);
  }

  async getFile(vm: Vm, remotePath: string, localPath: string): Promise<void> {
    await this.adb(vm, ['pull', remotePath, localPath]);
  }

  releaseConnection(vm: Vm): void {
    const serial = this.serials.get(vm.uuid);
    if (serial) execFile('adb', ['disconnect', serial], () => {});
    this.serials.delete(vm.uuid);
    closeVmTunnels(vm);
  }

  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    if (verb === 'launch') {
      const pkg = String(args.package ?? args.pkg ?? '');
      if (!pkg) throw vmError('INVALID_REQUEST', 'android launch: package required');
      return this.adb(vm, ['shell', 'am', 'start', '-n', pkg]);
    }
    throw vmError('CAPABILITY_UNAVAILABLE', `android dispatch: unknown verb "${verb}"`);
  }
}

/** Map a chord like "home"/"back"/"enter" to an Android keyevent code. */
export function keycode(chord: string): string {
  const map: Record<string, string> = {
    home: '3', back: '4', enter: '66', tab: '61', escape: '111',
    up: '19', down: '20', left: '21', right: '22',
    menu: '82', power: '26', volume_up: '24', volume_down: '25',
  };
  const key = chord.toLowerCase();
  return map[key] ?? key; // pass through numeric codes; unknown text → the chord
}

export const androidAdapter = new AndroidAdapter();
