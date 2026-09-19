/**
 * Shared SSH-into-VM transport for the VM-backed desktop adapters.
 *
 * Both the hyprland adapter (launch-hypr-mcp) and the x11 adapter
 * (launch-x11-mcp) drive a per-VM MCP server that lives inside the VM:
 *
 *   ssh -T <opts> -o ProxyCommand='ssh <jump-opts> -W %h:%p <jump>' \
 *       root@<vm.ip> <in-vm-launcher>
 *
 * The Proxmox host key and the VM root key are installed at golden build;
 * `-T` keeps stdio clean for MCP. Env-gated so operators can point at other
 * hosts/users without recompiling: VMHUB_JUMP_HOST (default 192.168.1.220;
 * any ssh alias or user@host), VMHUB_JUMP_USER, VMHUB_SSH_USER (default root),
 * VMHUB_SSH_KEY (identity file for both hops).
 *
 * Adapters keep their own IN_VM_LAUNCHER constant (the launcher path differs
 * per golden); everything else about the transport is shared.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Vm } from '../src/shared/types.ts';
import { vmError } from '../src/mcp/errors.ts';

/** SSH user for VM transport (root by default; cloud-init injects the key). */
export function vmSshUser(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_SSH_USER ?? 'root';
}

/**
 * The Proxmox host every VM connection hops through.
 *
 * VMHUB_JUMP_HOST may be a bare host/IP, `user@host`, or an ~/.ssh/config
 * alias. The host is often only reachable over Tailscale (e.g. `vmhub-1`),
 * so nothing here assumes the LAN. VMHUB_JUMP_USER picks the jump user
 * (falls back to VMHUB_SSH_USER, then root).
 */
export function sshJumpTarget(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.VMHUB_JUMP_HOST ?? '192.168.1.220';
  if (host.includes('@')) return host;
  const user = env.VMHUB_JUMP_USER ?? env.VMHUB_SSH_USER ?? 'root';
  return `${user}@${host}`;
}

/** Options shared by every hop: never prompt, fail fast, notice dead links. */
function commonOpts(env: NodeJS.ProcessEnv): string[] {
  // A dedicated ssh_config lets each hop use its own key/route (e.g. reach
  // the host through a LAN jump, guests with the golden's key).
  const opts = env.VMHUB_SSH_CONFIG ? ['-F', env.VMHUB_SSH_CONFIG] : [];
  opts.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4');
  if (env.VMHUB_SSH_KEY) opts.push('-i', env.VMHUB_SSH_KEY, '-o', 'IdentitiesOnly=yes');
  return opts;
}

/**
 * Options for the hop onto the Proxmox host. Connections are multiplexed
 * (ControlMaster) so each tool call does not pay a fresh handshake — over a
 * relayed Tailscale path that is the difference between 0.2s and 3s.
 */
