/**
 * iOS adapter — real driver for the iOS Simulator that runs INSIDE the
 * macOS guest (derivedFrom: 'macos'). Every command execs into the parent VM
 * through its SSH transport (macosSshArgs), so the adapter is a transport +
 * command-construction layer over `xcrun simctl` (v1) and `idb` (v2).
 *
 * Availability is a version-locked tuple — the parent macOS golden present
 * AND carrying the paired iOS 26.3.1 runtime (see tuple.ts) — not a golden of
 * its own. Per-channel health (simctl screenshot vs idb AX) is reported
 * independently.
 */
import type {
  Capability,
  CapabilityId,
  DesktopAdapter,
  ExecResult,
  FileCapability,
  InputAction,
  InputCapability,
  ScreenshotResult,
  SemanticElement,
  TemplateConstraint,
  Vm,
  WindowInfo,
  WindowingSystem,
} from '../../src/shared/types.ts';
import { CAPABILITIES } from '../../src/shared/types.ts';
import { vmError } from '../../src/mcp/errors.ts';
import { nodeSshRunner, type SshRunner } from '../transport.ts';
import { macosSshArgs } from '../macos/ssh.ts';
import { idbArgv, iosDeviceUdid, iosInputArgv, iosLadder, iosToolsForLadder, simctlArgv, idbTree, idbWindows, type IosLadder } from './argv.ts';

export interface IosAdapterOptions {
  ssh?: SshRunner;
  env?: NodeJS.ProcessEnv;
}

export class IosAdapter implements DesktopAdapter {
  readonly id = 'ios';
  /** The parent this adapter lives inside — catalog resolution reads this. */
  readonly derivedFrom: string | undefined = 'macos';
  /** Local matrix availability (conditional on the tuple — checked live). */
  readonly localAvailability: 'unavailable' | 'stub' = 'unavailable';
  readonly availabilityReason =
    'iOS Simulator runs inside the macOS golden; availability requires the version-paired macOS golden (see vm_list_templates with a live catalog).';
  readonly templateConstraints: TemplateConstraint[] = [
    { os: 'macos', cpu: { avx2: true }, minRamMb: 10_240, runtime: 'ios-simctl@26.3.1' },
  ];

  private readonly ssh: SshRunner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(opts: IosAdapterOptions = {}) {
    this.ssh = opts.ssh ?? nodeSshRunner;
    this.env = opts.env ?? process.env;
  }

  get ladder(): IosLadder {
    return iosLadder(this.env);
  }

  get capability(): Capability {
    const v2 = this.ladder === 'v2';
    return {
      adapter: 'ios',
      os: 'ios',
      windowing: ['ios'] as WindowingSystem[],
      input: (v2 ? ['click', 'type', 'key', 'paste', 'drag'] : []) as InputCapability[],
      semantic: v2 ? 'ax' : 'none',
      files: [] as FileCapability[],
      exec: true,
      notes: `iOS Simulator inside the macOS golden (${this.ladder === 'v2' ? 'simctl + idb' : 'simctl'}, derivedFrom macos).`,
    };
  }

  availableTools(): CapabilityId[] {
    return iosToolsForLadder(this.ladder);
  }

