/**
 * vmhub-reaper durable sweep-state ledger.
 *
 * Multi-node sweeps must never forget a node's health across reaper restarts:
 * if the process dies after two auth-failed sweeps, the third failure must
 * still flip the node to 'stuck' when a new reaper instance starts. The ledger
 * is the only cross-restart memory of per-node outcomes.
 *
 * Storage: append-only JSONL (one full NodeSweepState snapshot per line,
 * latest line per nodeId wins on load). It lives NEXT TO the shared
 * leases.sqlite as `<dbdir>/sweeps.jsonl` — deliberately OUT-OF-BAND of the
 * shared DDL, because the schema is the cross-lane contract with lite and must
 * stay additive-free. The DB rows (leases kept vs deleted) remain the ground
 * truth for WHAT is deferred; the ledger only records WHY and the counters.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NodeStatus } from "../shared/types.ts";

/** Per-node outcome of one sweep. */
export type NodeSweepOutcome = "ok" | "deferred" | "auth-failed" | "stuck";

/** Durable per-node sweep state — survives reaper restarts. */
export interface NodeSweepState {
  nodeId: string;
  /** Outcome of this node's last sweep. */
  lastOutcome: NodeSweepOutcome;
  /** Consecutive sweeps where the node could not be probed (401/5xx/timeout). */
  consecutiveAuthFailures: number;
  /** Monotonic count of whole-node deferral batches (unreachable sweeps). */
  deferredBatches: number;
  /** Leases currently deferred for this node (rows kept, retried next sweep). */
  deferredCount: number;
  /** Leases destroyed through this node, cumulative. */
  destroyedTotal: number;
  /** Last error recorded for this node (probe failure, unknown-node deferral). */
  lastError?: string;
  /** Unix ms of this node's last sweep. */
  lastSweepAt: number;
  /** Rolling alert history (e.g. the stuck alert). Bounded by the writer. */
  alerts: string[];
  /** Derived shared NodeStatus — see sweepStatusFor. */
  status: NodeStatus;
}

/** Consecutive auth-failed sweeps before a node is declared stuck. */
export const STUCK_THRESHOLD = 3;

/**
 * Derive the shared NodeStatus from ledger counters/outcome. This is the one
 * place the reaper writes NodeStatus 'stuck' / 'offline' / 'online'; lite's
 * GET /v1/nodes (parallel T8) reflects its own probe observations, and the
 * shared type stays the single contract.
 */
export function sweepStatusFor(
  state: Pick<NodeSweepState, "consecutiveAuthFailures" | "lastOutcome">,
): NodeStatus {
  if (state.consecutiveAuthFailures >= STUCK_THRESHOLD) return "stuck";
  if (state.lastOutcome === "auth-failed") return "offline";
  if (state.lastOutcome === "ok" || state.lastOutcome === "deferred") return "online";
  return "unknown";
}

/** Ledger seam — durable (file) or ephemeral (in-memory) implementations. */
export interface SweepLedger {
  /** Last recorded state for a node, or undefined when never swept. */
  getNode(nodeId: string): NodeSweepState | undefined;
  /** Persist a node's sweep outcome. */
  record(nodeId: string, state: NodeSweepState): void;
  /** Await all pending writes (file ledger). */
  flush(): Promise<void>;
  close(): void;
}

/** Ephemeral ledger for the legacy single-node sweep path / tests. */
export class InMemorySweepLedger implements SweepLedger {
  private readonly byNode = new Map<string, NodeSweepState>();

  getNode(nodeId: string): NodeSweepState | undefined {
    return this.byNode.get(nodeId);
  }

  record(nodeId: string, state: NodeSweepState): void {
    this.byNode.set(nodeId, state);
  }

  async flush(): Promise<void> {}

  close(): void {}
}

/**
 * Append-only JSONL ledger. load() replays the file (latest line per nodeId
 * wins); record() appends one snapshot line. Corruption-tolerant: a bad line is
 * skipped — the ledger is advisory, the lease rows are the ground truth.
 */
export class FileSweepLedger implements SweepLedger {
  private readonly byNode = new Map<string, NodeSweepState>();
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly path: string) {}

  /** Replay prior sweep state so a restarted reaper keeps its counters. */
  async load(): Promise<void> {
    try {
      const content = await readFile(this.path, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          const record = JSON.parse(trimmed) as NodeSweepState;
          if (typeof record.nodeId === "string") this.byNode.set(record.nodeId, record);
        } catch {
          // corrupt line — skip; DB rows remain the ground truth.
        }
      }
    } catch {
      // no ledger file yet (first run).
    }
  }

  getNode(nodeId: string): NodeSweepState | undefined {
    return this.byNode.get(nodeId);
  }

  record(nodeId: string, state: NodeSweepState): void {
    this.byNode.set(nodeId, state);
    if (this.closed) return;
    const line = `${JSON.stringify(state)}\n`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, { flag: "a" });
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  close(): void {
    this.closed = true;
  }
}
