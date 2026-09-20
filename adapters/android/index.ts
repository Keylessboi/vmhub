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
import { randomUUID } from 'node:crypto';
import { closeVmTunnels, jumpHostOpts, sshHostArgs, sshJumpTarget, vmTunnel } from '../transport.ts';
import { pngDimensions } from '../windows/index.ts';
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
      await this.waitForFramework(serial);
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

  /**
   * adbd answers before Android is finished booting, and until then the
   * framework services are missing: launching an app gets "Unable to connect
   * to activity manager" and input gets "Can't find service: input". Wait for
   * sys.boot_completed once, when the connection is made.
   */
  private async waitForFramework(serial: string): Promise<void> {
    const deadline = Date.now() + Number(process.env.VMHUB_ANDROID_BOOT_WAIT_MS ?? 300_000);
    while (Date.now() < deadline) {
      const res = await this.adbRun(['-s', serial, 'shell', 'getprop sys.boot_completed'], { timeoutMs: 20_000 });
      if (String(res.stdout).trim() === '1') return;
      await new Promise((r) => setTimeout(r, 5000));
    }
    // Not fatal: exec and file transfer work without the framework.
    console.error(`[android] ${serial}: sys.boot_completed never became 1; UI calls may fail until it does`);
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

  /** adb's own words for "this cached device is stale; reconnect". */
  private static readonly STALE = /device offline|device .*not found|device still (?:authorizing|connecting)|closed/i;

  /**
   * Run an adb call, reconnecting once if the daemon's cached device went
   * stale (the VM rebooted, was reverted, or the golden was re-templated
   * while the host's adb server still held the endpoint).
   */
  private async adbCall(vm: Vm, build: (serial: string) => string[], opts: { buffer?: boolean; timeoutMs?: number }): Promise<{ stdout: string | Buffer; stderr: string; exitCode: number }> {
    const serial = await this.ensureConnected(vm);
    let res = await this.adbRun(build(serial), opts);
    if (res.exitCode !== 0 && AndroidAdapter.STALE.test(`${res.stderr}${res.stdout}`)) {
      this.serials.delete(vm.uuid);
      this.privilege.delete(vm.uuid);
      await this.adbRun(['disconnect', serial], { timeoutMs: 15_000 });
      const fresh = await this.ensureConnected(vm);
      res = await this.adbRun(build(fresh), opts);
    }
    return res;
  }

  /** adb text call for one VM (always with -s; errors carry adb's message). */
  private async adb(vm: Vm, args: string[], timeoutMs = 120_000): Promise<string> {
    const res = await this.adbCall(vm, (serial) => ['-s', serial, ...args], { timeoutMs });
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
    const res = await this.adbCall(vm, (serial) => ['-s', serial, 'exec-out', ...args], { buffer: true, timeoutMs });
    if (res.exitCode !== 0) {
      throw vmError('INTERNAL', `android adapter: adb exec-out ${args[0] ?? ''} failed: ${res.stderr.trim().slice(-400)}`);
    }
    return (res.stdout as Buffer) ?? Buffer.alloc(0);
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    await this.ensureConnected(vm);
    // screencap emits binary PNG — request a Buffer, not a string.
    const stdout = await this.adbOut(vm, ['screencap', '-p']);
    const { width, height } = pngDimensions(stdout);
    if (!stdout.length || width === 0 || height === 0) {
      throw vmError('INTERNAL', 'android screenshot: screencap returned no image',
        'The device may still be booting or the screen is off — retry, or wake it with vm_key.');
    }
    return {
      image: stdout,
      format: 'png',
      width,
      height,
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
    await this.ensureConnected(vm);
    const full = [cmd, ...args.map(shq)].join(' ');
    const script = opts.cwd ? `cd ${shq(opts.cwd)} && ${full}` : full;
    const res = await this.adbCall(vm, (serial) => ['-s', serial, 'shell', `${this.asRoot(vm, script)}; echo "__vmhub_rc=$?"`], {
      timeoutMs: opts.timeoutMs ?? 120_000,
    });
    const stdout = String(res.stdout);
    const m = /__vmhub_rc=(\d+)\s*$/.exec(stdout);
    return {
      exitCode: m ? Number(m[1]) : res.exitCode,
      stdout: m ? stdout.slice(0, m.index) : stdout,
      stderr: res.stderr,
      // the runner's verdict, not a guess: it owns the kill
      timedOut: /\[vmhub: killed after \d+ms timeout\]/.test(res.stderr),
      durationMs: Date.now() - t0,
    };
  }

  /**
   * Move a file in. When adb runs on the Proxmox host, the agent's local
   * path means nothing there, so the file is staged across first (and the
   * staging copy is always cleaned up).
   */
  async putFile(vm: Vm, localPath: string, remotePath: string): Promise<void> {
    if ((await this.adbLocation()) === 'local') {
      await this.adb(vm, ['push', localPath, remotePath], 1_800_000);
      return;
    }
    const staged = `/tmp/vmhub-push-${randomUUID()}`;
    const up = await runBounded('scp', [...jumpHostOpts(), localPath, `${sshJumpTarget()}:${staged}`], { timeoutMs: 1_800_000, outputCap: 20_000 });
    if (up.exitCode !== 0) throw vmError('INTERNAL', `android put_file: staging ${localPath} to the Proxmox host failed: ${up.stderr.trim().slice(-300)}`);
    try {
      await this.adb(vm, ['push', staged, remotePath], 1_800_000);
    } finally {
      await runBounded('ssh', [...sshHostArgs(), `rm -f ${shq(staged)}`], { timeoutMs: 60_000, outputCap: 2_000 });
    }
  }

  /** Move a file out, staging through the Proxmox host when adb runs there. */
  async getFile(vm: Vm, remotePath: string, localPath: string): Promise<void> {
    if ((await this.adbLocation()) === 'local') {
      await this.adb(vm, ['pull', remotePath, localPath], 1_800_000);
      return;
    }
    const staged = `/tmp/vmhub-pull-${randomUUID()}`;
    await this.adb(vm, ['pull', remotePath, staged], 1_800_000);
    try {
      const down = await runBounded('scp', [...jumpHostOpts(), `${sshJumpTarget()}:${staged}`, localPath], { timeoutMs: 1_800_000, outputCap: 20_000 });
      if (down.exitCode !== 0) throw vmError('INTERNAL', `android get_file: copying ${remotePath} back failed: ${down.stderr.trim().slice(-300)}`);
    } finally {
      await runBounded('ssh', [...sshHostArgs(), `rm -f ${shq(staged)}`], { timeoutMs: 60_000, outputCap: 2_000 });
    }
  }

  releaseConnection(vm: Vm): void {
    const serial = this.serials.get(vm.uuid);
    if (serial) execFile('adb', ['disconnect', serial], () => {});
    this.serials.delete(vm.uuid);
    closeVmTunnels(vm);
  }

  /**
   * Android's window verbs are activities, not windows: launch starts an
   * app (a bare package goes through the launcher intent, `pkg/activity`
   * starts that component), focus brings it forward, close force-stops it.
   */
  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    const target = String(args.package ?? args.pkg ?? args.command ?? args.name ?? args.window ?? '');
    switch (verb) {
      case 'launch':
      case 'focus': {
        if (!target) throw vmError('INVALID_REQUEST', `android ${verb}: package (or package/activity) required`);
        // Right after boot the activity manager is not up yet ("Unable to
        // connect to activity manager"). That is a wait, not a failure.
        const deadline = Date.now() + Number(process.env.VMHUB_ANDROID_AM_WAIT_MS ?? 120_000);
        let out = '';
        for (;;) {
          out = target.includes('/')
            ? await this.adb(vm, ['shell', 'am', 'start', '-n', target])
            : await this.adb(vm, ['shell', 'monkey', '-p', target, '-c', 'android.intent.category.LAUNCHER', '1']);
          if (!/Unable to connect to activity manager|system is not running/i.test(out) || Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (/Error|Exception|No activities found|Unable to connect/i.test(out)) {
          throw vmError('NOT_FOUND', `android ${verb}: ${target} did not start: ${out.trim().slice(-300)}`, 'List packages with vm_exec "pm list packages".');
        }
        return { started: target, detail: out.trim().slice(0, 300) };
      }
      case 'close': {
        if (!target) throw vmError('INVALID_REQUEST', 'android close: package required');
        await this.adb(vm, ['shell', 'am', 'force-stop', target]);
        return { stopped: target };
      }
      default:
        throw vmError('CAPABILITY_UNAVAILABLE', `android dispatch: unknown verb "${verb}"`);
    }
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
