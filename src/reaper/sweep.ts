/**
 * vmhub-reaper sweep engine — the per-node, fail-closed sweep loop.
 *
 * Expired leases are grouped by the VM's nodeId (the listLeasesWithVm join
 * carries v.nodeId); each group is swept on THAT node's own client, resolved
 * AT SWEEP TIME from the registry. Fail-closed per node:
 *  - a node that cannot be probed (401/5xx/timeout) has ALL its leases
 *    DEFERRED — rows are kept and retried next sweep, never destroyed by
 *    inference. A failed sweep must never look clean.
 *  - a 404 during a specific teardown is CLEAN (VM already gone) — file + row
 *    cleanup proceeds (teardownLease).
 *  - after STUCK_THRESHOLD (3) consecutive auth-failed sweeps the node flips
 *    to NodeStatus 'stuck' and an alert line is emitted in the report.
 * Per-node outcome counters persist in the durable ledger so they survive
 * reaper restarts; sweep-on-return reconciles deferred leases idempotently by
 * identity tag.
 */

import type { ProxmoxClient } from "../lite/proxmox.ts";
import {
  InMemorySweepLedger,
  STUCK_THRESHOLD,
  sweepStatusFor,
  type NodeSweepOutcome,
  type SweepLedger,
} from "./ledger.ts";
import { defaultNodeConfig, type SweepNode } from "./nodes.ts";
import { DEFAULT_NODE_ID } from "../shared/schema.ts";
import { DEFAULT_DRAIN_TIMEOUT_MS, clientDiskFreePercent, isLeaseExpired, teardownLease, type LeaseEntry } from "./teardown.ts";
import type { ReaperDb } from "./reaper.db.ts";
import type { SweepOptions, SweepReport } from "./index.ts";

/** Bounded rolling alert history kept per node in the ledger. */
const MAX_LEDGER_ALERTS = 20;

/** Default disk-full refusal threshold (mirrors VMHUB_DISK_FULL_REFUSAL_PCT). */
export const DEFAULT_DISK_FULL_REFUSAL_PCT = 15;

/** Ambient sweep state shared by every per-node step. */
interface NodeSweepContext {
  db: ReaperDb;
  report: SweepReport;
  now: number;
  drainTimeoutMs: number;
  artifactDir?: string;
  ledger: SweepLedger;
}

/** Group key: legacy rows carry '' (pre-multi-node default); treat as the fleet default. */
function nodeIdOf(vm: { nodeId: string }): string {
  return vm.nodeId && vm.nodeId.trim() !== "" ? vm.nodeId : DEFAULT_NODE_ID;
}

/**
 * Sweep one node's expired leases. Fail-closed:
 *  - probe failure (401/5xx/timeout) → EVERY lease deferred, rows kept, retried
 *    next sweep; STUCK_THRESHOLD consecutive failures flip the node to 'stuck'
 *    and emit an alert.
 *  - node reachable → destroy by identity tag only; a 404 during teardown is
 *    clean (VM already gone); per-lease failures are isolated (row kept).
 */
