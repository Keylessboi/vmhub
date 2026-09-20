/**
 * ssh-ops tests — the remote-script builder and the bounded local runner.
 * No SSH: runBounded is exercised against local bash.
 */
import { describe, expect, it } from 'vitest';
import { buildRemoteScript, capTail, runBounded, shq } from './ssh-ops.ts';

describe('shq', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
    expect(shq('$(id)')).toBe(`'$(id)'`);
  });
});

describe('buildRemoteScript', () => {
  it('runs the command under bash -c, quoting extra args', () => {
    expect(buildRemoteScript('ls', ['a b'], {})).toBe(`bash -c 'ls '\\''a b'\\'''`);
  });

  it('round-trips through a real shell with cwd', async () => {
    const script = buildRemoteScript('pwd && echo "$0" | wc -c', [], { cwd: '/tmp' });
    const res = await runBounded('bash', ['-c', script], { timeoutMs: 5000, outputCap: 1000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe('/tmp');
  });

  it('detaches under nohup and reports pid + log', async () => {
    const script = buildRemoteScript('sleep 0.1; echo done', [], { detach: true }, 42);
    const res = await runBounded('bash', ['-c', script], { timeoutMs: 5000, outputCap: 1000 });
    expect(res.stdout).toMatch(/^pid=\d+ log=\/tmp\/vmhub-bg-42\.log/);
  });
});

describe('runBounded', () => {
  it('returns the real exit code and both streams', async () => {
    const res = await runBounded('bash', ['-c', 'echo out; echo err >&2; exit 7'], { timeoutMs: 5000, outputCap: 1000 });
    expect(res).toMatchObject({ exitCode: 7, stdout: 'out\n', stderr: 'err\n', timedOut: false, truncated: false });
  });

  it('feeds stdin', async () => {
    const res = await runBounded('cat', [], { timeoutMs: 5000, outputCap: 1000, stdin: 'hello' });
    expect(res.stdout).toBe('hello');
  });

  it('kills at the timeout and says so', async () => {
    const res = await runBounded('sleep', ['5'], { timeoutMs: 200, outputCap: 1000 });
    expect(res.timedOut).toBe(true);
    expect(res.stderr).toContain('timeout');
  });

  it('keeps the tail of oversized output', async () => {
    const res = await runBounded('bash', ['-c', 'seq 1 20000'], { timeoutMs: 5000, outputCap: 100 });
    expect(res.truncated).toBe(true);
    expect(res.stdout.trimEnd().endsWith('20000')).toBe(true);
  });
});

describe('capTail', () => {
  it('passes short text through', () => {
    expect(capTail('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });
});
