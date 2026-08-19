/**
 * vmhub-reaper — the independent lease reaper (runtime entrypoint).
 *
 * Owns nothing but its sweep: every run it reads the shared leases.sqlite
 * directly (NEVER through vmhub-lite's HTTP API — independence is the point),
 * finds expired leases, destroys the VM by IDENTITY (the `vmhub-<prefix>-<uuid>`
 * tag + name prefix, never an agent-supplied VMID), then deletes the lease
 * files + staged artifacts and clears the DB rows.
 *
 * Multi-node (plan T9): the sweep is a per-node fail-closed loop (sweepNodes in
 * sweep.ts). Durable per-node outcome counters live in a JSONL ledger next to
 * the sqlite file (out-of-band of the shared DDL) so state survives restarts;
 * the ledger is replayed at boot — never memory only.
 *
 * Guardrails (plan R7 / 1.4):
 *  - DRAINING: refuse destroy while an artifact is in-flight (vm_get_file).
 *  - 24 h hard cap: leases past `expiresAt` or `createdAt + maxLifetimeMs`.
 *  - 15 % disk-full refusal: a sweep refuses all destructive work when the
 *    host disk is critically low.
 */

import { dirname, join } from "node:path";
import type { ProxmoxClient } from "../lite/proxmox.ts";
import type { NodeConfig } from "../shared/types.ts";
import { FileSweepLedger } from "./ledger.ts";
import { sweepStatusFor, type NodeSweepOutcome, type SweepLedger } from "./ledger.ts";
import { createClientForNode, defaultNodeConfig, resolveNodeConfigs, type SweepNode } from "./nodes.ts";
import { openReaperDb, resolveReaperDbPath } from "./reaper.db.ts";
import { DEFAULT_DRAIN_TIMEOUT_MS } from "./teardown.ts";
import { DEFAULT_DISK_FULL_REFUSAL_PCT, sweepNodes } from "./sweep.ts";

// ---------------------------------------------------------------------------
// Public surface — everything callers import stays on index.ts
// ---------------------------------------------------------------------------

export {
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_MAX_LIFETIME_MS,
  findVmByIdentity,
  hasActiveToolCalls,
  isDraining,
  isLeaseExpired,
} from "./teardown.ts";
export { createClientForNode, defaultNodeConfig, resolveNodeConfigs, type SweepNode } from "./nodes.ts";
export { DEFAULT_DISK_FULL_REFUSAL_PCT, sweep, sweepNodes } from "./sweep.ts";
export { STUCK_THRESHOLD, type NodeSweepState, type SweepLedger } from "./ledger.ts";

export interface SweepOptions {
  /** Injectable clock for tests. */
  now?: () => number;
  /** Hard timeout for in-flight artifact transfers (default 5 min). */
  drainTimeoutMs?: number;
  /** Disk-full refusal threshold in percent (default 15). */
  diskFullRefusalPct?: number;
  /** Root dir holding staged artifacts (fallback when scratchDir unset). */
  artifactDir?: string;
  /** Injectable disk-free probe for tests. Returns free percent (0-100). */
  diskFreePercent?: () => Promise<number>;
  /** Durable sweep-state ledger. Defaults to in-memory (no persistence). */
  ledger?: SweepLedger;
}

export interface SweepReport {
  /** Leases examined this sweep. */
  scanned: number;
  /** Leases that were expired/hard-capped and eligible for reaping. */
  expired: number;
  /** Leases skipped because an artifact is in-flight and within the hard timeout. */
  draining: number;
  /** VMs destroyed by identity (or already gone), files deleted, rows cleared. */
  destroyed: number;
  /** True when the sweep refused all destructive work (disk < refusal pct). */
  refusedDiskFull: boolean;
  /** Per-lease failures (identity collision, destroy error, ...). */
  errors: { vmId: string; message: string }[];
  /** Prominent alert lines (e.g. a node flipping to 'stuck'). */
  alerts: string[];
  /** Per-node sweep outcomes (multi-node; one entry per node touched). */
  nodes: NodeSweepResult[];
}

export interface NodeSweepResult {
  nodeId: string;
  outcome: NodeSweepOutcome;
  /** Derived shared NodeStatus after this sweep (see ledger.sweepStatusFor). */
  status: ReturnType<typeof sweepStatusFor>;
  /** Leases deferred (kept) for this node this sweep. */
  deferred: number;
  /** Leases destroyed for this node this sweep. */
  destroyed: number;
  /** Node-level failure (probe/unreachable); undefined when the node was swept. */
  error?: string;
}

/** Env names the binary reads (names only — values live in .env, gitignored). */
export const ENV = {
  db: "VMHUB_DB",
  leaseDir: "VMHUB_LEASE_DIR",
  artifactDir: "VMHUB_ARTIFACT_DIR",
  diskFullPct: "VMHUB_DISK_FULL_REFUSAL_PCT",
  drainTimeoutMs: "VMHUB_DRAIN_TIMEOUT_MS",
  intervalMs: "VMHUB_REAPER_INTERVAL_MS",
  nodes: "VMHUB_NODES",
} as const;

