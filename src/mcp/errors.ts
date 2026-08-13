/**
 * vmhub-mcp error contract.
 *
 * Every failure path in this server produces a typed VmError (the shape from
 * src/shared/types.ts). Errors are NEVER thrown as bare strings or generic
 * Error objects across the tool boundary — agents branch on `code` and `hint`.
 */
import type { ErrorCode, VmError } from '../shared/types.ts';

/** Millis to wait for a lite response before treating it as unreachable. */
export const LITE_TIMEOUT_MS = 10_000;

export function makeVmError(
  code: ErrorCode,
  message: string,
  opts: Partial<Pick<VmError, 'retryable' | 'hint' | 'detail'>> = {},
): VmError {
  return {
    code,
    message,
    retryable: opts.retryable ?? false,
    hint: opts.hint ?? 'no-retry',
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
  };
}

/** Default hints per code — the agent-facing recovery guidance. */
export const DEFAULT_HINT: Record<ErrorCode, VmError['hint']> = {
  CAPABILITY_UNAVAILABLE: 'no-retry',
  QUOTA_EXCEEDED: 'wait-then-retry',
  HOST_CAPACITY: 'wait-then-retry',
  DISK_FULL: 'teardown-then-retry',
  BOOT_TIMEOUT: 'teardown-then-retry',
  LOCK_CONTENTION: 'retry-with-backoff',
  PROVISION_FAILED: 'teardown-then-retry',
  LEASE_EXPIRED: 'teardown-then-retry',
  NOT_FOUND: 'no-retry',
  ALREADY_EXISTS: 'no-retry',
  INVALID_REQUEST: 'no-retry',
  INTERNAL: 'one-retry-then-report',
};

/** Build a VmError for a code using the default retry/hint policy. */
export function vmError(code: ErrorCode, message: string, detail?: string): VmError {
  return makeVmError(code, message, {
    retryable: code === 'INTERNAL' || code === 'LOCK_CONTENTION' || code === 'HOST_CAPACITY' || code === 'QUOTA_EXCEEDED',
    hint: DEFAULT_HINT[code],
    detail,
  });
}

/** Wrap an arbitrary thrown value into a VmError (INTERNAL when unknown). */
export function toVmError(e: unknown, context: string): VmError {
  if (isVmError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return vmError('INTERNAL', `${context}: ${msg}`);
}

export function isVmError(e: unknown): e is VmError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    'message' in e &&
    'retryable' in e &&
    'hint' in e &&
    typeof (e as { code: unknown }).code === 'string'
  );
}

// ---------------------------------------------------------------------------
// MCP result envelopes (mirrors hyprland-mcp's ok/err pattern)
// ---------------------------------------------------------------------------

/** Success envelope: structured content carries the machine-readable payload. */
export function ok(action: string, result: Record<string, unknown>, start: number): Record<string, unknown> {
  return { ok: true, action, result, ms: Date.now() - start };
}

/** Error envelope: structured content carries the typed VmError. */
export function err(action: string, error: VmError, start: number): Record<string, unknown> {
  return { ok: false, action, error, ms: Date.now() - start };
}

/** MCP call result for a failed tool invocation. */
export function errorResult(action: string, error: VmError, start: number) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(error, null, 2) }],
    isError: true as const,
    structuredContent: err(action, error, start),
  };
}

/** MCP call result for a successful tool invocation. */
export function okResult(action: string, result: Record<string, unknown>, start: number, text?: string) {
  return {
    content: [{ type: 'text' as const, text: text ?? JSON.stringify(result, null, 2) }],
    structuredContent: ok(action, result, start),
  };
}
