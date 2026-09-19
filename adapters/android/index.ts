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
import { closeVmTunnels, vmTunnel } from '../transport.ts';
import { runBounded, shq } from '../ssh-ops.ts';

const execFileP = promisify(execFile);

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
    notes: 'Android via host-side ADB over the VM network (android-9-golden).',
  };

  /** vm uuid -> adb serial (host:port of the tunnel endpoint). */
  private serials = new Map<string, string>();

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
   * Connect to the VM's adbd through an SSH tunnel (the guest network is
   * not routable from the MCP host) and return the adb serial. Every adb
   * call passes `-s <serial>` — without it adb refuses as soon as a second
   * device (another lease, a phone) is attached.
   */
  private async ensureConnected(vm: Vm): Promise<string> {
    const known = this.serials.get(vm.uuid);
    if (known) return known;
    if (!vm.ip) throw vmError('INTERNAL', 'android adapter: VM has no IP (not leased?)', 'Lease the VM first');
    const { host, port } = await vmTunnel(vm, Number(process.env.ADB_PORT ?? ADB_PORT));
    const serial = `${host}:${port}`;
    try {
      const { stdout } = await execFileP('adb', ['connect', serial]);
      if (/unable|failed|cannot/i.test(stdout)) throw new Error(stdout.trim());
      this.serials.set(vm.uuid, serial);
      return serial;
    } catch (e) {
      throw vmError(
        'INTERNAL',
        `android adapter: adb connect ${serial} failed (${e instanceof Error ? e.message : String(e)})`,
        'Ensure adb is installed and the Android golden has ADB-over-network enabled (:5555).',
      );
    }
  }

  private async adb(vm: Vm, args: string[]): Promise<string> {
    const serial = await this.ensureConnected(vm);
    try {
      const { stdout } = await execFileP('adb', ['-s', serial, ...args], { maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      throw vmError(
        'INTERNAL',
        `android adapter: adb ${args[0] ?? ''} failed (${e instanceof Error ? e.message : String(e)})`,
        'Retry; ADB-over-network can be slow on first call.',
      );
    }
  }

  /** Binary adb exec-out (screencap) with the VM's serial. */
  private async adbOut(vm: Vm, args: string[]): Promise<Buffer> {
    const serial = await this.ensureConnected(vm);
    const { stdout } = await execFileP('adb', ['-s', serial, 'exec-out', ...args], { encoding: 'buffer' as const, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
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
    const serial = await this.ensureConnected(vm);
    const full = [cmd, ...args.map(shq)].join(' ');
    const script = opts.cwd ? `cd ${shq(opts.cwd)} && ${full}` : full;
    const res = await runBounded('adb', ['-s', serial, 'shell', `${script}; echo "__vmhub_rc=$?"`], {
      timeoutMs: opts.timeoutMs ?? 120_000,
      stdin: opts.stdin,
      outputCap: opts.outputCap ?? 200_000,
    });
    const m = /__vmhub_rc=(\d+)\s*$/.exec(res.stdout);
    return { ...res, exitCode: m ? Number(m[1]) : res.exitCode, stdout: m ? res.stdout.slice(0, m.index) : res.stdout };
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
