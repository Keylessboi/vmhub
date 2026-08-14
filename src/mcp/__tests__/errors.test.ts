/**
 * errors.ts unit tests — the typed error contract + MCP result envelopes.
 * Pure logic, no host needed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HINT,
  err,
  errorResult,
  isVmError,
  makeVmError,
  ok,
  okResult,
  toVmError,
  vmError,
} from '../errors.ts';

describe('vmError / makeVmError', () => {
  it('builds a typed VmError with code + message', () => {
    const e = vmError('NOT_FOUND', 'template nope not found');
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('template nope not found');
    expect(e.retryable).toBe(false);
    expect(e.hint).toBe('no-retry');
  });

  it('marks retryable codes correctly', () => {
    expect(vmError('INTERNAL', 'x').retryable).toBe(true);
    expect(vmError('LOCK_CONTENTION', 'x').retryable).toBe(true);
    expect(vmError('HOST_CAPACITY', 'x').retryable).toBe(true);
    expect(vmError('QUOTA_EXCEEDED', 'x').retryable).toBe(true);
    expect(vmError('NOT_FOUND', 'x').retryable).toBe(false);
    expect(vmError('INVALID_REQUEST', 'x').retryable).toBe(false);
  });

  it('carries the default hint per code', () => {
    for (const [code, hint] of Object.entries(DEFAULT_HINT)) {
      expect(vmError(code as keyof typeof DEFAULT_HINT, 'x').hint).toBe(hint);
    }
  });

  it('includes detail when provided', () => {
    const e = vmError('DISK_FULL', 'no space', '15% refusal');
    expect(e.detail).toBe('15% refusal');
  });
});

describe('toVmError', () => {
  it('passes through an existing VmError untouched', () => {
    const original = vmError('NOT_FOUND', 'gone');
    expect(toVmError(original, 'ctx')).toBe(original);
  });

  it('wraps an Error into INTERNAL with context', () => {
    const e = toVmError(new Error('boom'), 'vm_list_templates');
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toContain('vm_list_templates');
    expect(e.message).toContain('boom');
  });

  it('wraps non-Error values as strings', () => {
    const e = toVmError('just a string', 'ctx');
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toContain('just a string');
  });
});

describe('isVmError', () => {
  it('recognizes a well-formed VmError', () => {
    expect(isVmError(vmError('INTERNAL', 'x'))).toBe(true);
  });

  it('rejects plain objects and errors', () => {
    expect(isVmError({})).toBe(false);
    expect(isVmError(new Error('x'))).toBe(false);
    expect(isVmError(null)).toBe(false);
    expect(isVmError('nope')).toBe(false);
  });
});

describe('MCP result envelopes', () => {
  it('ok() marks success and measures ms', () => {
    const start = Date.now() - 5;
    const r = ok('vm_health', { alive: true }, start);
    expect(r.ok).toBe(true);
    expect(r.action).toBe('vm_health');
    expect(r.result).toEqual({ alive: true });
    expect(typeof r.ms).toBe('number');
  });

  it('err() marks failure and carries the typed error', () => {
    const start = Date.now();
    const e = vmError('NOT_FOUND', 'gone');
    const r = err('vm_screenshot', e, start);
    expect(r.ok).toBe(false);
    expect(r.action).toBe('vm_screenshot');
    expect(r.error).toEqual(e);
  });

  it('okResult() returns a text content block + structuredContent', () => {
    const r = okResult('vm_list_templates', { templates: [] }, Date.now());
    expect(r.structuredContent.ok).toBe(true);
    const block = r.content[0];
    expect(block?.type).toBe('text');
    expect(JSON.parse(block?.text as string)).toEqual({ templates: [] });
  });

  it('errorResult() is marked isError and serializes the error', () => {
    const e = vmError('INVALID_REQUEST', 'bad input');
    const r = errorResult('vm_lease_create', e, Date.now());
    expect(r.isError).toBe(true);
    expect(r.structuredContent.ok).toBe(false);
    const text = r.content[0]?.text;
    expect(typeof text).toBe('string');
    const parsed = JSON.parse(text as string);
    expect(parsed.code).toBe('INVALID_REQUEST');
  });
});
