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

  private connected = new Set<string>();

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
    ];
  }

  /** Connect to the VM's adbd. No-op if already connected. */
  private async ensureConnected(vm: Vm): Promise<void> {
    if (this.connected.has(vm.uuid)) return;
    if (!vm.ip) throw vmError('INTERNAL', 'android adapter: VM has no IP (not leased?)', 'Lease the VM first');
    const target = `${vm.ip}:${process.env.ADB_PORT ?? ADB_PORT}`;
    try {
      await execFileP('adb', ['connect', target]);
      this.connected.add(vm.uuid);
    } catch (e) {
      throw vmError(
        'INTERNAL',
        `android adapter: adb connect ${target} failed (${e instanceof Error ? e.message : String(e)})`,
        'Ensure adb is installed and the Android golden has ADB-over-network enabled (:5555).',
      );
    }
  }

  private async adb(vm: Vm, args: string[]): Promise<string> {
    await this.ensureConnected(vm);
    try {
      const { stdout } = await execFileP('adb', args);
      return stdout;
    } catch (e) {
      throw vmError(
        'INTERNAL',
        `android adapter: adb ${args[0] ?? ''} failed (${e instanceof Error ? e.message : String(e)})`,
        'Retry; ADB-over-network can be slow on first call.',
      );
    }
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    await this.ensureConnected(vm);
    // screencap emits binary PNG — request a Buffer, not a string.
    const { stdout } = await execFileP('adb', ['exec-out', 'screencap', '-p'], { encoding: 'buffer' as const });
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
    const { stdout } = await execFileP('adb', ['exec-out', 'cat', '/sdcard/window_dump.xml']);
    return {
      role: 'screen',
      name: 'Android screen (uiautomator)',
      x: 0, y: 0, width: 0, height: 0,
      children: [],
      properties: { semantic: 'uiautomator', adapter: 'android', raw: stdout.slice(0, 2000) },
    };
  }

  async exec(vm: Vm, cmd: string, args?: string[]): Promise<ExecResult> {
    const stdout = await this.adb(vm, ['shell', cmd, ...(args ?? [])]);
    return { exitCode: 0, stdout, stderr: '' };
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
