/**
 * Shared SSH-into-VM transport for the VM-backed desktop adapters.
 *
 * Both the hyprland adapter (launch-hypr-mcp) and the x11 adapter
 * (launch-x11-mcp) drive a per-VM MCP server that lives inside the VM:
 *
 *   ssh -T -o StrictHostKeyChecking=no \
 *       -o ProxyJump=<jump> root@<vm.ip> <in-vm-launcher>
 *
 * The Proxmox host key and the VM root key are installed at golden build;
 * `-T` keeps stdio clean for MCP. Env-gated so operators can point at other
 * hosts/users without recompiling: VMHUB_JUMP_HOST (default 192.168.1.220),
 * VMHUB_SSH_USER (default root).
 *
 * Adapters keep their own IN_VM_LAUNCHER constant (the launcher path differs
 * per golden); everything else about the transport is shared.
 */
import { execFile } from 'node:child_process';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Vm } from '../src/shared/types.ts';
import { vmError } from '../src/mcp/errors.ts';

/** SSH user for VM transport (root by default; cloud-init injects the key). */
export function vmSshUser(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_SSH_USER ?? 'root';
}

/** ProxyJump target through the Proxmox host: "root@192.168.1.220" by default. */
export function sshJumpTarget(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.VMHUB_JUMP_HOST ?? '192.168.1.220';
  return `${vmSshUser(env)}@${host}`;
}

/** ssh argv for one VM: `-T -o StrictHostKeyChecking=no -o ProxyJump=… root@<ip>`. */
export function sshIntoVmArgs(vm: Vm, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    '-T',
    '-o', 'StrictHostKeyChecking=no',
    '-o', `ProxyJump=${sshJumpTarget(env)}`,
    `${vmSshUser(env)}@${vm.ip ?? ''}`,
  ];
}

/**
 * Per-VM MCP stdio transport: SSH through the Proxmox host into the VM and
 * run the in-VM MCP launcher there. Requires vm.ip (the static NAT address
 * lite assigns at clone time) — there is no local-desktop fallback for
 * VM-backed adapters.
 *
 * `env` prefixes the launcher with KEY=value assignments on the remote
 * command line. Some golden launchers omit session variables (e.g. the x11
 * launcher leaves XDG_SESSION_TYPE unset, which disables the X11/EWMH window
 * backend); the adapter can restore them without touching the golden.
 */
export function vmSshMcpTransport(
  vm: Vm,
  launcher: string,
  env: NodeJS.ProcessEnv = process.env,
  envPrefix: Record<string, string> = {},
): StdioClientTransport {
  if (vm.status === 'error' || vm.status === 'destroyed') {
    throw vmError('PROVISION_FAILED', `VM ${vm.uuid} does not exist on Proxmox — provisioning may have failed`);
  }
  if (!vm.ip) {
    throw new Error(`vmhub transport: VM ${vm.uuid} has no ip — the static NAT address is unset`);
  }
  const prefix = Object.entries(envPrefix)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const remoteCommand = prefix ? `${prefix} ${launcher}` : launcher;
  return new StdioClientTransport({
    command: 'ssh',
    args: [...sshIntoVmArgs(vm, env), remoteCommand],
  });
}

// ---------------------------------------------------------------------------
// SSH command runner — the exec/scp/git channel for VM-backed adapters
//
// macos and ios drive exec, file transfer and git over plain ssh/scp argv
// (never a shell string). The runner is injected so unit tests fake it and
// never touch a live host; production uses node:child_process execFile.
// ---------------------------------------------------------------------------

/** Result of one runner invocation — the exec contract with an exit code. */
export interface SshRunResult {
  exitCode: number;
  /** Binary when the caller requested `encoding: 'buffer'` (screenshots). */
  stdout: string | Buffer;
  stderr: string;
}

export interface SshRunOptions {
  encoding?: 'utf8' | 'buffer';
  timeoutMs?: number;
}

/** Minimal argv runner injected into the ssh-backed adapters. */
export interface SshRunner {
  run(bin: string, args: string[], opts?: SshRunOptions): Promise<SshRunResult>;
}

/** ExecFile wrapper typed for both encodings (no shell, argv-only). */
function execFileP(
  bin: string,
  args: string[],
  opts: { encoding: 'utf8' | 'buffer'; timeoutMs?: number },
): Promise<{ stdout: string | Buffer; stderr: string }> {
  const MAX = 256 * 1024 * 1024;
  const done = (
    resolve: (v: { stdout: string | Buffer; stderr: string }) => void,
    reject: (e: unknown) => void,
    err: unknown,
    stdout: string | Buffer,
    stderr: string,
  ): void => {
    if (err) {
      reject({ err, stdout, stderr });
      return;
    }
    resolve({ stdout, stderr });
  };
  return new Promise((resolve, reject) => {
    if (opts.encoding === 'buffer') {
      execFile(bin, args, { encoding: 'buffer', timeout: opts.timeoutMs, maxBuffer: MAX }, (err, stdout: Buffer, stderr: Buffer) =>
        done(resolve, reject, err, stdout, stderr.toString()),
      );
      return;
    }
    execFile(bin, args, { encoding: 'utf8', timeout: opts.timeoutMs, maxBuffer: MAX }, (err, stdout: string, stderr: string) =>
      done(resolve, reject, err, stdout, stderr),
    );
  });
}

/**
 * Default production runner: execFile, 30s bound, exit-code-preserving.
 * A nonzero exit is a normal result (not a throw) so adapters surface the
 * remote's own exit code and stderr to the agent.
 */
export const nodeSshRunner: SshRunner = {
  async run(bin, args, opts = {}) {
    const encoding = opts.encoding ?? 'utf8';
    try {
      const { stdout, stderr } = await execFileP(bin, args, { encoding, timeoutMs: opts.timeoutMs ?? 30_000 });
      return { exitCode: 0, stdout, stderr };
    } catch (e) {
      const err = e as { err?: { code?: number | string }; stdout?: string | Buffer; stderr?: string };
      return {
        exitCode: typeof err.err?.code === 'number' ? err.err.code : 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? (e instanceof Error ? e.message : String(e)),
      };
    }
  },
};
