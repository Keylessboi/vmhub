/**
 * readiness.ts contract tests — the lease readiness gate for issue #3.
 *
 * The module lands in T4b; until then every test fails with
 * "Cannot find module ./readiness.ts" — that is the expected RED phase.
 * The non-literal dynamic-import specifier keeps `bun run typecheck` green
 * while the file is absent.
 *
 * Contract the T4b implementation must satisfy:
 *   checkDesktopReady(vm, opts?): Promise<boolean>
 *     - probes the desktop over SSH with `pgrep -x openbox`
 *       (execFile('ssh', [...sshIntoVmArgs(vm), 'pgrep', '-x', 'openbox'], opts, cb))
 *     - opts.execFile  — injected execFile (callback style, as promisify uses)
 *     - opts.retries   — number of retries before giving up
 *     - opts.timeoutMs — hard bound: resolves false when the probe hangs
 *     - true only when the probe exits 0.
 */
import { describe, expect, it, vi } from 'vitest';
import { sshIntoVmArgs } from '../../adapters/transport.ts';
import type { Vm } from '../shared/types.ts';

const vm: Vm = {
  uuid: 'rdy-1',
  templateId: 'debian-13-golden',
  adapter: 'headless',
  capabilities: ['exec'],
  proxmoxTag: 'vmhub-rdy-rdy-1',
  namePrefix: 'rdy',
  status: 'ready',
  ip: '10.10.10.60',
  createdAt: 0,
};

type ExecFileLike = (file: string, args: string[], opts: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => void;

interface ReadinessOpts {
  execFile?: unknown;
  retries?: number;
  attemptTimeoutMs?: number;
  timeoutMs?: number;
}

interface ReadinessModule {
  checkDesktopReady(vm: Vm, opts?: ReadinessOpts): Promise<boolean>;
}

async function loadReadiness(): Promise<ReadinessModule> {
  return (await import('./readiness.ts' + '')) as ReadinessModule;
}

describe('checkDesktopReady (readiness gate)', () => {
  it('builds the ssh probe argv and succeeds when `pgrep -x openbox` exits 0', async () => {
    const { checkDesktopReady } = await loadReadiness();
    const execFile = vi.fn((_f: string, _a: string[], _o: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: '', stderr: '' });
    });
    const ready = await checkDesktopReady(vm, { execFile: execFile as unknown as ExecFileLike, retries: 3, timeoutMs: 500 });
    expect(ready).toBe(true);
    const call = execFile.mock.calls[0];
    expect(call?.[0]).toBe('ssh');
    expect(call?.[1]).toEqual(expect.arrayContaining([...sshIntoVmArgs(vm), 'pgrep', '-x', 'openbox']));
  });

  it('retries and reports not-ready when the desktop never comes up', async () => {
    const { checkDesktopReady } = await loadReadiness();
    const execFile = vi.fn((_f: string, _a: string[], _o: unknown, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
      cb(Object.assign(new Error('pgrep: no process found'), { code: 1 }), { stdout: '', stderr: '' });
    });
    const ready = await checkDesktopReady(vm, { execFile: execFile as unknown as ExecFileLike, retries: 3, timeoutMs: 500 });
    expect(ready).toBe(false);
    expect(execFile.mock.calls.length).toBeGreaterThan(1);
  });

  it('honors the injectable timeout when the probe never returns', async () => {
    const { checkDesktopReady } = await loadReadiness();
    const execFile = vi.fn(() => {});
    const ready = await checkDesktopReady(vm, { execFile: execFile as unknown as ExecFileLike, retries: 3, timeoutMs: 50 });
    expect(ready).toBe(false);
  });

  it('a hung first attempt does not burn the whole bound — a later attempt can still flip ready', async () => {
    // A cold clone has no sshd for the first ~30s; the first ssh connect can
    // hang. The per-attempt timeout must fail that attempt fast and let the
    // retry loop continue until the desktop is reachable.
    const { checkDesktopReady } = await loadReadiness();
    const timers: NodeJS.Timeout[] = [];
    const execFile = vi.fn(
      (_f: string, _a: string[], opts: { timeout?: number }, cb: (err: Error | null, out: { stdout: string; stderr: string }) => void) => {
        // emulate execFile's own timeout option: if cb never fires, call it
        // with a timeout error after opts.timeout.
        const t = setTimeout(() => cb(Object.assign(new Error('killed'), { killed: true }), { stdout: '', stderr: '' }), opts.timeout);
        timers.push(t);
        if (execFile.mock.calls.length >= 2) {
          clearTimeout(t);
          cb(null, { stdout: '', stderr: '' });
        }
      },
    );
    const ready = await checkDesktopReady(vm, { execFile: execFile as unknown as ExecFileLike, retries: 5, attemptTimeoutMs: 30, timeoutMs: 500 });
    expect(ready).toBe(true);
    expect(execFile.mock.calls.length).toBe(2);
    // each attempt carries the per-attempt timeout, not the full bound
    for (const [, , opts] of execFile.mock.calls) {
      expect((opts as { timeout: number }).timeout).toBe(30);
    }
    for (const t of timers) clearTimeout(t);
  });
});
