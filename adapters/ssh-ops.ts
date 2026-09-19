/**
 * Shell, file and git operations for SSH-reachable Linux VMs (headless,
 * hyprland, x11). Every Linux golden accepts root over the same
 * ProxyCommand hop the desktop adapters already use, so one implementation
 * serves all three — the display adapters keep their in-VM MCP for pixels
 * and input, and gain a real shell alongside it.
 */
import { spawn } from 'node:child_process';
import type { ExecOptions, ExecResult, Vm } from '../src/shared/types.ts';
import { vmError } from '../src/mcp/errors.ts';
import { scpRemote, scpVmArgs, sshIntoVmArgs } from './transport.ts';

/** Per-stream output cap returned to the agent (the tail is kept). */
export const DEFAULT_OUTPUT_CAP = 200_000;
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 3_600_000;

/** POSIX single-quote a word for a remote shell. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Keep the last `cap` chars — errors and exit summaries live at the end. */
export function capTail(s: string, cap: number): { text: string; truncated: boolean } {
  if (s.length <= cap) return { text: s, truncated: false };
  return { text: `…[${s.length - cap} earlier chars truncated]…\n${s.slice(-cap)}`, truncated: true };
}

interface RunOpts {
  timeoutMs: number;
  stdin?: string | Buffer;
  outputCap: number;
}

/** Spawn a process, collect bounded output, enforce a hard timeout. */
export function runBounded(bin: string, args: string[], opts: RunOpts): Promise<ExecResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    // Keep at most 2x the cap in memory; capTail trims precisely at the end.
    const keep = (buf: string, d: Buffer): string => {
      const next = buf + d.toString('utf8');
      return next.length > opts.outputCap * 2 ? next.slice(-opts.outputCap * 2) : next;
    };
    child.stdout.on('data', (d: Buffer) => { out = keep(out, d); });
    child.stderr.on('data', (d: Buffer) => { err = keep(err, d); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.on('error', (e) => { err += String(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const o = capTail(out, opts.outputCap);
      const e = capTail(err, opts.outputCap);
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        stdout: o.text,
        stderr: timedOut ? `${e.text}\n[vmhub: killed after ${opts.timeoutMs}ms timeout]` : e.text,
        timedOut,
        truncated: o.truncated || e.truncated,
        durationMs: Date.now() - t0,
      });
    });
    child.stdin.on('error', () => {});
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

function requireReady(vm: Vm, what: string): void {
  if (!vm.ip) throw vmError('INTERNAL', `${what}: VM ${vm.uuid} has no ip — it was never provisioned`);
}

/** Wrap a command for the guest: optional cwd, optional nohup detach. */
export function buildRemoteScript(cmd: string, args: string[], opts: Pick<ExecOptions, 'cwd' | 'detach'>, now = Date.now()): string {
  const full = [cmd, ...args.map(shq)].join(' ');
  const script = opts.cwd ? `cd ${shq(opts.cwd)} && ${full}` : full;
  if (!opts.detach) return `bash -c ${shq(script)}`;
  const log = `/tmp/vmhub-bg-${now}.log`;
  return `bash -c ${shq(`nohup bash -c ${shq(script)} >${log} 2>&1 </dev/null & echo "pid=$! log=${log}"`)}`;
}

/**
 * Run a shell command in the VM. `cmd` is interpreted by the guest's
 * `bash -c` (so pipes, redirects and && work); `args`, when given, are
 * quoted and appended. With `detach`, the command is started under nohup
 * and the call returns immediately with its pid and log path.
 */
export async function sshExec(vm: Vm, cmd: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
  requireReady(vm, 'exec');
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_TIMEOUT_MS);
  const res = await runBounded('ssh', [...sshIntoVmArgs(vm), buildRemoteScript(cmd, args, opts)], {
    timeoutMs: opts.detach ? 60_000 : timeoutMs + 10_000,
    stdin: opts.stdin,
    outputCap: opts.outputCap ?? DEFAULT_OUTPUT_CAP,
  });
  // ssh itself exits 255 on connection failure; surface it as transport, not a command result.
  if (res.exitCode === 255 && /ssh:|ssh_|Connection|Permission denied|ProxyCommand|kex_exchange|Could not resolve|Host key|percent_expand|forwarding request failed|Session open refused|UNKNOWN port/i.test(res.stderr)) {
    throw vmError('INTERNAL', `exec: cannot reach VM ${vm.uuid} (${vm.ip}) over SSH: ${res.stderr.trim().slice(-500)}`,
      'The VM may still be booting (retry after vm_lease_status says ready), or the jump host is unreachable (check VMHUB_JUMP_HOST).');
  }
  return res;
}

/** Copy a host file or directory into the VM. */
export async function sshPutFile(vm: Vm, localPath: string, remotePath: string): Promise<void> {
  requireReady(vm, 'put_file');
  const res = await runBounded('scp', [...scpVmArgs(), localPath, scpRemote(vm, remotePath)], { timeoutMs: 1_800_000, outputCap: 20_000 });
  if (res.exitCode !== 0) {
    throw vmError('INTERNAL', `put_file ${localPath} -> ${remotePath} failed: ${res.stderr.trim().slice(-500)}`,
      'Check the local path exists and the remote directory exists (create it with vm_exec "mkdir -p").');
  }
}

/** Copy a file or directory out of the VM to a host path. */
export async function sshGetFile(vm: Vm, remotePath: string, localPath: string): Promise<void> {
  requireReady(vm, 'get_file');
  const res = await runBounded('scp', [...scpVmArgs(), scpRemote(vm, remotePath), localPath], { timeoutMs: 1_800_000, outputCap: 20_000 });
  if (res.exitCode !== 0) {
    throw vmError('INTERNAL', `get_file ${remotePath} -> ${localPath} failed: ${res.stderr.trim().slice(-500)}`,
      'Check the remote path with vm_exec "ls -la", and that the local parent directory exists.');
  }
}

/** git clone inside the VM (shallow — agents rarely need history). */
export async function sshCloneRepo(vm: Vm, repoUrl: string, destPath: string): Promise<void> {
  const res = await sshExec(
    vm,
    `command -v git >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git) >/dev/null 2>&1; git clone --depth 1 -- ${shq(repoUrl)} ${shq(destPath)}`,
    [],
    { timeoutMs: 900_000 },
  );
  if (res.exitCode !== 0) {
    throw vmError('INTERNAL', `clone_repo failed (exit ${res.exitCode}): ${res.stderr.trim().slice(-800)}`,
      'Private repos need credentials in the VM; check the URL and that the VM network mode allows internet.');
  }
}