  /** The booted simulator UDID: VMHUB_IOS_UDID pin, else discover via simctl. */
  private async resolveUdid(vm: Vm): Promise<string> {
    const pinned = iosDeviceUdid(this.env);
    if (pinned) return pinned;
    const res = await this.sshRun(vm, simctlArgv('', 'list', ['devices', 'booted']));
    const m = String(res.stdout).match(/\b([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\b/i);
    if (!m?.[1]) {
      throw vmError('INTERNAL', 'ios adapter: no booted simulator found', 'Boot a simulator in the macOS guest (xcrun simctl boot) and retry.');
    }
    return m[1];
  }

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    const udid = await this.resolveUdid(vm);
    const res = await this.sshRun(vm, simctlArgv(udid, 'io', ['screenshot', '-']), 'buffer');
    return {
      image: res.stdout as Buffer,
      format: 'png',
      width: 0,
      height: 0,
      coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    };
  }

  async input(vm: Vm, action: InputAction): Promise<void> {
    const argv = iosInputArgv(this.ladder, await this.resolveUdid(vm), action);
    if (!argv) {
      throw vmError(
        'CAPABILITY_UNAVAILABLE',
        `ios adapter: "${action.kind}" needs idb (v2 ladder) — simctl has no HID input`,
        'Install idb in the macOS guest, or use vm_dispatch with a simctl verb.',
      );
    }
    await this.sshRun(vm, argv);
  }

  async listWindows(vm: Vm, filter?: string): Promise<WindowInfo[]> {
    const udid = await this.requireIdb(vm);
    const res = await this.sshRun(vm, idbArgv(udid, 'describe-all', []));
    return idbWindows(parseIdbJson(String(res.stdout)), filter);
  }

  async inspect(vm: Vm): Promise<SemanticElement> {
    const udid = await this.requireIdb(vm);
    const res = await this.sshRun(vm, idbArgv(udid, 'describe-all', []));
    const raw = String(res.stdout);
    const tree = idbTree(parseIdbJson(raw));
    return tree ?? {
      role: 'screen',
      name: 'iOS Simulator (AX)',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: [],
      properties: { semantic: 'ax', adapter: 'ios', raw: raw.slice(0, 2000) },
    };
  }

  async exec(vm: Vm, cmd: string, args: string[] = []): Promise<ExecResult> {
    if (!vm.ip) throw vmError('INTERNAL', `ios adapter: VM ${vm.uuid} has no ip — cannot exec`);
    const res = await this.ssh.run('ssh', [...macosSshArgs(vm, this.env), cmd, ...args]);
    return { exitCode: res.exitCode, stdout: String(res.stdout), stderr: res.stderr };
  }

  async dispatch(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown> {
    switch (verb) {
      case 'install': {
        const udid = await this.resolveUdid(vm);
        await this.sshRun(vm, simctlArgv(udid, 'install', [String(args.path)]));
        return { installed: true, path: args.path };
      }
      case 'launch': {
        const udid = await this.resolveUdid(vm);
        await this.sshRun(vm, simctlArgv(udid, 'launch', [String(args.bundle)]));
        return { launched: true, bundle: args.bundle };
      }
      case 'list': {
        const res = await this.sshRun(vm, simctlArgv('', 'list', ['devices']));
        return { devices: String(res.stdout) };
      }
      case 'health':
        return this.health(vm);
      case 'simctl':
        return this.sshRun(vm, ['xcrun', 'simctl', ...argvOf(args)]);
      case 'idb':
        return this.sshRun(vm, ['idb', ...argvOf(args)]);
      default:
        throw vmError('CAPABILITY_UNAVAILABLE', `ios adapter: unknown dispatch verb "${verb}"`);
    }
  }

  /** Bridge entry for the macos adapter's dispatch 'ios' verb. */
  async drive(vm: Vm, op: 'simctl' | 'idb' | 'health', args: Record<string, unknown>): Promise<unknown> {
    if (op === 'health') return this.health(vm);
    if (op === 'simctl') return this.sshRun(vm, ['xcrun', 'simctl', ...argvOf(args)]);
    if (op === 'idb') return this.sshRun(vm, ['idb', ...argvOf(args)]);
    throw vmError('INVALID_REQUEST', `ios driver: unknown op "${String(op)}"`);
  }

  /** Dual-channel health: simctl screenshot and idb AX reported independently. */
  async health(vm: Vm): Promise<{ simctlScreenshot: 'ok' | 'degraded'; idbAx: 'ok' | 'degraded'; ladder: IosLadder }> {
    const simctlScreenshot = await this.probe(async () => {
      const udid = await this.resolveUdid(vm);
      await this.sshRun(vm, simctlArgv(udid, 'io', ['screenshot', '-']));
    });
    const idbAx =
      this.ladder === 'v2'
        ? await this.probe(async () => {
            const udid = await this.resolveUdid(vm);
            await this.sshRun(vm, idbArgv(udid, 'describe-all', []));
          })
        : 'degraded';
    return { simctlScreenshot, idbAx, ladder: this.ladder };
  }

  private async requireIdb(vm: Vm): Promise<string> {
    if (this.ladder !== 'v2') {
      throw vmError(
        'CAPABILITY_UNAVAILABLE',
        'ios adapter: AX inspection needs idb (v2 ladder)',
        'Install idb in the macOS guest (pip fb-idb + idb_companion), or drive via simctl verbs.',
      );
    }
    return this.resolveUdid(vm);
  }

  private async probe(fn: () => Promise<void>): Promise<'ok' | 'degraded'> {
    try {
      await fn();
      return 'ok';
    } catch {
      return 'degraded';
    }
  }

  /** SSH into the parent macOS guest and run the argv there. */
  private async sshRun(vm: Vm, argv: string[], encoding: 'utf8' | 'buffer' = 'utf8'): Promise<{ exitCode: number; stdout: string | Buffer; stderr: string }> {
    if (!vm.ip) throw vmError('INTERNAL', `ios adapter: VM ${vm.uuid} has no ip — cannot reach the parent macOS guest`);
    return this.ssh.run('ssh', [...macosSshArgs(vm, this.env), ...argv], { encoding });
  }
}

function argvOf(args: Record<string, unknown>): string[] {
  return Array.isArray(args.argv) ? args.argv.map(String) : [];
}

function parseIdbJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const iosAdapter = new IosAdapter();

export { iosTupleAvailability, macosGoldenVersion, IOS_MACOS_TUPLE } from './tuple.ts';
