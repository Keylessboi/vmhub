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
  CAPABILITY_UNAVAILABLE: 'pick a different template from vm_list_templates',
  QUOTA_EXCEEDED: 'wait 30s then retry, or release existing leases with vm_lease_release',
  HOST_CAPACITY: 'wait 60s for resources to free up, then retry',
  NODE_UNAVAILABLE: 'wait 30s then retry, or try a different node with vm_list_vms',
  DISK_FULL: 'release old leases with vm_lease_release, then retry vm_lease_create',
  BOOT_TIMEOUT: 'release the lease with vm_lease_release, then create a new one',
  LOCK_CONTENTION: 'wait 5s then retry, or release existing leases first',
  PROVISION_FAILED: 'release the lease with vm_lease_release, then create a new one',
  LEASE_EXPIRED: 'create a new lease with vm_lease_create',
  NOT_FOUND: 'verify the ID exists with vm_list_vms or vm_list_templates',
  ALREADY_EXISTS: 'this resource already exists — use the existing one',
  INVALID_REQUEST: 'check the tool parameters and try again',
  INTERNAL: 'retry once, then report the error to your operator',
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

export function capabilityUnavailableError(
  tool: string,
  currentTemplate: string,
  requiredCapability: string,
  capableTemplates: string[],
): VmError {
  const alternatives = capableTemplates.length > 0
    ? ` Available templates with ${requiredCapability}: ${capableTemplates.join(', ')}`
    : ` No templates available with ${requiredCapability}`;
  return vmError(
    'CAPABILITY_UNAVAILABLE',
    `${tool} requires capability "${requiredCapability}" which template "${currentTemplate}" does not provide.${alternatives}`,
    `Pick a template from vm_list_templates that lists "${requiredCapability}" in its capabilities.`,
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
