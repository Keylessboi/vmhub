/**
 * LiteDb persistence tests (bun:sqlite). Run with `bun test src/lite`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_NODE_ID } from "../shared/schema.ts";
import { LiteDb, loadDbDriver } from "./db.ts";
import type { LeaseRow, VmRow } from "./db.ts";

function vmRow(uuid: string, vmid = 1000, nodeId = DEFAULT_NODE_ID): VmRow {
  return {
    uuid,
    vmid,
    nodeId,
    templateId: "hyprland-2404",
    adapter: "hyprland",
    capabilities: ["screenshot", "click"],
    proxmoxTag: `vmhub-hl-${uuid}`,
    namePrefix: "hl",
    status: "ready",
    createdAt: 1_000_000,
  };
}

/** vms DDL as it existed before multi-node support: vmid UNIQUE, no nodeId. */
const LEGACY_VMS_DDL = `
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
  ip           TEXT,
  scratchDir   TEXT,
  createdAt    INTEGER NOT NULL
);`;

function leaseRow(vmId: string, requestId: string): LeaseRow {
  return {
    vmId,
    owner: "test-agent",
    requestId,
    status: "active",
    expiresAt: 4_600_000,
    lastRenewedAt: 1_000_000,
    renewCount: 0,
    maxLifetimeMs: 86_400_000,
    createdAt: 1_000_000,
  };
}

describe("LiteDb vms", () => {
  test("insert/get/list/delete roundtrip preserves capabilities and optionals", () => {
    const db = new LiteDb(":memory:");
    const vm = { ...vmRow("u1"), sshPort: 2222, scratchDir: "/tmp/leases/u1" };
    db.insertVm(vm);
    const got = db.getVm("u1");
    expect(got).toEqual(vm);
    expect(db.getVmByNodeVmid("dl360p", 1000)?.uuid).toBe("u1");
    expect(db.getVmByNodeVmid("other-node", 1000)).toBeNull();
    expect(db.listVms()).toHaveLength(1);
    db.updateVmStatus("u1", "draining");
    expect(db.getVm("u1")?.status).toBe("draining");
    db.deleteVm("u1");
    expect(db.getVm("u1")).toBeNull();
    expect(db.listVms()).toHaveLength(0);
    db.close();
  });

  test("getVm without optionals returns undefined fields", () => {
    const db = new LiteDb(":memory:");
    db.insertVm(vmRow("u2"));
    const got = db.getVm("u2");
    expect(got?.sshPort).toBeUndefined();
    expect(got?.scratchDir).toBeUndefined();
    db.close();
  });
});

describe("LiteDb multi-node vms", () => {
  test("same vmid on different nodes coexists; same node + vmid throws UNIQUE", () => {
    const db = new LiteDb(":memory:");
    db.insertVm(vmRow("u-nodeA", 1000, "nodeA"));
    db.insertVm(vmRow("u-nodeB", 1000, "nodeB"));
    expect(db.listVms()).toHaveLength(2);

    expect(db.getVmByNodeVmid("nodeA", 1000)?.uuid).toBe("u-nodeA");
    expect(db.getVmByNodeVmid("nodeB", 1000)?.uuid).toBe("u-nodeB");

    expect(() => db.insertVm(vmRow("u-nodeA-dup", 1000, "nodeA"))).toThrow(/UNIQUE/);
    expect(db.listVms()).toHaveLength(2);
    db.close();
  });

  test("getVmByNodeVmid scopes by node — wrong node or unknown vmid is null", () => {
    const db = new LiteDb(":memory:");
    db.insertVm(vmRow("u1", 1000, "nodeA"));
    expect(db.getVmByNodeVmid("nodeA", 1000)?.uuid).toBe("u1");
    expect(db.getVmByNodeVmid("nodeB", 1000)).toBeNull();
    expect(db.getVmByNodeVmid("nodeA", 999)).toBeNull();
    db.close();
  });
});

describe("LiteDb legacy backfill", () => {
  test("old-format DB (no nodeId column) opens: rows backfill to dl360p, new rows insert", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vmhub-legacy-db-"));
    const dbPath = join(dir, "leases.sqlite");
    const Ctor = await loadDbDriver();
    try {
      const legacy = new Ctor(dbPath);
      legacy.exec(LEGACY_VMS_DDL);
      legacy
        .prepare(
          `INSERT INTO vms (uuid, vmid, templateId, adapter, capabilities, proxmoxTag, namePrefix, status, sshPort, scratchDir, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("legacy-u1", 1000, "hyprland-2404", "hyprland", '["screenshot"]', "vmhub-hl-legacy-u1", "hl", "ready", null, null, 1_000_000);
      legacy.close();

      const db = new LiteDb(dbPath);
      const legacyVm = db.getVm("legacy-u1");
      expect(legacyVm?.vmid).toBe(1000);
      expect(legacyVm?.nodeId).toBe(DEFAULT_NODE_ID);

      db.insertVm(vmRow("u2", 1001));
      expect(db.getVm("u2")?.nodeId).toBe(DEFAULT_NODE_ID);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("LiteDb leases", () => {
  test("insert/get/idempotency lookup/update/release", () => {
    const db = new LiteDb(":memory:");
    db.insertLease(leaseRow("u1", "req-1"));
    expect(db.getLease("u1")?.requestId).toBe("req-1");
    expect(db.getLeaseByRequestId("req-1")?.vmId).toBe("u1");
    expect(db.listActiveLeases()).toHaveLength(1);

    db.updateLease({ ...leaseRow("u1", "req-1"), expiresAt: 9_000_000, renewCount: 3 });
    expect(db.getLease("u1")?.expiresAt).toBe(9_000_000);
    expect(db.getLease("u1")?.renewCount).toBe(3);

    db.markLeaseReleased("u1", 5_000_000);
    expect(db.getLease("u1")?.status).toBe("released");
    expect(db.listActiveLeases()).toHaveLength(0);
    db.close();
  });

  test("requestId is UNIQUE — duplicate insert throws", () => {
    const db = new LiteDb(":memory:");
    db.insertLease(leaseRow("u1", "req-1"));
    expect(() => db.insertLease(leaseRow("u2", "req-1"))).toThrow();
    db.close();
  });
});

describe("LiteDb artifacts", () => {
  test("insert/get/list/in-flight/delete", () => {
    const db = new LiteDb(":memory:");
    db.insertArtifact({
      id: "a1",
      leaseId: "u1",
      hostPath: "/tmp/staged.bin",
      sizeBytes: 42,
      inFlight: false,
      createdAt: 1_000_000,
    });
    db.insertArtifact({
      id: "a2",
      leaseId: "u1",
      hostPath: "/tmp/staged2.bin",
      sizeBytes: 7,
      inFlight: true,
      createdAt: 1_000_001,
    });
    expect(db.getArtifact("a1")).toMatchObject({ sizeBytes: 42, inFlight: false });
    expect(db.getArtifact("a2")?.inFlight).toBe(true);
    expect(db.listArtifactsForLease("u1")).toHaveLength(2);
    expect(db.countInFlightArtifacts("u1")).toBe(1);

    db.setArtifactInFlight("a2", false);
    expect(db.countInFlightArtifacts("u1")).toBe(0);

    db.deleteArtifactsForLease("u1");
    expect(db.listArtifactsForLease("u1")).toHaveLength(0);
    expect(db.getArtifact("a1")).toBeNull();
    db.close();
  });

  test("getArtifact unknown id → null", () => {
    const db = new LiteDb(":memory:");
    expect(db.getArtifact("nope")).toBeNull();
    db.close();
  });
});
