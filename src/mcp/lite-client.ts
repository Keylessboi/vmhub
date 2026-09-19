/**
 * Thin REST client to vmhub-lite.
 *
 * Contract (from FINAL-PLAN §1.3): 8 endpoints — POST/GET/renew/DELETE leases,
 * GET templates, GET vms, POST/GET artifacts. Every response error is mapped
 * to a typed VmError (src/shared). request_id rides on POST /v1/leases so
 * retries with the same key return the same lease (lite dedupes).
 */
import type { ArtifactRecord, Lease, NetworkMode, NetworkPolicy, Template, Vm, VmError, VmSnapshot } from '../shared/types.ts';
import { LITE_TIMEOUT_MS, isVmError, makeVmError, vmError } from './errors.ts';

/** Default lite URL — override with VMHUB_LITE_URL. */
export const DEFAULT_LITE_URL = 'http://127.0.0.1:8787';

export function liteBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_LITE_URL ?? DEFAULT_LITE_URL;
}

export interface LeaseResponse {
  vm: Vm;
  lease: Lease;
}

export interface LiteClient {
  /** POST /v1/leases — create a lease (idempotent on request_id). */
  createLease(input: { templateId: string; owner: string; requestId: string; ttlMs?: number; network?: NetworkMode }): Promise<LeaseResponse>;
  /** GET /v1/leases/{id}. */
  getLease(leaseId: string): Promise<LeaseResponse>;
  /** POST /v1/leases/{id}/renew. */
  renewLease(leaseId: string, ttlMs?: number): Promise<Lease>;
  /** DELETE /v1/leases/{id}. */
  releaseLease(leaseId: string): Promise<void>;
  /** GET /v1/templates (lite's provisioning catalog; vm_list_templates uses the local matrix). */
  getTemplates(): Promise<Template[]>;
  /** GET /v1/vms — all VMs. */
  listVms(): Promise<Vm[]>;
  /** Resolve one VM by uuid; GET /v1/vms/{uuid} with list fallback. */
  getVm(vmUuid: string): Promise<Vm>;
  /** POST /v1/artifacts — register a lease-scratch artifact. */
  createArtifact(input: { leaseId: string; hostPath: string; sizeBytes: number }): Promise<ArtifactRecord>;
  /** GET /v1/artifacts/{id}. */
  getArtifact(id: string): Promise<ArtifactRecord>;
  /** POST /v1/vms/{uuid}/tool-calls/increment — drain protection. */
  incrementToolCalls(vmUuid: string): Promise<void>;
  /** POST /v1/vms/{uuid}/tool-calls/decrement — drain protection. */
  decrementToolCalls(vmUuid: string): Promise<void>;
  /** Lab controls (optional so older fakes/lite builds still type-check). */
  listSnapshots?(vmUuid: string): Promise<VmSnapshot[]>;
  createSnapshot?(vmUuid: string, input: { name: string; description?: string; withMemory?: boolean }): Promise<{ created: string; snapshots: VmSnapshot[] }>;
  rollbackSnapshot?(vmUuid: string, name: string): Promise<void>;
  deleteSnapshot?(vmUuid: string, name: string): Promise<void>;
  getNetwork?(vmUuid: string): Promise<NetworkPolicy>;
  setNetwork?(vmUuid: string, mode: NetworkMode): Promise<NetworkPolicy>;
}

export class HttpLiteClient implements LiteClient {
  constructor(
    private readonly baseUrl: string = liteBaseUrl(),
    private readonly requestIdProvider: () => string = () => crypto.randomUUID(),
  ) {}

  async createLease(input: { templateId: string; owner: string; requestId: string; ttlMs?: number; network?: NetworkMode }): Promise<LeaseResponse> {
    return this.request<LeaseResponse>('POST', '/v1/leases', {
      body: { template_id: input.templateId, owner: input.owner, request_id: input.requestId, ttl_ms: input.ttlMs, network: input.network },
      requestId: input.requestId,
      timeoutMs: 120_000,
    });
  }

  getLease(leaseId: string): Promise<LeaseResponse> {
    return this.request('GET', `/v1/leases/${encodeURIComponent(leaseId)}`);
  }

  renewLease(leaseId: string, ttlMs?: number): Promise<Lease> {
    return this.request<Lease>('POST', `/v1/leases/${encodeURIComponent(leaseId)}/renew`, {
      body: { ttl_ms: ttlMs },
    });
  }

  async releaseLease(leaseId: string): Promise<void> {
    await this.request('DELETE', `/v1/leases/${encodeURIComponent(leaseId)}`);
  }

  getTemplates(): Promise<Template[]> {
    return this.request('GET', '/v1/templates');
  }

  listVms(): Promise<Vm[]> {
    return this.request('GET', '/v1/vms');
  }

