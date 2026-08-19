/**
 * vmhub-lite REST router — the control-plane HTTP surface.
 *
 * Shapes are locked to the vmhub-mcp thin REST client (src/mcp/lite-client.ts):
 *
 *   POST   /v1/leases           body {"template_id","owner","request_id"?,"ttl_ms"?}
 *                                → 201 {vm, lease} | 200 (idempotent replay of same request_id)
 *   GET    /v1/leases/{id}      → 200 {vm, lease} | 404
 *   POST   /v1/leases/{id}/renew body {"ttl_ms"?} → 200 lease | 404 | 410 LEASE_EXPIRED
 *   DELETE /v1/leases/{id}      → 200 {"vmId","status":"released"} (idempotent)
 *   GET    /v1/templates        → 200 Template[]   (plain array)
 *   GET    /v1/vms              → 200 Vm[]         (plain array)
 *   GET    /v1/vms/{uuid}       → 200 Vm | 404
 *   POST   /v1/artifacts        body {"lease_id","host_path","size_bytes"?}
 *                                → 201 ArtifactRecord
 *   GET    /v1/artifacts/{id}   → 200 ArtifactRecord | 404
 *
 * Errors are always a typed VmError wrapped as {"error": VmError} (code,
 * message, retryable, hint, detail). request_id idempotency: POST /v1/leases
 * with the same request_id (body request_id, or the x-request-id header)
 * returns the SAME lease on replay (200 instead of 201); the mapping survives
 * restarts via the leases table.
 *
 * Disk-full refusal: allocation endpoints (lease create, artifact register)
 * check free disk; below diskRefusalThresholdPct (15% default) they refuse
 * with DISK_FULL. The check is injected so tests can simulate a full disk.
 *
 * SECURITY: v1 has no auth layer. The server is expected to be bound to
 * 127.0.0.1 (see server.ts); never expose these routes on a network.
 */
import { statfsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ProxmoxClient } from "./proxmox.ts";
import { isVmError, vmError } from "../mcp/errors.ts";
import { DEFAULT_NODE_ID } from "../shared/schema.ts";
import type { NodeProbe, NodeRegistry, NodeProbeResult } from "./nodes.ts";
import { byDiskThenId, nodeSatisfiesTemplate, PerNodeLock } from "./nodes.ts";
import type { LeaseRow, LeaseStatus, LiteDb, VmRow } from "./db.ts";
import type {
  ArtifactRecord,
  ErrorCode,
  NodeStatus,
  Template,
  Vm,
  VmError,
  VmNode,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------
// Router dependencies + defaults
// ---------------------------------------------------------------------------

export interface RouterDeps {
  db: LiteDb;
  proxmox: ProxmoxClient;
  /** Multi-node registry + probe — when both are provided, leases route to a satisfying node. */
  nodes?: NodeRegistry;
  probe?: NodeProbe;
  /** Minimum free-disk percent a node must have to host a lease (multi-node). */
  nodeDiskFloorPct?: number;
  /** Free disk percentage (0-100) as reported for the allocation dir. */
  diskFreePct?: () => number;
  /** Allocation is refused when free space is below this percent. */
  diskRefusalThresholdPct?: number;
  /** Default lease length when the request does not send ttl_ms, ms. */
  leaseDurationMs?: number;
  /** Hard cap on total lease lifetime, ms (reaper destroys at this bound). */
  maxLifetimeMs?: number;
  now?: () => number;
  uuid?: () => string;
}

export interface ResolvedDeps {
  db: LiteDb;
  proxmox: ProxmoxClient;
  nodes?: NodeRegistry;
  probe?: NodeProbe;
  nodeDiskFloorPct: number;
  nodeLock: PerNodeLock;
  diskFreePct: () => number;
  diskRefusalThresholdPct: number;
  leaseDurationMs: number;
  maxLifetimeMs: number;
  now: () => number;
  uuid: () => string;
}

export const DEFAULT_LEASE_DURATION_MS = 3_600_000; // 1h
export const DEFAULT_MAX_LIFETIME_MS = 86_400_000; // 24h
export const DEFAULT_DISK_THRESHOLD_PCT = 15;
export const DEFAULT_NODE_DISK_FLOOR_PCT = 15;

function resolveDeps(deps: RouterDeps): ResolvedDeps {
  return {
    db: deps.db,
    proxmox: deps.proxmox,
    nodes: deps.nodes,
    probe: deps.probe,
    nodeDiskFloorPct: deps.nodeDiskFloorPct ?? DEFAULT_NODE_DISK_FLOOR_PCT,
    nodeLock: new PerNodeLock(),
    diskFreePct: deps.diskFreePct ?? defaultDiskFreePct,
    diskRefusalThresholdPct: deps.diskRefusalThresholdPct ?? DEFAULT_DISK_THRESHOLD_PCT,
    leaseDurationMs: deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    maxLifetimeMs: deps.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS,
    now: deps.now ?? (() => Date.now()),
    uuid: deps.uuid ?? (() => randomUUID()),
  };
}

// ---------------------------------------------------------------------------
// Response + error helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** HTTP status per shared ErrorCode — the VmError body is authoritative. */
const HTTP_STATUS: Record<ErrorCode, number> = {
  CAPABILITY_UNAVAILABLE: 409,
  QUOTA_EXCEEDED: 403,
  HOST_CAPACITY: 503,
  NODE_UNAVAILABLE: 503,
  DISK_FULL: 507,
  BOOT_TIMEOUT: 503,
  LOCK_CONTENTION: 409,
  PROVISION_FAILED: 503,
  LEASE_EXPIRED: 410,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  INVALID_REQUEST: 400,
  INTERNAL: 500,
};

function errorResponse(err: unknown): Response {
  const ve = toVmError(err);
  return json({ error: ve }, HTTP_STATUS[ve.code]);
}

function toVmError(err: unknown): VmError {
  if (isVmError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return { code: "INTERNAL", message, retryable: false, hint: "no-retry" };
}

function invalidRequest(message: string): VmError {
  return { code: "INVALID_REQUEST", message, retryable: false, hint: "no-retry" };
}

function notFound(message: string): VmError {
  return { code: "NOT_FOUND", message, retryable: false, hint: "no-retry" };
}

function leaseExpired(message: string, detail?: string): VmError {
  return { code: "LEASE_EXPIRED", message, retryable: false, hint: "no-retry", detail };
}

function diskFull(freePct: number, threshold: number): VmError {
  return {
    code: "DISK_FULL",
    message: `host disk below ${threshold}% free (currently ${freePct.toFixed(1)}%)`,
    retryable: true,
    hint: "release old leases with vm_lease_release, then retry vm_lease_create",
    detail: "free disk space (delete old artifacts/leases) then retry",
  };
}

function unavailableTemplate(tpl: Template): VmError {
  return {
    code: "CAPABILITY_UNAVAILABLE",
    message: `template '${tpl.id}' is '${tpl.availability}', not 'available'`,
    retryable: false,
    hint: "pick a different template from vm_list_templates",
    detail: tpl.reason,
  };
}

// ---------------------------------------------------------------------------
// Disk-free check (injectable for tests; default reads the filesystem)
// ---------------------------------------------------------------------------

function defaultDiskFreePct(dir = "."): number {
  try {
    const s = statfsSync(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    if (!Number.isFinite(total) || total <= 0) return 100;
    const free = Number(s.bavail) * Number(s.bsize);
    return (free / total) * 100;
  } catch {
    // statfs unavailable (older runtime) → fall back to `df -P -B1`
  }
  try {
    const out = execFileSync("df", ["-P", "-B1", dir], { encoding: "utf8" });
    const line = out.trim().split("\n").pop();
    const parts = line?.split(/\s+/);
    const total = parts?.[1] ? Number(parts[1]) : Number.NaN;
    const free = parts?.[3] ? Number(parts[3]) : Number.NaN;
    if (!Number.isFinite(total) || total <= 0) return 100;
    if (!Number.isFinite(free)) return 100;
    return (free / total) * 100;
  } catch {
    return 100; // can't measure → don't block allocations
  }
}

function assertDiskSpace(ctx: ResolvedDeps): void {
  const free = ctx.diskFreePct();
  if (free < ctx.diskRefusalThresholdPct) {
    throw diskFull(free, ctx.diskRefusalThresholdPct);
  }
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** Lease half of {vm, lease} — shared Lease fields plus v1 status/createdAt. */
export type LeaseResponseLease = LeaseRow;

/** JSON shape of a lease returned by the API. vm is absent after release. */
export interface LeaseResponse {
  vm?: VmRow;
  lease: LeaseResponseLease;
}

function toLeaseResponse(lease: LeaseRow, ctx: ResolvedDeps): LeaseResponse {
  const vm = ctx.db.getVm(lease.vmId) ?? undefined;
  return { vm, lease };
}

// ---------------------------------------------------------------------------
// Body parsing helpers
// ---------------------------------------------------------------------------

interface LeaseCreateBody {
  request_id?: unknown;
  requestId?: unknown;
  template_id?: unknown;
  templateId?: unknown;
  owner?: unknown;
  ttl_ms?: unknown;
  ttlMs?: unknown;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

function positiveMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Provisioning status (feature flag)
// ---------------------------------------------------------------------------

/**
 * When true (default), VMs start in "provisioning" status and the control
 * plane polls Proxmox until the VM reports "running" before transitioning to
 * "ready". When false, the legacy behaviour applies: status starts as
 * "starting" and transitions to "ready" immediately after startVm.
 */
const USE_PROVISIONING = process.env.VMHUB_PROVISIONING_STATUS !== "false";

/** Default poll timeout for Proxmox readiness (30s). */
const PROVISION_POLL_TIMEOUT_MS = 30_000;
/** Default poll interval for Proxmox readiness (500ms). */
const PROVISION_POLL_INTERVAL_MS = 500;

/**
 * Poll Proxmox until the VM reports `status === "running"` or timeout.
 * Throws PROVISION_FAILED on timeout or if getVm itself fails.
 */
async function pollProxmoxRunning(
  client: ProxmoxClient,
  vmid: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? PROVISION_POLL_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? PROVISION_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pvm = await client.getVm(vmid);
    if (pvm.status === "running") return;
    if (Date.now() >= deadline) {
      throw vmError(
        "PROVISION_FAILED",
        `VM ${vmid} did not reach running status within ${timeoutMs}ms`,
        `last status: ${pvm.status}`,
      );
    }
    await new Promise((r) =>
      setTimeout(r, Math.min(intervalMs, Math.max(deadline - Date.now(), 1))),
    );
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

async function createLease(req: Request, ctx: ResolvedDeps): Promise<Response> {
  const body = (await readJson(req)) as LeaseCreateBody;
  const requestId = firstString(body.request_id, body.requestId, req.headers.get("x-request-id"));
  const templateId = firstString(body.template_id, body.templateId);
  const owner = typeof body.owner === "string" ? body.owner : "unknown";

  if (!requestId) {
    throw invalidRequest("'request_id' is required — it is the idempotency key");
  }
  if (!templateId) {
    throw invalidRequest("'template_id' (string) is required");
  }

  // Idempotency: same request_id always returns the same lease (200 on replay).
  const existing = ctx.db.getLeaseByRequestId(requestId);
  if (existing) return json(toLeaseResponse(existing, ctx), 200);

  assertDiskSpace(ctx);

  const templates = await ctx.proxmox.listTemplates();
  const tpl = templates.find((t) => t.id === templateId);
  if (!tpl) throw notFound(`template '${templateId}' not found`);
  if (tpl.availability !== "available") throw unavailableTemplate(tpl);

  const requestedTtl = positiveMs(body.ttl_ms) ?? positiveMs(body.ttlMs);
  const initialTtl = Math.min(requestedTtl ?? ctx.leaseDurationMs, ctx.maxLifetimeMs);
  const ttlClamped = requestedTtl !== undefined && requestedTtl > ctx.maxLifetimeMs;

  // Multi-node routing: when a registry + probe are wired, select a node that
  // satisfies the template's constraints + golden + RAM/disk headroom, then
  // create the VM through that node's client. Single-node mode (no registry)
  // keeps the legacy path byte-identical.
  if (ctx.nodes && ctx.probe) {
    return createRoutedLease(req, ctx, templates, tpl, requestId, owner, initialTtl);
  }

  const now = ctx.now();
  const uuid = ctx.uuid();
  const prefix = prefixFromTemplateId(templateId);
  const useLockedCreate = process.env.VMHUB_LOCKED_CREATE !== "false";

  const vm: VmRow = {
    uuid,
    vmid: 0,
    nodeId: DEFAULT_NODE_ID,
    templateId,
    adapter: tpl.os,
    capabilities: tpl.capabilities,
    proxmoxTag: `vmhub-${prefix}-${uuid}`,
    namePrefix: prefix,
    status: USE_PROVISIONING ? "provisioning" : "starting",
    createdAt: now,
  };
  const lease: LeaseRow = {
    vmId: uuid,
    owner,
    requestId,
    status: "active",
    expiresAt: now + initialTtl,
    lastRenewedAt: now,
    renewCount: 0,
    maxLifetimeMs: ctx.maxLifetimeMs,
    createdAt: now,
  };

  const createVmAndStart = async () => {
    const pvm = await ctx.proxmox.createVm({
      templateId,
      name: `${prefix}-${uuid.slice(0, 8)}`,
      proxmoxTag: vm.proxmoxTag,
      cpus: tpl.vcpus,
      memoryMb: tpl.ramMb,
    });
    vm.vmid = pvm.vmid;
    vm.ip = pvm.ip;
    ctx.db.insertVm(vm);
    try {
      await ctx.proxmox.startVm(pvm.vmid);
    } catch (err) {
      ctx.db.deleteVm(uuid);
      await ctx.proxmox.destroyVm(pvm.vmid);
      throw err;
    }
    if (USE_PROVISIONING) {
      try {
        await pollProxmoxRunning(ctx.proxmox, pvm.vmid);
      } catch (err) {
        ctx.db.deleteVm(uuid);
        await ctx.proxmox.destroyVm(pvm.vmid);
        throw isVmError(err)
          ? err
          : vmError(
              "PROVISION_FAILED",
              `VM ${pvm.vmid} failed Proxmox readiness check after start`,
              String(err),
            );
      }
    } else {
      try {
        await ctx.proxmox.getVm(pvm.vmid);
      } catch (err) {
        ctx.db.deleteVm(uuid);
        await ctx.proxmox.destroyVm(pvm.vmid);
        throw vmError(
          "PROVISION_FAILED",
          `VM ${pvm.vmid} failed Proxmox verification after start`,
          isVmError(err) ? err.message : String(err),
        );
      }
    }
    const probe = await ctx.proxmox.probeCapabilities(pvm.vmid);
    if (!probe.available) {
      ctx.db.deleteVm(uuid);
      await ctx.proxmox.destroyVm(pvm.vmid);
      throw vmError(
        "CAPABILITY_UNAVAILABLE",
        `template '${templateId}' probe failed: ${probe.reason}`,
        probe.reason,
      );
    }
    ctx.db.updateVmStatus(uuid, "ready");
  };

  if (useLockedCreate) {
    await ctx.nodeLock.run(DEFAULT_NODE_ID, createVmAndStart);
  } else {
    await createVmAndStart();
  }

  try {
    ctx.db.insertLease(lease);
  } catch (err) {
    ctx.db.deleteVm(uuid);
    await ctx.proxmox.destroyVm(vm.vmid);
    const winner = ctx.db.getLeaseByRequestId(requestId);
    if (winner) return json(toLeaseResponse(winner, ctx), 200);
    throw err;
  }
  const response = toLeaseResponse(lease, ctx);
  return json({ ...response, ttlApplied: initialTtl, ttlClamped }, 201);
}

// ---------------------------------------------------------------------------
// Multi-node lease routing
// ---------------------------------------------------------------------------

function nodeUnavailable(message: string, detail?: string): VmError {
  return { code: "NODE_UNAVAILABLE", message, retryable: true, hint: "wait-then-retry", detail };
}

function noNodeAvailable(results: NodeProbeResult[], tpl: Template, floorPct: number): VmError {
  const online = results.filter((r) => r.node.status === "online");
  if (online.length === 0) {
    return nodeUnavailable(
      `no node is reachable for template '${tpl.id}'`,
      "all registered nodes are offline or stuck; retry after the node probe recovers",
    );
  }
  const reasons = online
    .filter((r) => !nodeSatisfiesTemplate(r, tpl, floorPct))
    .map((r) => `${r.node.id}: no golden/constraint/headroom match`)
    .join("; ");
  return nodeUnavailable(
    `no node can host template '${tpl.id}'`,
    reasons || "candidate nodes exist but none satisfy the template constraints",
  );
}

/**
 * Route a lease to a satisfying node (5-term availability: reachable ∧
 * constraints ∧ golden present ∧ RAM headroom ≥ ramMb ∧ disk free ≥ floor).
 * With VMHUB_LOCKED_CREATE (default on), the per-node mutex serializes the
 * full create → insert → start sequence so concurrent RAM checks cannot all
 * pass before any insert lands. The legacy path keeps the old non-locked
 * behaviour for rollback compatibility.
 */
async function createRoutedLease(
  req: Request,
  ctx: ResolvedDeps,
  templates: Template[],
  tpl: Template,
  requestId: string,
  owner: string,
  initialTtl: number,
): Promise<Response> {
  const now = ctx.now();
  const uuid = ctx.uuid();
  const prefix = prefixFromTemplateId(tpl.id);
  const ramByTemplate = new Map(templates.map((t) => [t.id, t.ramMb] as const));
  const usedRamOn = (nodeId: string): number =>
    ctx.db.listVms().reduce((acc, vm) => (vm.nodeId === nodeId ? acc + (ramByTemplate.get(vm.templateId) ?? 0) : acc), 0);

  const results = await ctx.probe!.results();
  const candidates = results
    .filter((r) => nodeSatisfiesTemplate(r, tpl, ctx.nodeDiskFloorPct) && r.ramHeadroomMb - usedRamOn(r.node.id) >= tpl.ramMb)
    .sort(byDiskThenId);
  if (candidates.length === 0) throw noNodeAvailable(results, tpl, ctx.nodeDiskFloorPct);

  const chosen = candidates[0]!;
  const nodeId = chosen.node.id;
  const client = ctx.nodes!.client(nodeId);
  if (!client) throw nodeUnavailable(`node '${nodeId}' has no client`);

  const useLockedCreate = process.env.VMHUB_LOCKED_CREATE !== "false";

  const vm: VmRow = {
    uuid,
    vmid: 0, // filled from createVm inside the lock
    nodeId,
    templateId: tpl.id,
    adapter: tpl.os,
    capabilities: tpl.capabilities,
    proxmoxTag: `vmhub-${prefix}-${uuid}`,
    namePrefix: prefix,
    status: USE_PROVISIONING ? "provisioning" : "starting",
    ip: undefined,
    createdAt: now,
  };
  const lease: LeaseRow = {
    vmId: uuid,
    owner,
    requestId,
    status: "active",
    expiresAt: now + initialTtl,
    lastRenewedAt: now,
    renewCount: 0,
    maxLifetimeMs: ctx.maxLifetimeMs,
    createdAt: now,
  };

  if (useLockedCreate) {
    await ctx.nodeLock.run(nodeId, async () => {
      const fresh = await ctx.probe!.refresh(nodeId);
      if (!(fresh && fresh.node.status === "online" && nodeSatisfiesTemplate(fresh, tpl, ctx.nodeDiskFloorPct))) {
        throw nodeUnavailable(
          `node '${nodeId}' became unavailable during routing`,
          "the node failed its re-probe; retry the lease",
        );
      }
      const currentUsed = usedRamOn(nodeId);
      if (fresh.ramHeadroomMb - currentUsed < tpl.ramMb) {
        throw nodeUnavailable(
          `node '${nodeId}' no longer has enough RAM for template '${tpl.id}'`,
          `headroom ${fresh.ramHeadroomMb}MB - used ${currentUsed}MB < needed ${tpl.ramMb}MB`,
        );
      }
      const pvm = await client.createVm({
        templateId: tpl.id,
        name: `${prefix}-${uuid.slice(0, 8)}`,
        proxmoxTag: `vmhub-${prefix}-${uuid}`,
        nodeId,
        cpus: tpl.vcpus,
        memoryMb: tpl.ramMb,
      });
      vm.vmid = pvm.vmid;
      vm.ip = pvm.ip;
      ctx.db.insertVm(vm);
      try {
        await client.startVm(pvm.vmid);
      } catch (err) {
        ctx.db.deleteVm(uuid);
        await client.destroyVm(pvm.vmid);
        throw err;
      }
      if (USE_PROVISIONING) {
        try {
          await pollProxmoxRunning(client, pvm.vmid);
        } catch (err) {
          ctx.db.deleteVm(uuid);
          await client.destroyVm(pvm.vmid);
          throw isVmError(err)
            ? err
            : vmError(
                "PROVISION_FAILED",
                `VM ${pvm.vmid} failed Proxmox readiness check after start`,
                String(err),
              );
        }
      }
      const probe = await client.probeCapabilities(pvm.vmid);
      if (!probe.available) {
        ctx.db.deleteVm(uuid);
        await client.destroyVm(pvm.vmid);
        throw vmError(
          "CAPABILITY_UNAVAILABLE",
          `template '${tpl.id}' probe failed: ${probe.reason}`,
          probe.reason,
        );
      }
      ctx.db.updateVmStatus(uuid, "ready");
    });
  } else {
    const pvm = await ctx.nodeLock.run(nodeId, async () => {
      const fresh = await ctx.probe!.refresh(nodeId);
      if (fresh && fresh.node.status === "online" && nodeSatisfiesTemplate(fresh, tpl, ctx.nodeDiskFloorPct)) {
        return client.createVm({
          templateId: tpl.id,
          name: `${prefix}-${uuid.slice(0, 8)}`,
          proxmoxTag: `vmhub-${prefix}-${uuid}`,
          nodeId,
          cpus: tpl.vcpus,
          memoryMb: tpl.ramMb,
        });
      }
      throw nodeUnavailable(
        `node '${nodeId}' became unavailable during routing`,
        "the node failed its re-probe; retry the lease",
      );
    });
    vm.vmid = pvm.vmid;
    vm.ip = pvm.ip;
    try {
      await client.startVm(pvm.vmid);
    } catch (err) {
      await client.destroyVm(pvm.vmid);
      throw err;
    }
    if (USE_PROVISIONING) {
      try {
        await pollProxmoxRunning(client, pvm.vmid);
      } catch (err) {
        await client.destroyVm(pvm.vmid);
        throw isVmError(err)
          ? err
          : vmError(
              "PROVISION_FAILED",
              `VM ${pvm.vmid} failed Proxmox readiness check after start`,
              String(err),
            );
      }
    }
    const probe = await client.probeCapabilities(pvm.vmid);
    if (!probe.available) {
      await client.destroyVm(pvm.vmid);
      throw vmError(
        "CAPABILITY_UNAVAILABLE",
        `template '${tpl.id}' probe failed: ${probe.reason}`,
        probe.reason,
      );
    }
    vm.status = USE_PROVISIONING ? "provisioning" : "ready";
    ctx.db.insertVm(vm);
    ctx.db.updateVmStatus(uuid, "ready");
  }

  try {
    ctx.db.insertLease(lease);
  } catch (err) {
    ctx.db.deleteVm(uuid);
    await client.destroyVm(vm.vmid);
    const winner = ctx.db.getLeaseByRequestId(requestId);
    if (winner) return json(toLeaseResponse(winner, ctx), 200);
    throw err;
  }
  return json(toLeaseResponse(lease, ctx), 201);
}

/** GET /v1/nodes — observed node state from the shared probe loop. */
async function listNodes(req: Request, ctx: ResolvedDeps): Promise<Response> {
  if (!ctx.probe) {
    // Single-node fallback: synthesize one node from the existing client.
    const node: VmNode = {
      id: DEFAULT_NODE_ID,
      name: DEFAULT_NODE_ID,
      status: "online",
      metadata: { os: [], avx2: false, nestedVirt: false, ramMb: 0 },
    };
    return json([node]);
  }
  const nodes = await ctx.probe.snapshot();
  return json(nodes);
}

/**
 * DELETE /v1/leases/{id}/force — closes the "defer forever" loop. Only allowed
 * when the lease's node is in 'stuck' (repeated auth failure). Identity-verified:
 * the Proxmox VM's tag must match the lease's tag before any destruction.
 * Requires an explicit {"confirm":"destroy"} body.
 */
async function forceDestroyLease(req: Request, ctx: ResolvedDeps, id: string): Promise<Response> {
  const lease = ctx.db.getLease(id);
  if (!lease) throw notFound(`lease '${id}' not found`);
  if (lease.status !== "active") {
    return json({ vmId: id, status: lease.status });
  }

  const body = (await readJson(req)) as { confirm?: unknown };
  if (body.confirm !== "destroy") {
    throw invalidRequest("force-destroy requires an explicit body {\"confirm\":\"destroy\"}");
  }

  const vm = ctx.db.getVm(lease.vmId);
  if (!vm) throw notFound(`vm '${lease.vmId}' not found`);

  const nodeState = ctx.probe ? await ctx.probe.snapshot() : [];
  const node = nodeState.find((n) => n.id === vm.nodeId);
  if (!node || node.status !== "stuck") {
    throw invalidRequest(`lease '${id}' node '${vm.nodeId}' is not stuck — use DELETE /v1/leases/${id} instead`);
  }

  const client = ctx.nodes?.client(vm.nodeId) ?? ctx.proxmox;
  // Identity-verified: the Proxmox VM's tag must match the lease's tag.
  const remote = await client.getVm(vm.vmid);
  if (remote.proxmoxTag !== vm.proxmoxTag) {
    throw invalidRequest(
      `proxmox VM ${vm.vmid} on '${vm.nodeId}' carries tag '${remote.proxmoxTag}', not '${vm.proxmoxTag}'`,
    );
  }
  await client.destroyVm(vm.vmid);
  ctx.db.deleteArtifactsForLease(lease.vmId);
  ctx.db.deleteVm(lease.vmId);
  ctx.db.markLeaseReleased(lease.vmId, ctx.now());
  return json({ vmId: id, status: "released", forced: true });
}

function getLease(req: Request, ctx: ResolvedDeps, id: string): Response {
  const lease = ctx.db.getLease(id);
  if (!lease) throw notFound(`lease '${id}' not found`);
  return json(toLeaseResponse(lease, ctx));
}

async function renewLease(req: Request, ctx: ResolvedDeps, id: string): Promise<Response> {
  const lease = ctx.db.getLease(id);
  if (!lease) throw notFound(`lease '${id}' not found`);
  if (lease.status !== "active") throw notFound(`lease '${id}' is not active (${lease.status})`);

  const now = ctx.now();
  if (now >= lease.expiresAt) {
    throw leaseExpired(
      `lease '${id}' expired at ${new Date(lease.expiresAt).toISOString()}`,
      "renew before the deadline or create a new lease",
    );
  }

  const body = (await readJson(req)) as { ttl_ms?: unknown; ttlMs?: unknown };
  const extensionMs = positiveMs(body.ttl_ms) ?? positiveMs(body.ttlMs) ?? ctx.leaseDurationMs;
  const hardCap = lease.createdAt + lease.maxLifetimeMs;
  const nextExpiresAt = Math.min(now + extensionMs, hardCap);
  const updated: LeaseRow = {
    ...lease,
    expiresAt: nextExpiresAt,
    lastRenewedAt: now,
    renewCount: lease.renewCount + 1,
  };
  ctx.db.updateLease(updated);
  return json(updated);
}

async function releaseLease(req: Request, ctx: ResolvedDeps, id: string): Promise<Response> {
  const lease = ctx.db.getLease(id);
  if (!lease) throw notFound(`lease '${id}' not found`);
  if (lease.status === "released") {
    // Idempotent release — a retry after success returns the same answer.
    return json({ vmId: id, status: "released" });
  }

  const vm = ctx.db.getVm(lease.vmId);
  if (vm) {
    // Multi-node: destroy through the node's own client; single-node falls
    // back to the shared client.
    const client = ctx.nodes?.client(vm.nodeId) ?? ctx.proxmox;
    await client.destroyVm(vm.vmid);
  }
  ctx.db.deleteArtifactsForLease(lease.vmId);
  ctx.db.deleteVm(lease.vmId);
  ctx.db.markLeaseReleased(lease.vmId, ctx.now());
  return json({ vmId: id, status: "released" });
}

async function listTemplates(req: Request, ctx: ResolvedDeps): Promise<Response> {
  const templates = await ctx.proxmox.listTemplates();
  return json(templates);
}

function listVms(req: Request, ctx: ResolvedDeps): Response {
  return json(ctx.db.listVms());
}

function getVm(req: Request, ctx: ResolvedDeps, uuid: string): Response {
  const vm = ctx.db.getVm(uuid);
  if (!vm) throw notFound(`vm '${uuid}' not found`);
  return json(vm);
}

function incrementToolCalls(_req: Request, ctx: ResolvedDeps, uuid: string): Response {
  const vm = ctx.db.getVm(uuid);
  if (!vm) throw notFound(`vm '${uuid}' not found`);
  ctx.db.incrementToolCalls(uuid);
  return json({ activeToolCalls: (ctx.db.getVm(uuid)?.activeToolCalls ?? 0) });
}

function decrementToolCalls(_req: Request, ctx: ResolvedDeps, uuid: string): Response {
  const vm = ctx.db.getVm(uuid);
  if (!vm) throw notFound(`vm '${uuid}' not found`);
  ctx.db.decrementToolCalls(uuid);
  return json({ activeToolCalls: (ctx.db.getVm(uuid)?.activeToolCalls ?? 0) });
}

interface ArtifactCreateBody {
  lease_id?: unknown;
  leaseId?: unknown;
  host_path?: unknown;
  hostPath?: unknown;
  size_bytes?: unknown;
  sizeBytes?: unknown;
}

async function createArtifact(req: Request, ctx: ResolvedDeps): Promise<Response> {
  const body = (await readJson(req)) as ArtifactCreateBody;
  const leaseId = firstString(body.lease_id, body.leaseId);
  const hostPath = firstString(body.host_path, body.hostPath);
  if (!leaseId) throw invalidRequest("'lease_id' (string) is required");
  if (!hostPath) throw invalidRequest("'host_path' (string) is required");

  const lease = ctx.db.getLease(leaseId);
  if (!lease) throw notFound(`lease '${leaseId}' not found`);
  if (lease.status !== "active") throw notFound(`lease '${leaseId}' is not active`);

  assertDiskSpace(ctx);

  const sizeBytes = positiveMs(body.size_bytes) ?? positiveMs(body.sizeBytes) ?? statSize(hostPath);
  const record: ArtifactRecord = {
    id: ctx.uuid(),
    leaseId,
    hostPath,
    sizeBytes,
    inFlight: false,
    createdAt: ctx.now(),
  };
  ctx.db.insertArtifact(record);
  return json(record, 201);
}

function getArtifact(req: Request, ctx: ResolvedDeps, id: string): Response {
  const artifact = ctx.db.getArtifact(id);
  if (!artifact) throw notFound(`artifact '${id}' not found`);
  return json(artifact);
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    // File doesn't exist yet — register with size 0.
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Handler = (req: Request, ctx: ResolvedDeps, ...params: string[]) => Promise<Response> | Response;

interface Route {
  method: string;
  segments: string[]; // segment === ":id" captures a param
  handler: Handler;
}

const ROUTES: Route[] = [
  { method: "POST", segments: ["v1", "leases"], handler: createLease },
  { method: "GET", segments: ["v1", "leases", ":id"], handler: getLease },
  { method: "POST", segments: ["v1", "leases", ":id", "renew"], handler: renewLease },
  { method: "DELETE", segments: ["v1", "leases", ":id"], handler: releaseLease },
  { method: "DELETE", segments: ["v1", "leases", ":id", "force"], handler: forceDestroyLease },
  { method: "GET", segments: ["v1", "templates"], handler: listTemplates },
  { method: "GET", segments: ["v1", "nodes"], handler: listNodes },
  { method: "GET", segments: ["v1", "vms"], handler: listVms },
  { method: "GET", segments: ["v1", "vms", ":id"], handler: getVm },
  { method: "POST", segments: ["v1", "artifacts"], handler: createArtifact },
  { method: "GET", segments: ["v1", "artifacts", ":id"], handler: getArtifact },
  { method: "POST", segments: ["v1", "vms", ":id", "tool-calls", "increment"], handler: incrementToolCalls },
  { method: "POST", segments: ["v1", "vms", ":id", "tool-calls", "decrement"], handler: decrementToolCalls },
];

export function createLiteHandler(deps: RouterDeps): (req: Request) => Promise<Response> {
  const ctx = resolveDeps(deps);
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
      const segments = path === "" ? [] : path.split("/");

      for (const route of ROUTES) {
        if (route.method !== req.method) continue;
        const params = matchRoute(route.segments, segments);
        if (params === null) continue;
        return await route.handler(req, ctx, ...params);
      }

      throw notFound(`no route ${req.method} /${path}`);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** Match segments against a pattern; returns captured ":id" values or null. */
function matchRoute(pattern: string[], segments: string[]): string[] | null {
  if (pattern.length !== segments.length) return null;
  const params: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    const s = segments[i] as string;
    if (p.startsWith(":")) {
      params.push(decodeURIComponent(s));
    } else if (p !== s) {
      return null;
    }
  }
  return params;
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw invalidRequest("request body must be valid JSON");
  }
}

function prefixFromTemplateId(templateId: string): string {
  const cleaned = templateId
    .replace(/[^a-z0-9-]/gi, "")
    .toLowerCase()
    .slice(0, 8);
  return cleaned || "vm";
}
