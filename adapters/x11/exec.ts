/**
 * X11 exec transport — run commands inside the x11 golden VM over the shared
 * SSH transport (same pattern as the headless adapter).
 *
 * The golden VM installs /usr/local/bin/vmhub-exec at build time; it wraps
 * commands in the autologin Xorg session environment (DISPLAY, XAUTHORITY,
 * DBUS_SESSION_BUS_ADDRESS) so window-management verbs (wmctrl) work against
 * the real desktop instead of the SSH "tty" context. This module only builds
 * the ssh argv; the adapter never shells out itself.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecResult, Vm } from '../../src/shared/types.ts';
import { vmError } from '../../src/mcp/errors.ts';
import { sshIntoVmArgs } from '../transport.ts';

/** In-VM exec helper installed at golden build. */
export const IN_VM_EXEC = '/usr/local/bin/vmhub-exec';

const execFileP = promisify(execFile);

/** ssh argv + in-VM vmhub-exec helper + command: the exec transport. */
export function vmhubExecArgs(vm: Vm, cmd: string, args: string[] = []): string[] {
  return [...sshIntoVmArgs(vm), IN_VM_EXEC, cmd, ...args];
}

/** wmctrl close args: -ic for a window id (decimal or 0x-hex), -c for a title. */
export function x11CloseArgs(window: string): string[] {
  return /^(0x[0-9a-fA-F]+|\d+)$/.test(window) ? ['wmctrl', '-ic', window] : ['wmctrl', '-c', window];
}

/** Run a command in the VM; ssh failures become an ExecResult, never a throw. */
export async function execInVm(vm: Vm, cmd: string, args: string[] = []): Promise<ExecResult> {
  if (!vm.ip) {
    throw vmError('INTERNAL', `x11 adapter: VM ${vm.uuid} has no ip — cannot run exec`);
  }
  try {
    const { stdout, stderr } = await execFileP('ssh', vmhubExecArgs(vm, cmd, args), { timeout: 30_000 });
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