export function jumpHostOpts(env: NodeJS.ProcessEnv = process.env): string[] {
  const opts = [...commonOpts(env), '-o', 'StrictHostKeyChecking=accept-new'];
  if (env.VMHUB_SSH_MULTIPLEX !== '0') {
    const dir = env.VMHUB_SSH_CONTROL_DIR ?? `${homedir()}/.ssh`;
    opts.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${dir}/vmhub-%C`, '-o', 'ControlPersist=10m');
  }
  return opts;
}

/** ssh argv (minus the remote command) for a shell on the Proxmox host itself. */
export function sshHostArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['-T', ...jumpHostOpts(env), sshJumpTarget(env)];
}

/**
 * Options for the hop into a lease VM. Clones reuse IPs from the static
 * pool, so the guest's host key legitimately changes between leases: it is
 * never recorded (UserKnownHostsFile=/dev/null) — the jump hop is the
 * authenticated one.
 */
export function vmHopOpts(env: NodeJS.ProcessEnv = process.env): string[] {
  // ssh expands %-tokens inside ProxyCommand itself, so the jump hop's own
  // tokens (ControlPath=…%C) must be escaped to reach the inner ssh intact.
  const inner = jumpHostOpts(env).map((o) => o.replace(/%/g, '%%'));
  const proxy = ['ssh', ...inner, '-W', '%h:%p', sshJumpTarget(env)].join(' ');
  return [
    ...commonOpts(env),
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', `ProxyCommand=${proxy}`,
  ];
}

function requireIp(vm: Vm): string {
  if (vm.status === 'error' || vm.status === 'destroyed') {
    throw vmError('PROVISION_FAILED', `VM ${vm.uuid} does not exist on Proxmox — provisioning may have failed`);
  }
  if (!vm.ip) {
    throw vmError('INTERNAL', `vmhub transport: VM ${vm.uuid} has no ip — the static NAT address is unset`);
  }
  return vm.ip;
}

/** ssh argv for one VM: `-T <opts> -o ProxyCommand=… root@<ip>`. */
export function sshIntoVmArgs(vm: Vm, env: NodeJS.ProcessEnv = process.env): string[] {
  return ['-T', ...vmHopOpts(env), `${vmSshUser(env)}@${vm.ip ?? ''}`];
}

/** scp argv prefix for one VM; append `src dst` using {@link scpRemote} for the VM side. */
export function scpVmArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['-q', '-r', ...vmHopOpts(env)];
}

/** `user@ip:path` for scp. */
export function scpRemote(vm: Vm, path: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${vmSshUser(env)}@${requireIp(vm)}:${path}`;
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
  requireIp(vm);
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
// Port tunnels — reach an in-VM TCP service (CursorTouch :8000, adb :5555)
// without a route to the guest network. `ssh -N -L 127.0.0.1:<free>:<ip>:<port>`
// through the Proxmox host; one tunnel per (vm, port), closed on release.
// ---------------------------------------------------------------------------

interface Tunnel {
  localPort: number;
  child: ChildProcess;
}

const tunnels = new Map<string, Tunnel>();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/**
 * Local port forwarded to `<vm.ip>:<remotePort>`. Reuses a live tunnel.
 * Set VMHUB_DIRECT_GUEST_NET=1 when this machine routes 10.10.10.0/24
 * itself (e.g. vmhub-mcp running on the Proxmox host) to skip tunnelling.
 */
export async function vmTunnel(vm: Vm, remotePort: number, env: NodeJS.ProcessEnv = process.env): Promise<{ host: string; port: number }> {
  const ip = requireIp(vm);
  if (env.VMHUB_DIRECT_GUEST_NET === '1') return { host: ip, port: remotePort };
  const key = `${vm.uuid}:${remotePort}`;
  const live = tunnels.get(key);
  if (live && live.child.exitCode === null && (await portOpen(live.localPort))) {
    return { host: '127.0.0.1', port: live.localPort };
  }
  live?.child.kill();
  const localPort = await freePort();
  const child = spawn('ssh', ['-N', ...jumpHostOpts(env), '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${localPort}:${ip}:${remotePort}`, sshJumpTarget(env)], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  tunnels.set(key, { localPort, child });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    if (await portOpen(localPort)) return { host: '127.0.0.1', port: localPort };
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  tunnels.delete(key);
  throw vmError('INTERNAL', `vmhub transport: tunnel to ${ip}:${remotePort} via ${sshJumpTarget(env)} failed${stderr ? `: ${stderr.trim()}` : ''}`,
    'Check that the Proxmox host is reachable over SSH (VMHUB_JUMP_HOST) and the in-VM service is listening.');
}

/** Close every tunnel held for a VM (called from adapter releaseConnection). */
export function closeVmTunnels(vm: Pick<Vm, 'uuid'>): void {
  for (const [key, t] of tunnels) {
    if (key.startsWith(`${vm.uuid}:`)) {
      t.child.kill();
      tunnels.delete(key);
    }
  }
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
