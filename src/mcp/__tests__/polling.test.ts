/**
 * polling.ts unit tests — the bounded pollUntil primitive.
 * Uses tiny intervals so tests run fast; asserts the bound, timeout flag,
 * and poll counting. Pure logic, no host needed.
 */
import { describe, expect, it } from 'vitest';
import { POLL_BOUND_MS, POLL_INTERVAL_MS, pollUntil } from '../polling.ts';

describe('POLL_BOUND_MS / POLL_INTERVAL_MS constants', () => {
  it('freezes the bound at 20s and interval at 500ms', () => {
    expect(POLL_BOUND_MS).toBe(20_000);
    expect(POLL_INTERVAL_MS).toBe(500);
  });
});

describe('pollUntil', () => {
  it('returns immediately when isDone is already true', async () => {
    const calls = [];
    const out = await pollUntil(
      async () => { calls.push('fn'); return 42; },
      (v) => v === 42,
      { timeoutMs: 500, intervalMs: 1 },
    );
    expect(out.value).toBe(42);
    expect(out.timedOut).toBe(false);
    expect(out.polls).toBe(1);
    expect(calls.length).toBe(1);
  });

  it('polls until isDone becomes true', async () => {
    let n = 0;
    const out = await pollUntil(
      async () => { n += 1; return n; },
      (v) => v >= 3,
      { timeoutMs: 2000, intervalMs: 1 },
    );
    expect(out.value).toBeGreaterThanOrEqual(3);
    expect(out.timedOut).toBe(false);
    expect(out.polls).toBeGreaterThanOrEqual(3);
  });

  it('times out with timedOut=true when the bound is hit', async () => {
    const out = await pollUntil(
      async () => 'never-done',
      () => false,
      { timeoutMs: 100, intervalMs: 1 },
    );
    expect(out.timedOut).toBe(true);
    expect(out.value).toBe('never-done');
    expect(out.polls).toBeGreaterThan(1);
  });

  it('clamps timeoutMs to POLL_BOUND_MS (never exceeds the bound)', { timeout: 30_000 }, async () => {
    const out = await pollUntil(
      async () => 'x',
      () => false,
      { timeoutMs: 10_000_000, intervalMs: 1000 },
    );
    expect(out.timedOut).toBe(true);
    // Must return within ~20s bound; with 1s intervals this polls at most ~21 times.
    expect(out.polls).toBeLessThanOrEqual(25);
  });

  it('counts polls for audit', async () => {
    let calls = 0;
    const out = await pollUntil(
      async () => { calls += 1; return calls; },
      (v) => v >= 2,
      { timeoutMs: 1000, intervalMs: 1 },
    );
    expect(out.polls).toBe(calls);
  });
});
