/**
 * Chunked polling — the ONLY wait primitive in vmhub-mcp.
 *
 * opencode's client timeout is 30000ms; the plan freezes every wait at ≤20s so
 * a tool always returns inside the bound with an explicit timedOut flag and
 * the caller re-invokes (idempotent, request_id-carried) instead of hanging.
 */
export const POLL_BOUND_MS = 20_000;
export const POLL_INTERVAL_MS = 500;

export interface PollOutcome<T> {
  value: T;
  timedOut: boolean;
  polls: number;
  elapsedMs: number;
  estimatedRemainingMs: number;
}

/**
 * Poll `fn` until `isDone` is true or `timeoutMs` elapses.
 * Always bounded: the caller passes wait_ms from tool args, clamped to
 * POLL_BOUND_MS. Never sleeps longer than intervalMs per chunk.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  isDone: (value: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PollOutcome<T>> {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? POLL_BOUND_MS, 0), POLL_BOUND_MS);
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const startTime = Date.now();
  let polls = 0;

  for (;;) {
    const value = await fn();
    polls += 1;
    const elapsedMs = Date.now() - startTime;
    const remainingMs = Math.max(0, deadline - Date.now());
    if (isDone(value) || Date.now() >= deadline) {
      return { value, timedOut: !isDone(value), polls, elapsedMs, estimatedRemainingMs: 0 };
    }
    await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 1)));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