async function sweepNode(
  ctx: NodeSweepContext,
  node: SweepNode,
  client: ProxmoxClient,
  leases: LeaseEntry[],
): Promise<void> {
  const { db, report, ledger } = ctx;
  const prev = ledger.getNode(node.config.id);
  const base = {
    nodeId: node.config.id,
    deferredBatches: prev?.deferredBatches ?? 0,
    destroyedTotal: prev?.destroyedTotal ?? 0,
    alerts: prev?.alerts ?? [],
    lastSweepAt: ctx.now,
  };

  // Reachability probe. A 401/5xx/timeout means the node is not reachable →
  // ALL its leases are deferred. A failed sweep must never look clean.
  try {
    await client.listVms();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const consecutiveAuthFailures = (prev?.consecutiveAuthFailures ?? 0) + 1;
    const stuck = consecutiveAuthFailures >= STUCK_THRESHOLD;
    const outcome: NodeSweepOutcome = stuck ? "stuck" : "auth-failed";
    const status = sweepStatusFor({ consecutiveAuthFailures, lastOutcome: outcome });
    const localAlerts: string[] = [];
    if (stuck) {
      const alert = `node '${node.config.id}' is STUCK: ${consecutiveAuthFailures} consecutive auth-failed sweeps — ${leases.length} lease(s) deferred`;
      report.alerts.push(alert);
      localAlerts.push(alert);
    }
    ledger.record(node.config.id, {
      ...base,
      lastOutcome: outcome,
      consecutiveAuthFailures,
      deferredBatches: base.deferredBatches + 1,
      deferredCount: leases.length,
      lastError: message,
      status,
      alerts: [...base.alerts, ...localAlerts].slice(-MAX_LEDGER_ALERTS),
    });
    report.nodes.push({
      nodeId: node.config.id,
      outcome,
      status,
      deferred: leases.length,
      destroyed: 0,
      error: message,
    });
    return; // rows stay — the sweep retries next run.
  }

  // Node reachable — destroy its expired leases by identity tag, never VMID.
  let destroyed = 0;
  let deferred = 0;
  for (const entry of leases) {
    const result = await teardownLease(db, client, entry, {
      now: ctx.now,
      drainTimeoutMs: ctx.drainTimeoutMs,
      artifactDir: ctx.artifactDir,
    });
    switch (result.kind) {
      case "destroyed":
        destroyed++;
        break;
      case "draining":
        report.draining++;
        deferred++;
        break;
      case "quarantined":
        report.alerts.push(
          `identity collision: quarantined leases [${result.vmIds.join(", ")}]`,
        );
        break;
      case "error":
        deferred++;
        report.errors.push({ vmId: entry.vm.uuid, message: result.message });
        break;
      default: {
        const unreachable: never = result;
        throw new Error(`unreachable teardown result: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  const outcome: NodeSweepOutcome = deferred > 0 ? "deferred" : "ok";
  const status = sweepStatusFor({ consecutiveAuthFailures: 0, lastOutcome: outcome });
  report.destroyed += destroyed;
  ledger.record(node.config.id, {
    ...base,
    lastOutcome: outcome,
    consecutiveAuthFailures: 0,
    deferredCount: deferred,
    destroyedTotal: base.destroyedTotal + destroyed,
    lastError: undefined,
    status,
  });
  report.nodes.push({ nodeId: node.config.id, outcome, status, deferred, destroyed });
}

/** Fail-closed deferral when a lease group references a node with no registry entry. */
function deferUnknownNode(ctx: NodeSweepContext, nodeId: string, deferred: number): void {
  const { report, ledger } = ctx;
  const prev = ledger.getNode(nodeId);
  const message = `no node config for nodeId '${nodeId}' — ${deferred} lease(s) deferred (fail-closed)`;
  report.alerts.push(message);
  const status = sweepStatusFor({ consecutiveAuthFailures: prev?.consecutiveAuthFailures ?? 0, lastOutcome: "deferred" });
  ledger.record(nodeId, {
    nodeId,
    lastOutcome: "deferred",
    consecutiveAuthFailures: prev?.consecutiveAuthFailures ?? 0,
    deferredBatches: (prev?.deferredBatches ?? 0) + 1,
    deferredCount: deferred,
    destroyedTotal: prev?.destroyedTotal ?? 0,
    lastError: message,
    lastSweepAt: ctx.now,
    alerts: [...(prev?.alerts ?? []), message].slice(-MAX_LEDGER_ALERTS),
    status,
  });
  report.nodes.push({ nodeId, outcome: "deferred", status, deferred, destroyed: 0, error: message });
}

/**
 * Run one multi-node sweep. Reads all leases, groups the expired ones by their
 * VM's nodeId, and sweeps each node group on that node's own client with
 * fail-closed semantics. Per-lease failures are collected — one bad lease never
 * aborts the sweep; an unreachable node defers everything.
 */
export async function sweepNodes(db: ReaperDb, nodes: SweepNode[], opts: SweepOptions = {}): Promise<SweepReport> {
  const now = opts.now?.() ?? Date.now();
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const refusalPct = opts.diskFullRefusalPct ?? DEFAULT_DISK_FULL_REFUSAL_PCT;
  const ledger = opts.ledger ?? new InMemorySweepLedger();

  const report: SweepReport = {
    scanned: 0,
    expired: 0,
    draining: 0,
    destroyed: 0,
    refusedDiskFull: false,
    errors: [],
    alerts: [],
    nodes: [],
  };
  const all = db.listLeasesWithVm();
  report.scanned = all.length;

  const expired = all.filter(({ lease, vm }) => isLeaseExpired(lease, vm, now));
  report.expired = expired.length;
  if (expired.length === 0) return report;

  // Group expired leases by the node that hosts them (the join carries nodeId).
  const byNode = new Map<string, LeaseEntry[]>();
  for (const entry of expired) {
    const nodeId = nodeIdOf(entry.vm);
    const list = byNode.get(nodeId) ?? [];
    list.push(entry);
    byNode.set(nodeId, list);
  }

  // 15 % disk-full refusal — refuse ALL destructive work below the threshold.
  const diskFreePercent =
    opts.diskFreePercent ??
    (nodes.length > 0 ? () => clientDiskFreePercent(nodes[0]!.createClient()) : async () => 100);
  const freePct = await diskFreePercent();
  if (freePct < refusalPct) {
    report.refusedDiskFull = true;
    report.errors.push({
      vmId: "*",
      message: `sweep refused: disk free ${freePct.toFixed(1)}% < ${refusalPct}% refusal threshold`,
    });
    return report;
  }

  const ctx: NodeSweepContext = { db, report, now, drainTimeoutMs, artifactDir: opts.artifactDir, ledger };
  const configById = new Map(nodes.map((n) => [n.config.id, n]));
  const openClients: ProxmoxClient[] = [];
  try {
    for (const [nodeId, leases] of byNode) {
      const node = configById.get(nodeId);
      if (!node) {
        deferUnknownNode(ctx, nodeId, leases.length);
        continue;
      }
      const client = node.createClient();
      openClients.push(client);
      await sweepNode(ctx, node, client, leases);
    }
  } finally {
    for (const client of openClients) await client.close?.();
  }

  return report;
}

/**
 * Single-node sweep (legacy surface). Preserves the pre-multi-node signature
 * exactly: one default node, one client. New code should use sweepNodes.
 */
export async function sweep(db: ReaperDb, proxmox: ProxmoxClient, opts: SweepOptions = {}): Promise<SweepReport> {
  return sweepNodes(db, [{ config: defaultNodeConfig(), createClient: () => proxmox }], opts);
}
