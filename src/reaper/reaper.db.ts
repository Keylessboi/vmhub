/**
 * vmhub-reaper DB layer — independent access to the shared leases.sqlite.
 *
 * The reaper does NOT go through vmhub-lite's HTTP API (independence is the
 * point): it opens the same SQLite file directly and talks to the Proxmox API
 * directly. Only `active` leases are reaped; `released` ones are already done.
 *
 * The schema is the cross-lane contract — column names match src/lite/db.ts
 * EXACTLY (camelCase, vmid column, lease status + createdAt). Do not rename.
 *
 * SQLite driver: the runtime-adaptive loader prefers `bun:sqlite` (the
 * compiled reaper binary runs under Bun) and falls back to `node:sqlite`
 * (vitest runs under Node). Both expose the same prepare/exec surface.
 */

import type { ArtifactRecord, Lease, Vm, VmStatus } from "../shared/types.ts";
import { join } from "node:path";
import { DEFAULT_NODE_ID, SCHEMA_SQL } from "../shared/schema.ts";

/** Env-var name for the SQLite path (shared with lite). */
export const VMHUB_DB_ENV = "VMHUB_DB";

/** Env-var name for the lease dir (shared with lite). */
export const VMHUB_LEASE_DIR_ENV = "VMHUB_LEASE_DIR";

/** Default lease dir — mirrors lite's default. */
export const DEFAULT_LEASE_DIR = "leases";

/**
 * Mirror of lite's resolveDbPath() (same precedence so both lanes open the
 * SAME file): VMHUB_DB (explicit file) > <VMHUB_LEASE_DIR>/leases.sqlite.
 * Implemented locally, not imported from lite/db.ts, because lite/db.ts
 * statically imports bun:sqlite which vitest's node pool cannot resolve.
 */
export function resolveReaperDbPath(leaseDir = process.env[VMHUB_LEASE_DIR_ENV] ?? DEFAULT_LEASE_DIR): string {
  const explicit = process.env[VMHUB_DB_ENV];
  if (explicit && explicit.trim() !== "") return explicit;
  return join(leaseDir, "leases.sqlite");
}

/** Minimal statement surface both drivers expose. */
export interface DbStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** Minimal database surface both drivers expose. */
export interface DbConnection {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

type DbCtor = { new (path: string): DbConnection };

/**
 * Load the SQLite driver. Prefers `bun:sqlite` (reaper binary runs under Bun);
 * falls back to `node:sqlite` (vitest runs under Node). Both drivers expose
 * the same prepare/exec API, so one code path serves both runtimes.
 */
export async function loadDbDriver(): Promise<DbCtor> {
  try {
    const m = await import("bun:sqlite");
    return m.Database as unknown as DbCtor;
  } catch {
    const m = await import("node:sqlite");
    return m.DatabaseSync as unknown as DbCtor;
  }
}

/**
 * Schema DDL — shared with src/lite/db.ts via src/shared/schema.ts (the single
 * source of truth). Exported here for tests that bootstrap the same tables.
 */
export { SCHEMA_SQL } from "../shared/schema.ts";

interface VmRow {
  uuid: string;
  vmid: number;
  nodeId: string;
  templateId: string;
  adapter: string;
  capabilities: string;
  proxmoxTag: string;
  namePrefix: string;
  status: string;
  sshPort: number | null;
  ip: string | null;
  scratchDir: string | null;
  createdAt: number;
}

interface LeaseRow {
  vmId: string;
  owner: string;
  requestId: string;
  status: string;
  expiresAt: number;
  lastRenewedAt: number;
  renewCount: number;
  maxLifetimeMs: number;
  createdAt: number;
}

interface ArtifactRow {
  id: string;
  leaseId: string;
  hostPath: string;
  sizeBytes: number;
  inFlight: number;
  createdAt: number;
}

/** Parsed lease joined with its VM + artifacts — the reaper's working unit. */
export interface LeaseWithVm {
  vm: Vm;
  lease: Lease;
  artifacts: ArtifactRecord[];
}

function parseVmRow(r: Record<string, unknown>): Vm {
  const row = r as unknown as VmRow;
  return {
    uuid: row.uuid,
    nodeId: row.nodeId ?? DEFAULT_NODE_ID,
    templateId: row.templateId,
    adapter: row.adapter,
    capabilities: JSON.parse(row.capabilities) as Vm["capabilities"],
    proxmoxTag: row.proxmoxTag,
    namePrefix: row.namePrefix,
    status: row.status as VmStatus,
    sshPort: row.sshPort ?? undefined,
    ip: row.ip ?? undefined,
    scratchDir: row.scratchDir ?? undefined,
    createdAt: row.createdAt,
  };
}

function parseLeaseRow(r: Record<string, unknown>): Lease {
  const row = r as unknown as LeaseRow;
  return {
    vmId: row.vmId,
    owner: row.owner,
    requestId: row.requestId,
    expiresAt: row.expiresAt,
    lastRenewedAt: row.lastRenewedAt,
    renewCount: row.renewCount,
    maxLifetimeMs: row.maxLifetimeMs,
  };
}

function parseArtifactRow(r: Record<string, unknown>): ArtifactRecord {
  const row = r as unknown as ArtifactRow;
  return {
    id: row.id,
    leaseId: row.leaseId,
    hostPath: row.hostPath,
    sizeBytes: row.sizeBytes,
    inFlight: row.inFlight === 1,
    createdAt: row.createdAt,
  };
}

/** Wrapper over a live sqlite connection, mockable for tests. */
export interface ReaperDb {
  /** List every ACTIVE lease with its VM, oldest-expiring first. */
  listLeasesWithVm(): LeaseWithVm[];
  /** Every artifact row across all leases. */
  listArtifacts(): ArtifactRecord[];
  /** Remove the lease + its VM row + all its artifact rows. */
  deleteLease(vmId: string): void;
  /** Mark the VM row destroyed so future sweeps skip it. */
  markVmDestroyed(vmId: string): void;
  /** Remove a single artifact row by id (after its staged file is deleted). */
  deleteArtifact(artifactId: string): void;
  close(): void;
}

/** Concrete ReaperDb backed by a live sqlite connection. */
class SqliteReaperDb implements ReaperDb {
  readonly #db: DbConnection;

