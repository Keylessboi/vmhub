/**
 * Shared SQLite DDL + column lists for the vms/leases/artifacts tables.
 *
 * THE single schema source, imported by BOTH vmhub-lite (src/lite/db.ts) and
 * vmhub-reaper (src/reaper/reaper.db.ts). Replaces the byte-identical
 * SCHEMA/SCHEMA_SQL dual-file copies that could drift apart.
 *
 * Driver constraint: this module MUST stay free of `bun:sqlite` / `node:sqlite`
 * imports. The reaper lane runs under vitest's node pool, which cannot resolve
 * bun:sqlite; keeping driver imports out of here lets both lanes import the
 * DDL safely. Column lists are exported so INSERT/SELECT statements in both
 * lanes come from the same source too.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vms (
  uuid         TEXT PRIMARY KEY,
  vmid         INTEGER NOT NULL,
  nodeId       TEXT NOT NULL DEFAULT '',
  templateId   TEXT NOT NULL,
  adapter      TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  proxmoxTag   TEXT NOT NULL,
  namePrefix   TEXT NOT NULL,
  status       TEXT NOT NULL,
  sshPort      INTEGER,
  ip           TEXT,
  scratchDir   TEXT,
  createdAt    INTEGER NOT NULL,
  activeToolCalls INTEGER NOT NULL DEFAULT 0,
  UNIQUE(nodeId, vmid)
);

CREATE INDEX IF NOT EXISTS idx_vms_proxmoxTag ON vms (proxmoxTag);

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
  inFlightAt INTEGER,
  createdAt INTEGER NOT NULL
);
`;

export const VMS_COLUMNS =
  "uuid, vmid, nodeId, templateId, adapter, capabilities, proxmoxTag, namePrefix, status, sshPort, ip, scratchDir, createdAt, activeToolCalls";
export const LEASES_COLUMNS =
  "vmId, owner, requestId, status, expiresAt, lastRenewedAt, renewCount, maxLifetimeMs, createdAt";
export const ARTIFACTS_COLUMNS = "id, leaseId, hostPath, sizeBytes, inFlight, inFlightAt, createdAt";

/**
 * The single node that existed before multi-node support. Legacy Vm rows get
 * backfilled to this id; single-node deployments keep it as their default.
 */
export const DEFAULT_NODE_ID = "dl360p";

/**
 * Additive column migrations, applied by EVERY lane that opens the database.
 *
 * SCHEMA_SQL is all `CREATE TABLE IF NOT EXISTS`, so it cannot add a column to
 * a table that already exists. These ALTERs carry that load. They live here,
 * not in lite, because the reaper opens the same file: when only lite migrated,
 * a reaper newer than the deployed lite crashed on `no such column:
 * v.activeToolCalls` and every sweep failed until lite happened to be
 * redeployed. Whoever opens the DB first now brings it up to date.
 *
 * Each entry is idempotent — guarded by a PRAGMA table_info check — so running
 * them repeatedly, from either lane, in any order, is safe.
 */
export const COLUMN_MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: "vms", column: "ip", ddl: "ALTER TABLE vms ADD COLUMN ip TEXT;" },
  {
    table: "vms",
    column: "nodeId",
    ddl: `ALTER TABLE vms ADD COLUMN nodeId TEXT NOT NULL DEFAULT '${DEFAULT_NODE_ID}';`,
  },
  {
    table: "vms",
    column: "activeToolCalls",
    ddl: "ALTER TABLE vms ADD COLUMN activeToolCalls INTEGER NOT NULL DEFAULT 0;",
  },
  { table: "artifacts", column: "inFlightAt", ddl: "ALTER TABLE artifacts ADD COLUMN inFlightAt INTEGER;" },
];

/** Minimal surface needed to run the migrations (both drivers satisfy it). */
export interface MigratableDb {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
}

/** Apply every missing additive column. Safe to call on every open. */
export function applyColumnMigrations(db: MigratableDb): void {
  const columnsByTable = new Map<string, Set<string>>();
  for (const { table } of COLUMN_MIGRATIONS) {
    if (columnsByTable.has(table)) continue;
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    columnsByTable.set(table, new Set(cols.map((c) => c.name)));
  }
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    if (columnsByTable.get(table)?.has(column)) continue;
    db.exec(ddl);
  }
}
