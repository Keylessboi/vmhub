/**
 * Multi-node registry + probe infrastructure for vmhub-lite.
 *
 * - NodeRegistry: static NodeConfig[] + a per-node Proxmox client factory.
 * - createProbeLoop: a shared probe loop (per-node reachability, RAM headroom,
 *   disk free, golden presence) with a TTL cache, consumed by BOTH the
 *   availability predicate in routes.ts and GET /v1/nodes. Single-flight per
 *   node so concurrent calls share one probe.
 * - PerNodeLock: lite-process-local critical-section serializer per node
 *   (Map<nodeId, Promise>). Only the allocation critical section (re-probe →
 *   headroom check → VMID/IP allocation → submit clone) runs inside the lock;
 *   startVm/readiness run outside it. One control-plane instance binds
 *   127.0.0.1, so no distributed lock is needed.
 */
import type { NodeConfig, NodeStatus, Template, VmNode } from "../shared/types.ts";
import { DEFAULT_NODE_ID } from "../shared/schema.ts";
import { resolveNodeConfigs } from "../shared/config.ts";
import type { ProxmoxClient } from "./proxmox.ts";
import { MockProxmox } from "./proxmox.ts";
import { createRealProxmox } from "./proxmox-real.ts";
import { isVmError } from "../mcp/errors.ts";

export const DEFAULT_PROBE_TTL_MS = 90_000; // 60-120s window
const STUCK_AFTER_CONSECUTIVE_AUTH_FAILURES = 3;

/** Live-observed state for one node — VmNode plus routing internals. */
export interface NodeProbeResult {
  node: VmNode;
  /** Free RAM MB as observed (probe). Routing subtracts db-allocated RAM. */
  ramHeadroomMb: number;
  diskFreeBytes: number;
  diskUsedBytes: number;
}

/** Injectable probe interface — routes consume this, tests fake it. */
export interface NodeProbe {
  /** Latest observed VmNode states (used by GET /v1/nodes). */
  snapshot(): Promise<VmNode[]>;
  /** Latest routing results (used by the availability predicate). */
  results(): Promise<NodeProbeResult[]>;
  /** Force a re-probe of one node, bypassing the TTL (TOCTOU re-check). */
  refresh(nodeId: string): Promise<NodeProbeResult | undefined>;
}

/** Static node registry — resolves one Proxmox client per node. */
export interface NodeRegistry {
  nodes(): NodeConfig[];
  client(nodeId: string): ProxmoxClient | undefined;
}

export function createNodeRegistry(
  configs: NodeConfig[],
  factory: (config: NodeConfig) => ProxmoxClient = createClientForNode,
): NodeRegistry {
  const clients = new Map<string, ProxmoxClient>();
  return {
    nodes: () => configs,
    client: (nodeId) => {
      const cfg = configs.find((c) => c.id === nodeId);
      if (!cfg) return undefined;
      let client = clients.get(nodeId);
      if (!client) {
        client = factory(cfg);
        clients.set(nodeId, client);
      }
      return client;
    },
  };
}

/** Per-node client factory: RealProxmox when token+baseUrl present, else a node-aware Mock. */
export function createClientForNode(config: NodeConfig): ProxmoxClient {
  const token = process.env[config.tokenEnv];
  if (token && token.trim() !== "" && config.baseUrl) {
    return createRealProxmox({
      nodeId: config.id,
      baseUrl: config.baseUrl,
      token,
      tokenId: process.env.PVE_TOKEN_ID || "vmhub@pve!automation",
    });
  }
  return new MockProxmox(config.id);
}

/**
 * Static node registry from env — the reaper's convention, mirrored here so
 * both lanes agree on node ids:
 *   VMHUB_NODES=a,b,c          comma-separated node ids (default: dl360p)
 *   VMHUB_NODE_<ID>_BASE_URL   per-node API base host[:port]
 *   VMHUB_NODE_<ID>_TOKEN      per-node token (default node falls back to PVE_TOKEN)
 * The default single-node path keeps legacy PVE_HOST/PVE_TOKEN behavior.
 */
/**
 * Static per-node metadata. avx2 is a HARD constraint — a node that doesn't
 * report it must never be advertised as satisfying avx2 templates. dl360p is
 * E5-2670 v2 (no AVX2). Unknown nodes default conservative (avx2:false) so
 * the catalog never lies.
 */
export { resolveNodeConfigs } from "../shared/config.ts";

/**
 * Shared probe loop. Probes each registered node, caches results for TTL,
 * single-flights concurrent calls per node. A probe never throws — failures
 * degrade to offline/stuck observations so the catalog stays honest.
 */
