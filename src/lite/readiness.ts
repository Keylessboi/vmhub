/**
 * Desktop readiness gate for the lease lifecycle (issue #3).
 *
 * A lease is only "ready" once the in-VM desktop can actually be driven. The
 * x11 golden runs an autologin Xorg+openbox session; right after power-on the
 * desktop takes a moment to appear, so an agent that screenshots immediately
 * races the boot. checkDesktopReady probes the desktop over SSH with
 * `pgrep -x openbox` and reports ready only when the probe exits 0.
 *
 * The probe runs through the shared transport (sshIntoVmArgs → the same
 * ProxyJump SSH path the adapters use), so the transport doctrine — VMHUB_SSH_USER
 * / VMHUB_JUMP_HOST env overrides, static NAT IP, -T stdio — holds here too.
 *
 * Injected execFile is callback-style (the signature promisify(execFile) uses);
 * the default is promisify(execFile) itself. The probe normalizes both calling
 * conventions: it passes the callback AND handles a returned thenable, so an
 * injected mock (void, callback-style) and the real promisified execFile
 * (promise, callback ignored) both drive the same retry loop. A hard overall
 * setTimeout bound guarantees the gate never hangs past timeoutMs.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Vm } from '../shared/types.ts';
import { sshIntoVmArgs } from '../../adapters/transport.ts';

export interface ReadinessOpts {
  /** execFile probe override (callback style, as promisify uses). Defaults to promisify(execFile). */
  execFile?: unknown;
  /** Number of probe attempts before giving up. Default 30. */
  retries?: number;
  /** Per-attempt ssh timeout, ms. A cold clone has no sshd for the first
   *  ~30s, so each probe must fail FAST (hung TCP connect, not a 120s
   *  hang) or the gate would burn its whole bound on one attempt and
   *  report 'error' on a perfectly healthy VM. Default 10000. */
  attemptTimeoutMs?: number;
  /** Sleep between failed probes, ms. Without backoff a cold clone's
   *  connection-refused probes (each fails in ~200ms) burn all retries in
   *  seconds — before sshd (~23s) or openbox (~27s) ever appear — and the
   *  gate reports 'error' on a perfectly healthy VM. Default 2000ms gives
   *  30 retries × ~2.2s ≈ 66s of coverage, past a full cold boot. */
  probeDelayMs?: number;
  /** Hard bound for the whole gate. Default 120000ms (a cold clone's desktop
   *  takes ~25-30s to appear after power-on — SSH +23s, openbox +27s — so the
   *  gate must outlast a full boot, not just a warm desktop). */
  timeoutMs?: number;
}

const DEFAULT_RETRIES = 30;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_DELAY_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;

/** callback shape promisify(execFile) exposes: (err, {stdout, stderr}). */
type ExecFileCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;
type ExecFileLike = (file: string, args: string[], opts: unknown, cb: ExecFileCb) => unknown;

const defaultExecFile: unknown = promisify(execFile);

/** Run one ssh `pgrep -x openbox` probe. Resolves true only on exit 0. */
function probeOnce(execFileLike: ExecFileLike, args: string[], attemptTimeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(ready);
      }
    };
    let returned: unknown;
    try {
      returned = execFileLike('ssh', args, { timeout: attemptTimeoutMs }, (err: Error | null) => {
        // callback-style probe: exit 0 → no error → desktop is up.
        finish(err === null);
      });
    } catch {
      finish(false);
      return;
    }
    // promisify(execFile) ignores the callback and returns a thenable; resolve
    // through that path when the probe is promise-style.
    if (returned && typeof (returned as Promise<unknown>).then === 'function') {
      (returned as Promise<unknown>).then(
        () => finish(true),
        () => finish(false),
      );
    }
  });
}

/**
 * True when the VM's desktop (openbox) is up, false when the probe never
 * succeeds within retries or the hard timeoutMs bound. A VM without an IP
 * cannot be probed and is treated as not ready.
 */
export function checkDesktopReady(vm: Vm, opts: ReadinessOpts = {}): Promise<boolean> {
  const execFileLike = (opts.execFile ?? defaultExecFile) as ExecFileLike;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const probeDelayMs = opts.probeDelayMs ?? DEFAULT_PROBE_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = [...sshIntoVmArgs(vm), 'pgrep', '-x', 'openbox'];

  return new Promise<boolean>((resolve) => {
    let attempts = 0;
    let settled = false;
    const finish = (ready: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(bound);
        resolve(ready);
      }
    };
    // Hard bound: even a probe that never calls back cannot hang the gate.
    const bound = setTimeout(() => finish(false), timeoutMs);

    const tryProbe = (): void => {
      if (settled) return;
      attempts += 1;
      probeOnce(execFileLike, args, attemptTimeoutMs).then((ready) => {
        if (settled) return;
        if (ready) {
          finish(true);
          return;
        }
        if (attempts >= retries) {
          finish(false);
          return;
        }
        // Backoff: a cold clone refuses ssh for ~23s — retry without pause
        // would burn every retry in seconds and fail before the desktop.
        setTimeout(tryProbe, probeDelayMs);
      });
    };
    tryProbe();
  });
}
