/**
 * LiteDb persistence tests (bun:sqlite). Run with `bun test src/lite`.
 */
import { describe, expect, test } from "vitest";
import { LiteDb } from "./db.ts";
import type { LeaseRow, VmRow } from "./db.ts";

function vmRow(uuid: string, vmid = 1000): VmRow {
  return {
    uuid,
    vmid,
    nodeId: 'dl360p',
    templateId: "hyprland-2404",
    adapter: "hyprland",
    capabilities: ["screenshot", "click"],
    proxmoxTag: `vmhub-hl-${uuid}`,
    namePrefix: "hl",
    status: "ready",
    createdAt: 1_000_000,
  };
}

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
    expect(db.getVmByVmid(1000)?.uuid).toBe("u1");
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
