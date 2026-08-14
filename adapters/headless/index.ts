/**
 * Headless adapter — the no-display path for OS-less golden VMs such as
 * debian-13-golden (os=headless). Users can still lease these VMs and drive
 * them over SSH (exec); there is deliberately NO display adapter: no
 * screenshot, no input, no windowing. Every display method returns a typed
 * CAPABILITY_UNAVAILABLE.
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
import { sshIntoVmArgs } from '../transport.ts';

const execFileP = promisify(execFile);

export class HeadlessAdapter implements DesktopAdapter {
  readonly id = 'headless';
  readonly capability = {
    adapter: 'headless',
    os: 'headless' as const,
    windowing: [] as WindowingSystem[],
    input: [] as InputCapability[],
    semantic: 'none' as const,
    files: [] as FileCapability[],
    exec: true,
    notes: 'Headless Linux golden (debian-13-golden): lease for exec/SSH, no display tools.',
  };

  availableTools(): CapabilityId[] {
    // No display tools by design. exec is declared (SSH) but the 22-tool
    // surface has no vm_exec tool, so nothing gates on it.
    return [CAPABILITIES.exec];
  }

  /** Run a command in the VM over the same SSH transport the desktop adapters use. */
  async exec(vm: Vm, cmd: string, args: string[] = []): Promise<ExecResult> {
    if (!vm.ip) {
      throw vmError('INTERNAL', `headless adapter: VM ${vm.uuid} has no ip — cannot run exec`);
    }
    try {
      const { stdout, stderr } = await execFileP('ssh', [...sshIntoVmArgs(vm), cmd, ...args], { timeout: 30_000 });
      return { exitCode: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number | string; stdout?: string; stderr?: string };
      return {
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? (e instanceof Error ? e.message : String(e)),
      };
    }
  }

  async screenshot(_vm: Vm): Promise<ScreenshotResult> {
    throw vmError('CAPABILITY_UNAVAILABLE', 'headless adapter: no display (debian-13-golden has no desktop)');
  }

  async input(_vm: Vm, _action: InputAction): Promise<void> {
    throw vmError('CAPABILITY_UNAVAILABLE', 'headless adapter: no input (debian-13-golden has no desktop)');
  }

  async listWindows(_vm: Vm): Promise<WindowInfo[]> {
    throw vmError('CAPABILITY_UNAVAILABLE', 'headless adapter: no windowing (debian-13-golden has no desktop)');
  }

  async inspect(_vm: Vm): Promise<SemanticElement> {
    throw vmError('CAPABILITY_UNAVAILABLE', 'headless adapter: no semantic tree (debian-13-golden has no desktop)');
  }
}

export const headlessAdapter = new HeadlessAdapter();
