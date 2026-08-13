/**
 * vmhub-lite SQLite persistence. Three tables:
 *   vms       — every VM the control plane has created
 *   leases    — active/released leases (requestId is UNIQUE for idempotency)
 *   artifacts — lease-scratch artifact registry (inFlight flag protects vm_get_file)
 *
 * In-memory (`:memory:`) is supported for tests. The schema is created
 * idempotently so the DB file can be reopened across restarts.
 *
 * Driver: runtime-adaptive — prefers `bun:sqlite` (bun test, compiled
 * binaries) and falls back to `node:sqlite` (vitest's node pool). Both expose
 * the same prepare/exec surface, so one code path serves both runtimes.
 */
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ArtifactRecord, Vm } from "../shared/types.ts";

export type LeaseStatus = "active" | "released";

/** Minimal statement surface both SQLite drivers expose. */
export interface DbStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Record<string, unknown> | null | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** Minimal database surface both drivers expose. */
export interface DbConnection {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

export type DbCtor = new (path: string) => DbConnection;

let cachedDriver: DbCtor | undefined;

/** Prefer bun:sqlite, fall back to node:sqlite. Loaded once per process. */
export async function loadDbDriver(): Promise<DbCtor> {
  if (cachedDriver) return cachedDriver;
  try {
    const m = await import("bun:sqlite");
    cachedDriver = m.Database as unknown as DbCtor;
  } catch {
    const m = await import("node:sqlite");
    cachedDriver = m.DatabaseSync as unknown as DbCtor;
  }
  return cachedDriver;
}

const dbCtor = await loadDbDriver();

/**
 * Single source of truth for the leases.sqlite path, shared with the reaper
 * lane. Precedence: VMHUB_DB (explicit file) > VMHUB_LEASE_DIR (directory).
 */
export function resolveDbPath(leaseDir = process.env.VMHUB_LEASE_DIR ?? "./leases"): string {
  const explicit = process.env.VMHUB_DB;
  if (explicit && explicit.trim() !== "") return explicit;
  return join(leaseDir, "leases.sqlite");
}

/** Lease row: shared Lease fields plus v1 status/createdAt. */
export interface LeaseRow {
  vmId: string;
  owner: string;
  requestId: string;
  status: LeaseStatus;
  expiresAt: number;
  lastRenewedAt: number;
  renewCount: number;
  maxLifetimeMs: number;
  createdAt: number;
}

/** Vm row: shared Vm plus the internal Proxmox VMID (never a vmhub identity). */
export interface VmRow extends Vm {
  vmid: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vms (
  uuid         TEXT PRIMARY KEY,
  vmid         INTEGER NOT NULL UNIQUE,
  templateId   TEXT NOT NULL,
  adapter      TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  proxmoxTag   TEXT NOT NULL,
  namePrefix   TEXT NOT NULL,
  status       TEXT NOT NULL,
  sshPort      INTEGER,
  scratchDir   TEXT,
  createdAt    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS leases (
  vmId          TEXT PRIMARY KEY,
  owner         TEXT NOT NULL,
  requestId     TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL,
  expiresAt     INTEGER NOT NULL,
  lastRenewedAt INTEGER NOT NULL,
  renewCount    INTEGER NOT NULL,
  maxLifetimeMs INTEGER NOT NULL,
  createdAt     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id        TEXT PRIMARY KEY,
  leaseId   TEXT NOT NULL,
  hostPath  TEXT NOT NULL,
  sizeBytes INTEGER NOT NULL,
  inFlight  INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL
);
`;

const VMS_COLUMNS =
  "uuid, vmid, templateId, adapter, capabilities, proxmoxTag, namePrefix, status, sshPort, scratchDir, createdAt";
const LEASES_COLUMNS =
  "vmId, owner, requestId, status, expiresAt, lastRenewedAt, renewCount, maxLifetimeMs, createdAt";
const ARTIFACTS_COLUMNS = "id, leaseId, hostPath, sizeBytes, inFlight, createdAt";

export class LiteDb {
  private db: DbConnection;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new dbCtor(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // VMs
  // -------------------------------------------------------------------------

  insertVm(vm: VmRow): void {
    this.db
      .query(
        `INSERT INTO vms (${VMS_COLUMNS})
         VALUES ($uuid, $vmid, $templateId, $adapter, $capabilities, $proxmoxTag, $namePrefix, $status, $sshPort, $scratchDir, $createdAt)`,
      )
      .run(
        vm.uuid,
        vm.vmid,
        vm.templateId,
        vm.adapter,
        JSON.stringify(vm.capabilities),
        vm.proxmoxTag,
        vm.namePrefix,
        vm.status,
        vm.sshPort ?? null,
        vm.scratchDir ?? null,
        vm.createdAt,
      );
  }

  getVm(uuid: string): VmRow | null {
    const row = this.db.query(`SELECT ${VMS_COLUMNS} FROM vms WHERE uuid = ?`).get(uuid);
    return rowToVm(row);
  }

  getVmByVmid(vmid: number): VmRow | null {
    const row = this.db.query(`SELECT ${VMS_COLUMNS} FROM vms WHERE vmid = ?`).get(vmid);
    return rowToVm(row);
  }

  listVms(): VmRow[] {
    const rows = this.db.query(`SELECT ${VMS_COLUMNS} FROM vms ORDER BY createdAt`).all();
    return rows.map(rowToVm).filter((vm): vm is VmRow => vm !== null);
  }

  updateVmStatus(uuid: string, status: Vm["status"]): void {
    this.db.query("UPDATE vms SET status = ? WHERE uuid = ?").run(status, uuid);
  }

  deleteVm(uuid: string): void {
    this.db.query("DELETE FROM vms WHERE uuid = ?").run(uuid);
  }

  // -------------------------------------------------------------------------
  // Leases
  // -------------------------------------------------------------------------

  insertLease(lease: LeaseRow): void {
    this.db
      .query(
        `INSERT INTO leases (${LEASES_COLUMNS})
         VALUES ($vmId, $owner, $requestId, $status, $expiresAt, $lastRenewedAt, $renewCount, $maxLifetimeMs, $createdAt)`,
      )
      .run(
        lease.vmId,
        lease.owner,
        lease.requestId,
        lease.status,
        lease.expiresAt,
        lease.lastRenewedAt,
        lease.renewCount,
        lease.maxLifetimeMs,
        lease.createdAt,
      );
  }

  getLease(vmId: string): LeaseRow | null {
    const row = this.db.query(`SELECT ${LEASES_COLUMNS} FROM leases WHERE vmId = ?`).get(vmId);
    return rowToLease(row);
  }

  /** Idempotency lookup: the requestId → lease mapping. */
  getLeaseByRequestId(requestId: string): LeaseRow | null {
    const row = this.db
      .query(`SELECT ${LEASES_COLUMNS} FROM leases WHERE requestId = ?`)
      .get(requestId);
    return rowToLease(row);
  }

  updateLease(lease: LeaseRow): void {
    this.db
      .query(
        `UPDATE leases SET owner = ?, requestId = ?, status = ?, expiresAt = ?, lastRenewedAt = ?, renewCount = ?, maxLifetimeMs = ?, createdAt = ?
         WHERE vmId = ?`,
      )
      .run(
        lease.owner,
        lease.requestId,
        lease.status,
        lease.expiresAt,
        lease.lastRenewedAt,
        lease.renewCount,
        lease.maxLifetimeMs,
        lease.createdAt,
        lease.vmId,
      );
  }

  markLeaseReleased(vmId: string, now: number): void {
    this.db
      .query("UPDATE leases SET status = 'released', lastRenewedAt = ? WHERE vmId = ?")
      .run(now, vmId);
  }

  listActiveLeases(): LeaseRow[] {
    const rows = this.db
      .query(`SELECT ${LEASES_COLUMNS} FROM leases WHERE status = 'active' ORDER BY createdAt`)
      .all();
    return rows.map(rowToLease).filter((l): l is LeaseRow => l !== null);
  }

  // -------------------------------------------------------------------------
  // Artifacts
  // -------------------------------------------------------------------------

  insertArtifact(record: ArtifactRecord): void {
    this.db
      .query(
        `INSERT INTO artifacts (${ARTIFACTS_COLUMNS})
         VALUES ($id, $leaseId, $hostPath, $sizeBytes, $inFlight, $createdAt)`,
      )
      .run(
        record.id,
        record.leaseId,
        record.hostPath,
        record.sizeBytes,
        record.inFlight ? 1 : 0,
        record.createdAt,
      );
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this.db.query(`SELECT ${ARTIFACTS_COLUMNS} FROM artifacts WHERE id = ?`).get(id);
    return rowToArtifact(row);
  }

  listArtifactsForLease(leaseId: string): ArtifactRecord[] {
    const rows = this.db
      .query(`SELECT ${ARTIFACTS_COLUMNS} FROM artifacts WHERE leaseId = ? ORDER BY createdAt`)
      .all(leaseId);
    return rows.map(rowToArtifact).filter((a): a is ArtifactRecord => a !== null);
  }

  setArtifactInFlight(id: string, inFlight: boolean): void {
    this.db.query("UPDATE artifacts SET inFlight = ? WHERE id = ?").run(inFlight ? 1 : 0, id);
  }

  deleteArtifactsForLease(leaseId: string): void {
    this.db.query("DELETE FROM artifacts WHERE leaseId = ?").run(leaseId);
  }

  /** Count artifacts still marked in-flight (reaper draining check). */
  countInFlightArtifacts(leaseId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) AS n FROM artifacts WHERE leaseId = ? AND inFlight = 1")
      .get(leaseId) as { n: number };
    return Number(row.n);
  }
}

// ---------------------------------------------------------------------------
// Row mappers (SQLite rows are Record<string, unknown>; `capabilities`/`inFlight`
// are stored as JSON / 0-1 and converted here).
// ---------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

function rowToVm(row: unknown): VmRow | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as SqlRow;
  return {
    uuid: String(r.uuid),
    vmid: Number(r.vmid),
    templateId: String(r.templateId),
    adapter: String(r.adapter),
    capabilities: JSON.parse(String(r.capabilities)) as Vm["capabilities"],
    proxmoxTag: String(r.proxmoxTag),
    namePrefix: String(r.namePrefix),
    status: String(r.status) as Vm["status"],
    sshPort: r.sshPort == null ? undefined : Number(r.sshPort),
    scratchDir: r.scratchDir == null ? undefined : String(r.scratchDir),
    createdAt: Number(r.createdAt),
  };
}

function rowToLease(row: unknown): LeaseRow | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as SqlRow;
  return {
    vmId: String(r.vmId),
    owner: String(r.owner),
    requestId: String(r.requestId),
    status: String(r.status) as LeaseStatus,
    expiresAt: Number(r.expiresAt),
    lastRenewedAt: Number(r.lastRenewedAt),
    renewCount: Number(r.renewCount),
    maxLifetimeMs: Number(r.maxLifetimeMs),
    createdAt: Number(r.createdAt),
  };
}

function rowToArtifact(row: unknown): ArtifactRecord | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as SqlRow;
  return {
    id: String(r.id),
    leaseId: String(r.leaseId),
    hostPath: String(r.hostPath),
    sizeBytes: Number(r.sizeBytes),
    inFlight: Number(r.inFlight) === 1,
    createdAt: Number(r.createdAt),
  };
}
