/**
 * vmhub-reaper DB layer unit tests — schema contract + active-only reaping.
 *
 * Uses a temp file (not `:memory:`) because the fixture writer and the reaper
 * each hold their own connection; in-memory SQLite is per-connection.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRecord, Lease, Vm } from "../shared/types.ts";
import { loadDbDriver, openReaperDb, SCHEMA_SQL, type DbConnection, type ReaperDb } from "./reaper.db.ts";

let dir: string;
let dbPath: string;

function makeVm(uuid: string, vmid: number): Vm {
  return {
    uuid,
    nodeId: 'dl360p',
    templateId: "windows-11-24h2",
    adapter: "windows",
    capabilities: ["screenshot"],
    proxmoxTag: `vmhub-win-${uuid}`,
    namePrefix: "win",
    status: "ready",
    sshPort: vmid,
    createdAt: 1_000,
  };
}

function makeLease(vmId: string): Lease {
  return {
    vmId,
    owner: "agent-1",
    requestId: `req-${vmId}`,
    expiresAt: 10_000,
    lastRenewedAt: 5_000,
    renewCount: 0,
    maxLifetimeMs: 86_400_000,
  };
}

async function insertFixture(
  conn: DbConnection,
  vm: Vm,
  lease: Lease,
  leaseStatus: "active" | "released" = "active",
  artifacts: ArtifactRecord[] = [],
): Promise<void> {
  conn
    .prepare(
      `INSERT INTO vms (uuid, vmid, nodeId, templateId, adapter, capabilities, proxmoxTag, namePrefix, status, sshPort, scratchDir, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      vm.uuid,
      vm.sshPort ?? 1000,
      vm.nodeId,
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
  conn
    .prepare(
      `INSERT INTO leases (vmId, owner, requestId, status, expiresAt, lastRenewedAt, renewCount, maxLifetimeMs, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      lease.vmId,
      lease.owner,
      lease.requestId,
      leaseStatus,
      lease.expiresAt,
      lease.lastRenewedAt,
      lease.renewCount,
      lease.maxLifetimeMs,
      lease.lastRenewedAt,
    );
  for (const a of artifacts) {
    conn
      .prepare(
        `INSERT INTO artifacts (id, leaseId, hostPath, sizeBytes, inFlight, createdAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.leaseId, a.hostPath, a.sizeBytes, a.inFlight ? 1 : 0, a.createdAt);
  }
}

describe("reaper.db", () => {
  let db: ReaperDb;
  let conn: DbConnection;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vmhub-reaper-db-"));
    dbPath = join(dir, "leases.sqlite");
    const Ctor = await loadDbDriver();
    conn = new Ctor(dbPath);
    conn.exec(SCHEMA_SQL);
  });

  afterEach(async () => {
    conn.close();
    db?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("opens the shared schema and lists active leases with their VMs", async () => {
    await insertFixture(conn, makeVm("u-1", 1000), makeLease("u-1"));
    db = await openReaperDb(dbPath);

    const all = db.listLeasesWithVm();
    expect(all).toHaveLength(1);
    expect(all[0]?.vm.uuid).toBe("u-1");
    expect(all[0]?.lease.expiresAt).toBe(10_000);
  });

  it("join carries nodeId into each lease's VM", async () => {
    await insertFixture(conn, { ...makeVm("u-1", 1000), nodeId: "node-b" }, makeLease("u-1"));
    await insertFixture(conn, { ...makeVm("u-2", 1001), nodeId: "dl360p" }, makeLease("u-2"));
    db = await openReaperDb(dbPath);

    const byUuid = new Map(db.listLeasesWithVm().map((l) => [l.vm.uuid, l.vm]));
    expect(byUuid.get("u-1")?.nodeId).toBe("node-b");
    expect(byUuid.get("u-2")?.nodeId).toBe("dl360p");
  });

  it("skips released leases — only active leases are reaped", async () => {
    await insertFixture(conn, makeVm("u-active", 1000), makeLease("u-active"), "active");
    await insertFixture(conn, makeVm("u-released", 1001), makeLease("u-released"), "released");
    db = await openReaperDb(dbPath);

    const all = db.listLeasesWithVm();
    expect(all.map((l) => l.vm.uuid)).toEqual(["u-active"]);
  });

  it("joins artifacts into each lease", async () => {    await insertFixture(
      conn,
      makeVm("u-1", 1000),
      makeLease("u-1"),
      "active",
      [
        { id: "a-1", leaseId: "u-1", hostPath: "x.bin", sizeBytes: 5, inFlight: true, createdAt: 9_000 },
        { id: "a-2", leaseId: "u-1", hostPath: "y.bin", sizeBytes: 6, inFlight: false, createdAt: 8_000 },
      ],
    );
    db = await openReaperDb(dbPath);

    const all = db.listLeasesWithVm();
    expect(all[0]?.artifacts).toHaveLength(2);
    expect(all[0]?.artifacts[0]?.inFlight).toBe(true);
  });

  it("deleteLease removes the lease, its VM and all its artifacts in one transaction", async () => {
    await insertFixture(
      conn,
      makeVm("u-1", 1000),
      makeLease("u-1"),
      "active",
      [{ id: "a-1", leaseId: "u-1", hostPath: "x.bin", sizeBytes: 5, inFlight: false, createdAt: 9_000 }],
    );
    await insertFixture(conn, makeVm("u-2", 1001), makeLease("u-2"));
    db = await openReaperDb(dbPath);

    db.deleteLease("u-1");

    expect(db.listLeasesWithVm().map((l) => l.vm.uuid)).toEqual(["u-2"]);
    expect(db.listArtifacts()).toEqual([]);
  });

  it("markVmDestroyed flips the VM status to destroyed", async () => {
    await insertFixture(conn, makeVm("u-1", 1000), makeLease("u-1"));
    db = await openReaperDb(dbPath);

    db.markVmDestroyed("u-1");
    const vm = db.listLeasesWithVm()[0]?.vm;
    expect(vm?.status).toBe("destroyed");
  });
});