export function createProbeLoop(registry: NodeRegistry, ttlMs = DEFAULT_PROBE_TTL_MS): NodeProbe {
  const cache = new Map<string, { at: number; result: NodeProbeResult }>();
  const inflight = new Map<string, Promise<NodeProbeResult | undefined>>();
  const failures = new Map<string, number>();

  async function probeOne(config: NodeConfig): Promise<NodeProbeResult | undefined> {
    const client = registry.client(config.id);
    if (!client) return undefined;
    try {
      const [templates, freeBytes, usedBytes] = await Promise.all([
        client.listTemplates(),
        client.diskFreeBytes(),
        client.diskUsedBytes(),
      ]);
      const total = freeBytes + usedBytes;
      const diskFreePct = total > 0 ? Math.round((freeBytes / total) * 1000) / 10 : undefined;
      failures.delete(config.id);
      const node: VmNode = {
        id: config.id,
        name: config.id,
        baseUrl: config.baseUrl,
        status: "online",
        metadata: {
          os: config.metadata.os,
          avx2: config.metadata.avx2,
          nestedVirt: config.metadata.nestedVirt,
          ramMb: config.metadata.ramMb,
          diskFreePct,
          goldens: templates.filter((t) => t.availability === "available").map((t) => t.id),
        },
      };
      return { node, ramHeadroomMb: config.metadata.ramMb, diskFreeBytes: freeBytes, diskUsedBytes: usedBytes };
    } catch (err) {
      const authLike = isVmError(err) && !err.retryable;
      const count = (failures.get(config.id) ?? 0) + 1;
      failures.set(config.id, count);
      const status: NodeStatus =
        authLike && count >= STUCK_AFTER_CONSECUTIVE_AUTH_FAILURES ? "stuck" : "offline";
      return {
        node: {
          id: config.id,
          name: config.id,
          baseUrl: config.baseUrl,
          status,
          metadata: { ...config.metadata, goldens: [] },
        },
        ramHeadroomMb: 0,
        diskFreeBytes: 0,
        diskUsedBytes: 0,
      };
    }
  }

  function getOrProbe(config: NodeConfig): Promise<NodeProbeResult | undefined> {
    const cached = cache.get(config.id);
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.result);
    let pending = inflight.get(config.id);
    if (!pending) {
      pending = probeOne(config).then((result) => {
        if (result) cache.set(config.id, { at: Date.now(), result });
        return result;
      });
      inflight.set(config.id, pending);
      void pending.finally(() => inflight.delete(config.id));
    }
    return pending;
  }

  return {
    async snapshot(): Promise<VmNode[]> {
      const results = await Promise.all(registry.nodes().map((c) => getOrProbe(c)));
      return results.filter((r): r is NodeProbeResult => r !== undefined).map((r) => r.node);
    },
    async results(): Promise<NodeProbeResult[]> {
      const results = await Promise.all(registry.nodes().map((c) => getOrProbe(c)));
      return results.filter((r): r is NodeProbeResult => r !== undefined);
    },
    async refresh(nodeId: string): Promise<NodeProbeResult | undefined> {
      const config = registry.nodes().find((c) => c.id === nodeId);
      if (!config) return undefined;
      cache.delete(nodeId);
      const result = await probeOne(config);
      if (result) cache.set(nodeId, { at: Date.now(), result });
      return result;
    },
  };
}

/**
 * Per-node critical-section serializer. Only one allocation runs per node at a
 * time; the next waits for the previous tail. Process-local by design.
 */
export class PerNodeLock {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(nodeId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(nodeId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(nodeId, next.catch(() => undefined));
    return next;
  }
}

/** The 5-term availability predicate shared by routing + catalog logic. */
export function nodeSatisfiesTemplate(result: NodeProbeResult, tpl: Template, diskFloorPct: number): boolean {
  const node = result.node;
  if (node.status !== "online") return false;
  for (const c of tpl.constraints ?? []) {
    if (c.os !== undefined && !node.metadata.os.includes(c.os)) return false;
    if (c.cpu?.avx2 === true && !node.metadata.avx2) return false;
    if (c.nestedVirt === true && !node.metadata.nestedVirt) return false;
  }
  if (!node.metadata.goldens?.includes(tpl.id)) return false;
  if (result.ramHeadroomMb < (tpl.constraints?.[0]?.minRamMb ?? tpl.ramMb)) return false;
  const freePct = node.metadata.diskFreePct ?? 0;
  if (freePct < (tpl.constraints?.[0]?.minDiskFreePct ?? diskFloorPct)) return false;
  return true;
}

/** Deterministic node ordering: highest diskFreePct first, then nodeId asc. */
export function byDiskThenId(a: NodeProbeResult, b: NodeProbeResult): number {
  const da = a.node.metadata.diskFreePct ?? 0;
  const db = b.node.metadata.diskFreePct ?? 0;
  if (da !== db) return db - da;
  return a.node.id.localeCompare(b.node.id);
}
