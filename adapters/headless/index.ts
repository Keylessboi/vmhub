/**
 * Headless adapter — the no-display path for OS-less golden VMs such as
 * debian-13-golden (os=headless). Users can still lease these VMs and drive
 * them over SSH (exec); there is deliberately NO display adapter: no
 * screenshot, no input, no windowing. Every display method returns a typed
 * CAPABILITY_UNAVAILABLE.
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
import { sshCloneRepo, sshExec, sshGetFile, sshPutFile } from '../ssh-ops.ts';

export class HeadlessAdapter implements DesktopAdapter {
  readonly id = 'headless';
  readonly capability = {
    adapter: 'headless',
    os: 'headless' as const,
    windowing: [] as WindowingSystem[],
    input: [] as InputCapability[],
    semantic: 'none' as const,
    files: ['scp'] as FileCapability[],
    exec: true,
    notes: 'Headless Linux golden (debian-13-golden): lease for exec/SSH, no display tools.',
  };

  availableTools(): CapabilityId[] {
    // No display tools by design: a shell, files and git over SSH.
    return [CAPABILITIES.exec, CAPABILITIES.putFile, CAPABILITIES.getFile, CAPABILITIES.cloneRepo];
  }

  /** Shell in the VM over the same SSH hop as the MCP transport. */
  async exec(vm: Vm, cmd: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
    return sshExec(vm, cmd, args, opts);
  }

  async putFile(vm: Vm, localPath: string, remotePath: string): Promise<void> {
    return sshPutFile(vm, localPath, remotePath);
  }

  async getFile(vm: Vm, remotePath: string, localPath: string): Promise<void> {
    return sshGetFile(vm, remotePath, localPath);
  }

  async cloneRepo(vm: Vm, repoUrl: string, destPath: string): Promise<void> {
    return sshCloneRepo(vm, repoUrl, destPath);
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