  constructor(db: DbConnection) {
    this.#db = db;
    this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(SCHEMA_SQL);
  }

  listLeasesWithVm(): LeaseWithVm[] {
    const rows = this.#db
      .prepare(
        `SELECT v.uuid, v.vmid, v.nodeId, v.templateId, v.adapter, v.capabilities, v.proxmoxTag,
                v.namePrefix, v.status, v.sshPort, v.ip, v.scratchDir, v.createdAt,
                l.vmId, l.owner, l.requestId, l.status AS leaseStatus, l.expiresAt,
                l.lastRenewedAt, l.renewCount, l.maxLifetimeMs
         FROM leases l
         JOIN vms v ON v.uuid = l.vmId
         WHERE l.status = 'active'
         ORDER BY l.expiresAt ASC`,
      )
      .all();

    const artifactsByLease = new Map<string, ArtifactRecord[]>();
    for (const a of this.listArtifacts()) {
      const list = artifactsByLease.get(a.leaseId) ?? [];
      list.push(a);
      artifactsByLease.set(a.leaseId, list);
    }

    return rows.map((r) => {
      const vm = parseVmRow(r);
      return {
        vm,
        lease: parseLeaseRow(r),
        artifacts: artifactsByLease.get(vm.uuid) ?? [],
      };
    });
  }

  listArtifacts(): ArtifactRecord[] {
    return this.#db
      .prepare("SELECT id, leaseId, hostPath, sizeBytes, inFlight, createdAt FROM artifacts")
      .all()
      .map(parseArtifactRow);
  }

  deleteLease(vmId: string): void {
    this.#db.exec("BEGIN");
    try {
      this.#db.prepare("DELETE FROM artifacts WHERE leaseId = ?").run(vmId);
      this.#db.prepare("DELETE FROM leases WHERE vmId = ?").run(vmId);
      this.#db.prepare("DELETE FROM vms WHERE uuid = ?").run(vmId);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  markVmDestroyed(vmId: string): void {
    this.#db.prepare("UPDATE vms SET status = 'destroyed' WHERE uuid = ?").run(vmId);
  }

  deleteArtifact(artifactId: string): void {
    this.#db.prepare("DELETE FROM artifacts WHERE id = ?").run(artifactId);
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * Open (and if needed, create) the shared leases.sqlite.
 * @param dbPath path to the SQLite file — defaults to resolveReaperDbPath().
 * @param driver explicit driver for tests (defaults to the adaptive loader).
 */
export async function openReaperDb(
  dbPath: string = resolveReaperDbPath(),
  driver?: DbCtor,
): Promise<ReaperDb> {
  const Ctor = driver ?? (await loadDbDriver());
  return new SqliteReaperDb(new Ctor(dbPath));
}