  async getVm(vmUuid: string): Promise<Vm> {
    try {
      return await this.request<Vm>('GET', `/v1/vms/${encodeURIComponent(vmUuid)}`);
    } catch (e) {
      if (isVmError(e) && e.code === 'NOT_FOUND') {
        // Fallback: some lite versions expose only the list endpoint.
        const vms = await this.listVms();
        const vm = vms.find((v) => v.uuid === vmUuid);
        if (!vm) throw vmError('NOT_FOUND', `vm ${vmUuid} not found`);
        return vm;
      }
      throw e;
    }
  }

  createArtifact(input: { leaseId: string; hostPath: string; sizeBytes: number }): Promise<ArtifactRecord> {
    return this.request<ArtifactRecord>('POST', '/v1/artifacts', {
      body: { lease_id: input.leaseId, host_path: input.hostPath, size_bytes: input.sizeBytes },
    });
  }

  getArtifact(id: string): Promise<ArtifactRecord> {
    return this.request('GET', `/v1/artifacts/${encodeURIComponent(id)}`);
  }

  async incrementToolCalls(vmUuid: string): Promise<void> {
    await this.request('POST', `/v1/vms/${encodeURIComponent(vmUuid)}/tool-calls/increment`);
  }

  async decrementToolCalls(vmUuid: string): Promise<void> {
    await this.request('POST', `/v1/vms/${encodeURIComponent(vmUuid)}/tool-calls/decrement`);
  }

  listSnapshots(vmUuid: string): Promise<VmSnapshot[]> {
    return this.request('GET', `/v1/vms/${encodeURIComponent(vmUuid)}/snapshots`);
  }

  createSnapshot(vmUuid: string, input: { name: string; description?: string; withMemory?: boolean }): Promise<{ created: string; snapshots: VmSnapshot[] }> {
    return this.request('POST', `/v1/vms/${encodeURIComponent(vmUuid)}/snapshots`, {
      body: { name: input.name, description: input.description, with_memory: input.withMemory },
      timeoutMs: 900_000,
    });
  }

  async rollbackSnapshot(vmUuid: string, name: string): Promise<void> {
    await this.request('POST', `/v1/vms/${encodeURIComponent(vmUuid)}/snapshots/${encodeURIComponent(name)}/rollback`, { timeoutMs: 900_000 });
  }

  async deleteSnapshot(vmUuid: string, name: string): Promise<void> {
    await this.request('DELETE', `/v1/vms/${encodeURIComponent(vmUuid)}/snapshots/${encodeURIComponent(name)}`, { timeoutMs: 300_000 });
  }

  getNetwork(vmUuid: string): Promise<NetworkPolicy> {
    return this.request('GET', `/v1/vms/${encodeURIComponent(vmUuid)}/network`, { timeoutMs: 60_000 });
  }

  setNetwork(vmUuid: string, mode: NetworkMode): Promise<NetworkPolicy> {
    return this.request('PUT', `/v1/vms/${encodeURIComponent(vmUuid)}/network`, { body: { mode }, timeoutMs: 120_000 });
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: Record<string, unknown>; requestId?: string; timeoutMs?: number } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(opts.requestId ? { 'x-request-id': opts.requestId } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? LITE_TIMEOUT_MS),
      });
    } catch (e) {
      throw makeVmError('INTERNAL', `vmhub-lite unreachable at ${this.baseUrl}`, {
        retryable: true,
        hint: 'wait-then-retry',
        detail: e instanceof Error ? e.message : String(e),
      });
    }

    const text = await res.text();
    const json = parseJson(text);

    if (!res.ok) {
      throw mapLiteError(res.status, json);
    }
    if (json === null) {
      throw vmError('INTERNAL', 'lite returned non-JSON response', text.slice(0, 500));
    }
    return json as T;
  }
}

/** Parse a lite error body {error: VmError} or fall back to status mapping. */
function mapLiteError(status: number, body: unknown): VmError {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const e = (body as { error: unknown }).error;
    if (isVmErrorLike(e)) return e as VmError;
  }
  switch (status) {
    case 400:
      return vmError('INVALID_REQUEST', `vmhub-lite rejected the request (HTTP ${status})`);
    case 404:
      return vmError('NOT_FOUND', `resource not found in vmhub-lite (HTTP ${status})`);
    case 409:
      return vmError('ALREADY_EXISTS', `conflict in vmhub-lite (HTTP ${status})`);
    case 422:
      return vmError('INVALID_REQUEST', `invalid payload in vmhub-lite (HTTP ${status})`);
    case 429:
      return vmError('QUOTA_EXCEEDED', `quota exceeded in vmhub-lite (HTTP ${status})`);
    case 503:
      return vmError('HOST_CAPACITY', `vmhub-lite at capacity (HTTP ${status})`);
    default:
      return vmError('INTERNAL', `vmhub-lite error (HTTP ${status})`);
  }
}

function isVmErrorLike(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
