/**
 * vmhub-mcp error contract.
 *
 * Every failure path in this server produces a typed VmError (the shape from
 * src/shared/types.ts). Errors are NEVER thrown as bare strings or generic
 * Error objects across the tool boundary — agents branch on `code` and `hint`.
 */
import type { ErrorCode, VmError } from '../shared/types.ts';
import { DEFAULT_HINT } from '../shared/types.ts';

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
    // Default to the per-code recovery prose, never the bare 'no-retry' token:
    // an agent that reads hint:"no-retry" learns nothing about what to do next.
    hint: opts.hint ?? DEFAULT_HINT[code] ?? 'no-retry',
    ...(opts.detail !== undefined ? { detail: opts.detail } : {}),
  };
}

/**
 * Default hints per code — re-exported from shared so vmhub-lite and
 * vmhub-mcp hand agents identical recovery guidance for the same code.
 */
export { DEFAULT_HINT } from '../shared/types.ts';

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

/**
 * Convenience error for a tool the VM's adapter cannot serve.
 *
 * `capableAdapters` are ADAPTER ids ("hyprland", "x11", ...), which are not
 * leasable template ids — the live catalog keys templates by Proxmox VMID
 * ("2070"). The guidance therefore points at the `os` field of
 * vm_list_templates rather than naming ids the agent cannot pass back.
 */
export function capabilityUnavailableError(
  tool: string,
  currentAdapter: string,
  requiredCapability: string,
  capableAdapters: string[],
): VmError {
  const alternatives = capableAdapters.length > 0
    ? ` Lease a template whose "os" is one of: ${capableAdapters.join(', ')}.`
    : ` No registered adapter provides "${requiredCapability}".`;
  return vmError(
    'CAPABILITY_UNAVAILABLE',
    `${tool} requires capability "${requiredCapability}", which adapter "${currentAdapter}" does not provide.${alternatives}`,
    `Call vm_list_templates and pick a template that lists "${requiredCapability}" in its capabilities, then pass that template's "id" to vm_lease_create.`,
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
