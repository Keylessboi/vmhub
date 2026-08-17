/**
 * lite-client.ts unit tests — request building, error mapping, and the
 * getVm list-fallback. Uses a mocked fetch; no live lite server needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LITE_URL, HttpLiteClient, liteBaseUrl } from '../lite-client.ts';

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetch(): FetchMock {
  const m = vi.fn();
  // @ts-expect-error - global fetch override for tests
  globalThis.fetch = m;
  return m;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('liteBaseUrl', () => {
  it('defaults to 127.0.0.1:8787', () => {
    expect(liteBaseUrl({})).toBe(DEFAULT_LITE_URL);
  });

  it('honors VMHUB_LITE_URL', () => {
    expect(liteBaseUrl({ VMHUB_LITE_URL: 'http://10.0.0.9:9999' })).toBe('http://10.0.0.9:9999');
  });
});

describe('HttpLiteClient request building', () => {
  it('createLease sends POST /v1/leases with template_id/owner/request_id', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(201, { vm: { uuid: 'u1' }, lease: { vmId: 'u1' } }));

    const client = new HttpLiteClient('http://test');
    await client.createLease({ templateId: 'tpl', owner: 'me', requestId: 'req-1' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://test/v1/leases');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ template_id: 'tpl', owner: 'me', request_id: 'req-1', ttl_ms: undefined });
  });

  it('getLease URL-encodes the lease id', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(200, { vm: { uuid: 'u' }, lease: { vmId: 'u' } }));
    const client = new HttpLiteClient('http://test');
    await client.getLease('a/b c');
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('http://test/v1/leases/a%2Fb%20c');
  });

  it('sends the x-request-id header on lease create', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(201, { vm: { uuid: 'u' }, lease: { vmId: 'u' } }));
    const client = new HttpLiteClient('http://test');
    await client.createLease({ templateId: 't', owner: 'o', requestId: 'rid-42' });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.['x-request-id']).toBe('rid-42');
  });
});

describe('HttpLiteClient error mapping', () => {
  it('maps HTTP 404 to NOT_FOUND', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'gone', retryable: false, hint: 'no-retry' } }));
    const client = new HttpLiteClient('http://test');
    await expect(client.getLease('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('maps bare 409 to ALREADY_EXISTS', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(409, {}));
    const client = new HttpLiteClient('http://test');
    await expect(client.renewLease('x')).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('maps bare 503 to HOST_CAPACITY', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(jsonResponse(503, {}));
    const client = new HttpLiteClient('http://test');
    await expect(client.listVms()).rejects.toMatchObject({ code: 'HOST_CAPACITY' });
  });

  it('wraps a network failure as INTERNAL retryable', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new HttpLiteClient('http://test');
    await expect(client.listVms()).rejects.toMatchObject({ code: 'INTERNAL', retryable: true });
  });

  it('parses a non-JSON error body as a bare status mapping', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(new Response('not json', { status: 400 }));
    const client = new HttpLiteClient('http://test');
    await expect(client.createLease({ templateId: 't', owner: 'o', requestId: 'r' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('throws typed VmError for non-JSON 200 response', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(new Response('upstream returned html', { status: 200 }));
    const client = new HttpLiteClient('http://test');
    await expect(client.listVms()).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'lite returned non-JSON response',
    });
  });

  it('includes raw response text in VmError detail for non-JSON 200', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValue(new Response('<html>bad gateway</html>', { status: 200 }));
    const client = new HttpLiteClient('http://test');
    try {
      await client.listVms();
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'INTERNAL', detail: '<html>bad gateway</html>' });
    }
  });
});

describe('HttpLiteClient getVm fallback', () => {
  it('returns the VM from the list when the direct GET is 404', async () => {
    const fetchMock = mockFetch();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x', retryable: false, hint: 'no-retry' } }))
      .mockResolvedValueOnce(jsonResponse(200, [{ uuid: 'target', vmid: 5 }]));

    const client = new HttpLiteClient('http://test');
    const vm = await client.getVm('target');
    expect(vm.uuid).toBe('target');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const call = fetchMock.mock.calls[1];
    expect(call?.[0]).toBe('http://test/v1/vms');
  });

  it('throws NOT_FOUND when the VM is absent from the list too', async () => {
    const fetchMock = mockFetch();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x', retryable: false, hint: 'no-retry' } }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    const client = new HttpLiteClient('http://test');
    await expect(client.getVm('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not fall back on non-404 errors', async () => {
    const fetchMock = mockFetch();
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    const client = new HttpLiteClient('http://test');
    await expect(client.getVm('x')).rejects.toMatchObject({ code: 'HOST_CAPACITY' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