export interface ReaperRuntimeOptions {
  dbPath?: string;
  leaseDir?: string;
  artifactDir?: string;
  diskFullRefusalPct?: number;
  drainTimeoutMs?: number;
  /** Durable ledger path. Defaults to <dbdir>/sweeps.jsonl. */
  ledgerPath?: string;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Legacy single-node client factory (kept so existing deployments keep working). */
  createClient?: () => ProxmoxClient;
  /** Static per-node registry (frozen NodeConfig[]). Wins over createClient when present. */
  nodes?: NodeConfig[];
}

/** Build the per-node sweep registry from runtime options (defaults to one dl360p node). */
function buildSweepNodes(opts: ReaperRuntimeOptions): SweepNode[] {
  if (opts.nodes && opts.nodes.length > 0) {
    return opts.nodes.map((config) => ({ config, createClient: () => createClientForNode(config) }));
  }
  const config = defaultNodeConfig();
  return [{ config, createClient: opts.createClient ?? (() => createClientForNode(config)) }];
}

/**
 * Open the DB + durable ledger + per-node clients and run one sweep (the
 * oneshot systemd path). Ledger state is replayed at boot so a restarted
 * reaper keeps its stuck counters and deferral history — never memory only.
 */
export async function runOnce(opts: ReaperRuntimeOptions = {}): Promise<SweepReport> {
  const dbPath = opts.dbPath ?? resolveReaperDbPath();
  const db = await openReaperDb(dbPath);
  const ledger = new FileSweepLedger(opts.ledgerPath ?? join(dirname(dbPath), "sweeps.jsonl"));
  await ledger.load();
  try {
    return await sweepNodes(db, buildSweepNodes(opts), {
      artifactDir: opts.artifactDir,
      diskFullRefusalPct: opts.diskFullRefusalPct,
      drainTimeoutMs: opts.drainTimeoutMs,
      now: opts.now,
      ledger,
    });
  } finally {
    await ledger.flush().catch(() => {});
    ledger.close();
    db.close();
  }
}

/** CLI entrypoint: run once (systemd timer) or loop when VMHUB_REAPER_INTERVAL_MS is set. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  // Same precedence as lite's resolveDbPath: VMHUB_DB > <VMHUB_LEASE_DIR>/leases.sqlite.
  const dbPath = resolveReaperDbPath();
  const leaseDir = process.env[ENV.leaseDir];
  const artifactDir = process.env[ENV.artifactDir];
  const diskFullRefusalPct = Number(process.env[ENV.diskFullPct] ?? DEFAULT_DISK_FULL_REFUSAL_PCT);
  const drainTimeoutMs = Number(process.env[ENV.drainTimeoutMs] ?? DEFAULT_DRAIN_TIMEOUT_MS);
  const intervalMs = Number(process.env[ENV.intervalMs] ?? 0);
  const nodes = resolveNodeConfigs();

  if (argv.includes("--help")) {
    console.log(
      [
        "vmhub-reaper — independent lease reaper (per-node fail-closed sweep)",
        "",
        `  ${ENV.db}            sqlite path (default: <VMHUB_LEASE_DIR>/leases.sqlite)`,
        `  ${ENV.leaseDir}       lease dir (default: ./leases) — sweeps.jsonl ledger lives here`,
        `  ${ENV.artifactDir}    staged artifact root`,
        `  ${ENV.diskFullPct}    disk-full refusal %% (default ${DEFAULT_DISK_FULL_REFUSAL_PCT})`,
        `  ${ENV.drainTimeoutMs} in-flight transfer hard timeout ms (default ${DEFAULT_DRAIN_TIMEOUT_MS})`,
        `  ${ENV.intervalMs}     if > 0, loop instead of running once (dev)`,
        `  ${ENV.nodes}     comma-separated node ids (default: dl360p)`,
        `  VMHUB_NODE_<ID>_BASE_URL  per-node API base (default node falls back to PVE_HOST)`,
        `  VMHUB_NODE_<ID>_TOKEN     per-node token; absent → node-aware mock (dev/test)`,
        "",
        "Per-node fail-closed: unreachable nodes defer ALL their leases (rows kept,",
        "retried next sweep); after 3 consecutive auth-failed sweeps a node flips",
        "to 'stuck' and an alert line is emitted. Deferred leases are reconciled",
        "automatically when the node returns (idempotent sweep by identity tag).",
      ].join("\n"),
    );
    return;
  }

  const run = async () => {
    const report = await runOnce({
      dbPath,
      leaseDir,
      artifactDir,
      diskFullRefusalPct,
      drainTimeoutMs,
      nodes,
    });
    console.log(JSON.stringify(report, null, 2));
    return report;
  };

  if (intervalMs > 0) {
    // Dev watch loop; production uses the systemd timer (oneshot).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await run();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  await run();
}

// Allow direct execution: `bun src/reaper/index.ts`
if (import.meta.main) {
  await main().catch((err) => {
    console.error("vmhub-reaper failed:", err);
    process.exitCode = 1;
  });
}
