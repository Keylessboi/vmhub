/**
 * vmhub-reaper kill-test — the plan's key gate (Phase 1.4).
 *
 * Simulates an agent being SIGKILLed mid-lease: a lease is created (VM rows in
 * the shared leases.sqlite + a running VM in MockProxmox + staged artifact and
 * lease files on disk), the agent dies without renewing, and a reaper sweep
 * must reclaim EVERYTHING — the VM (by tag+prefix identity, never VMID), the
 * lease row, the artifact row, the staged files and the scratch dir.
 *
 * Guardrail coverage: DRAINING refusal + hard timeout, 24 h hard cap,
 * 15 % disk-full refusal, identity-verified destroy (foreign VMs untouched).
 */

import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockProxmox, type ProxmoxClient } from "../lite/proxmox.ts";
import { RealProxmox } from "../lite/proxmox-real.ts";
import type { ArtifactRecord, Lease, Vm } from "../shared/types.ts";
import {
  DEFAULT_DISK_FULL_REFUSAL_PCT,
  DEFAULT_DRAIN_TIMEOUT_MS,
  createClientForNode,
  defaultNodeConfig,
  findVmByIdentity,
  isDraining,
  isLeaseExpired,
  resolveNodeConfigs,
  runOnce,
  sweep,
  sweepNodes,
  type SweepNode,
} from "./index.ts";
import { loadDbDriver, openReaperDb, resolveReaperDbPath, SCHEMA_SQL, type DbConnection, type ReaperDb } from "./reaper.db.ts";
import { FileSweepLedger, InMemorySweepLedger, STUCK_THRESHOLD } from "./ledger.ts";

const HOUR = 60 * 60 * 1000;

/** Runtime-agnostic existence check (bun's access() resolves null, node's undefined). */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface Fixture {
  dir: string;
  dbPath: string;
  scratchDir: string;
  artifactDir: string;
  leaseDir: string;
  uuid: string;
  namePrefix: string;
  proxmoxTag: string;
}

/** Build a fresh temp fixture dir + DB schema (simulates lite having written rows). */
async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "vmhub-reaper-"));
  const scratchDir = join(dir, "scratch");
  const artifactDir = join(dir, "artifacts");
  const leaseDir = join(dir, "leases");
  await mkdir(scratchDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await mkdir(leaseDir, { recursive: true });

  const uuid = "3f2c9a1e-0000-4000-8000-000000000001";
  const namePrefix = "win";
  const proxmoxTag = `vmhub-${namePrefix}-${uuid}`;
  const dbPath = join(dir, "leases.sqlite");

  // Simulate lite: bootstrap schema + write lease/VM/artifact rows directly.
  const Ctor = await loadDbDriver();
  const conn: DbConnection = new Ctor(dbPath);
  conn.exec(SCHEMA_SQL);
  conn.close();

  return { dir, dbPath, scratchDir, artifactDir, leaseDir, uuid, namePrefix, proxmoxTag };
}

interface LeaseSeed {
  vm: Vm;
  lease: Lease;
  artifacts?: ArtifactRecord[];
}

/** Insert lease/VM/artifact rows exactly as lite would (raw connection). */
async function seedLease(fx: Fixture, seed: LeaseSeed, vmid = 1000): Promise<void> {
  const Ctor = await loadDbDriver();
  const conn: DbConnection = new Ctor(fx.dbPath);
  const { vm, lease, artifacts = [] } = seed;
  conn
    .prepare(
      `INSERT INTO vms (uuid, vmid, nodeId, templateId, adapter, capabilities, proxmoxTag, namePrefix, status, sshPort, scratchDir, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      vm.uuid,
      vmid,
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
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    )
    .run(
      lease.vmId,
      lease.owner,
      lease.requestId,
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
  conn.close();
}

function makeVm(fx: Fixture, overrides: Partial<Vm> = {}): Vm {
  return {
    uuid: fx.uuid,
    nodeId: 'dl360p',
    templateId: "windows-11-24h2",
    adapter: "windows",
    capabilities: ["screenshot", "click", "type", "get_file"],
    proxmoxTag: fx.proxmoxTag,
    namePrefix: fx.namePrefix,
    status: "ready",
    sshPort: 2200,
    scratchDir: fx.scratchDir,
    createdAt: Date.now() - 2 * HOUR,
    ...overrides,
  };
}

function makeLease(fx: Fixture, overrides: Partial<Lease> = {}): Lease {
  return {
    vmId: fx.uuid,
    owner: "agent-42",
    requestId: "req-42",
    expiresAt: Date.now() + HOUR,
    lastRenewedAt: Date.now(),
    renewCount: 0,
    maxLifetimeMs: 24 * HOUR,
    ...overrides,
  };
}

/** A VM in MockProxmox whose tag+name match the lease identity. */
async function seedProxmoxVm(proxmox: ProxmoxClient, fx: Fixture): Promise<void> {
  await proxmox.createVm({
    templateId: "windows-11-24h2",
    name: `${fx.namePrefix}-${fx.uuid}`,
    proxmoxTag: fx.proxmoxTag,
  });
}

describe("isLeaseExpired", () => {
  it("expires when now passes expiresAt", () => {
    const fx = { uuid: "x", namePrefix: "p", proxmoxTag: "t" } as Fixture;
    const vm = makeVm(fx, { createdAt: 0 });
    const lease = makeLease(fx, { expiresAt: 1000 });
    expect(isLeaseExpired(lease, vm, 1000)).toBe(true);
    expect(isLeaseExpired(lease, vm, 999)).toBe(false);
  });

  it("enforces the 24 h hard cap even if expiresAt is in the future", () => {
    const fx = { uuid: "x", namePrefix: "p", proxmoxTag: "t" } as Fixture;
    const vm = makeVm(fx, { createdAt: 0 });
    const lease = makeLease(fx, { expiresAt: 999_999_999, maxLifetimeMs: 24 * HOUR });
    expect(isLeaseExpired(lease, vm, 24 * HOUR)).toBe(true);
  });
});

describe("isDraining", () => {
  const now = 1_000_000;
  const artifact = (inFlight: boolean, createdAt: number): ArtifactRecord => ({
    id: "a",
    leaseId: "x",
    hostPath: "out.bin",
    sizeBytes: 1,
    inFlight,
    createdAt,
  });

  it("blocks while an artifact is in-flight within the hard timeout", () => {
    expect(isDraining([artifact(true, now - 1000)], now, DEFAULT_DRAIN_TIMEOUT_MS)).toBe(true);
  });

  it("declares a hung transfer past the hard timeout", () => {
    expect(isDraining([artifact(true, now - DEFAULT_DRAIN_TIMEOUT_MS - 1)], now, DEFAULT_DRAIN_TIMEOUT_MS)).toBe(false);
  });

  it("does not block on finished artifacts", () => {
    expect(isDraining([artifact(false, now - 1000)], now, DEFAULT_DRAIN_TIMEOUT_MS)).toBe(false);
  });
});

describe("findVmByIdentity", () => {
  it("matches tag AND name prefix — never a bare VMID", async () => {
    const proxmox = new MockProxmox();
    const fx = { uuid: "u-1", namePrefix: "win", proxmoxTag: "vmhub-win-u-1" } as Fixture;
    // Same tag but a name that does NOT carry the prefix — must not match.
    await proxmox.createVm({ templateId: "windows-11-24h2", name: "other-name", proxmoxTag: "vmhub-win-u-1" });
    await proxmox.createVm({ templateId: "windows-11-24h2", name: "win-u-1", proxmoxTag: "vmhub-win-u-1" });

    const found = await findVmByIdentity(proxmox, fx.proxmoxTag, fx.namePrefix);
    expect(found?.name).toBe("win-u-1");
  });

  it("throws on an identity collision instead of guessing", async () => {
    const proxmox = new MockProxmox();
    await proxmox.createVm({ templateId: "windows-11-24h2", name: "win-u-1", proxmoxTag: "vmhub-win-u-1" });
    await proxmox.createVm({ templateId: "windows-11-24h2", name: "win-u-1", proxmoxTag: "vmhub-win-u-1" });
    await expect(findVmByIdentity(proxmox, "vmhub-win-u-1", "win")).rejects.toThrow(/collision/);
  });

  it("matches the identity tag via the tags[] array (real API shape)", async () => {
    const proxmox = new MockProxmox();
    // Real Proxmox carries vmhub-* among many tags; proxmoxTag field may be absent.
    await proxmox.createVm({ templateId: "windows-11-24h2", name: "win-u-9", proxmoxTag: "vmhub-win-u-9" });
    const found = await findVmByIdentity(proxmox, "vmhub-win-u-9", "win");
    expect(found?.vmid).toBe(1000);
  });
});

describe("resolveReaperDbPath", () => {
  const saved = { db: process.env.VMHUB_DB, leaseDir: process.env.VMHUB_LEASE_DIR };

  afterEach(() => {
    if (saved.db === undefined) delete process.env.VMHUB_DB;
    else process.env.VMHUB_DB = saved.db;
    if (saved.leaseDir === undefined) delete process.env.VMHUB_LEASE_DIR;
    else process.env.VMHUB_LEASE_DIR = saved.leaseDir;
  });

  it("prefers the explicit VMHUB_DB file", () => {
    process.env.VMHUB_DB = "/srv/custom.sqlite";
    expect(resolveReaperDbPath()).toBe("/srv/custom.sqlite");
  });

  it("falls back to <VMHUB_LEASE_DIR>/leases.sqlite", () => {
    delete process.env.VMHUB_DB;
    process.env.VMHUB_LEASE_DIR = "/srv/leases";
    expect(resolveReaperDbPath()).toBe("/srv/leases/leases.sqlite");
  });

  it("defaults to ./leases/leases.sqlite (lite's default)", () => {
    delete process.env.VMHUB_DB;
    delete process.env.VMHUB_LEASE_DIR;
    expect(resolveReaperDbPath()).toBe("leases/leases.sqlite");
  });
});

describe("reaper sweep", () => {
  let fx: Fixture;
  let db: ReturnType<typeof Object> & { listLeasesWithVm(): unknown; deleteLease(v: string): void; close(): void };

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    try {
      await db?.close();
    } catch {
      // already closed (e.g. runOnce closed its own handle)
    }
    db = undefined as never;
    await rm(fx.dir, { recursive: true, force: true });
  });

  /** THE KILL-TEST: agent SIGKILLed mid-lease; sweep must reclaim everything. */
  it("reclaims VM + lease + artifacts + files when the agent dies mid-lease", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const staged = join(fx.scratchDir, "repo.zip");
    await writeFile(staged, "artifact-bytes");
    await writeFile(join(fx.scratchDir, "lease-key.txt"), "secret");

    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }), // agent never renewed → expired
      artifacts: [
        {
          id: "art-1",
          leaseId: fx.uuid,
          hostPath: "repo.zip",
          sizeBytes: 13,
          inFlight: false,
          createdAt: now - 10 * 60_000,
        },
      ],
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.scanned).toBe(1);
    expect(report.expired).toBe(1);
    expect(report.destroyed).toBe(1);
    expect(report.errors).toEqual([]);

    // VM gone from Proxmox.
    expect(await proxmox.listVms()).toEqual([]);
    // Lease + VM + artifact rows gone from the shared DB.
    expect(db.listLeasesWithVm()).toEqual([]);
    // Staged artifact + lease files + scratch dir gone from disk.
    expect(await exists(staged)).toBe(false);
    expect(await exists(join(fx.scratchDir, "lease-key.txt"))).toBe(false);
  });

  it("deletes artifacts staged at an absolute host path (lite artifacts dir)", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    const absoluteStaged = join(fx.artifactDir, "pulled-file.bin");
    await writeFile(absoluteStaged, "payload");
    await seedLease(fx, {
      vm: makeVm(fx, { scratchDir: undefined }),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
      artifacts: [
        {
          id: "art-1",
          leaseId: fx.uuid,
          hostPath: absoluteStaged, // absolute: vm_get_file staged it under artifacts/
          sizeBytes: 7,
          inFlight: false,
          createdAt: now - 60_000,
        },
      ],
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.destroyed).toBe(1);
    expect(await exists(absoluteStaged)).toBe(false);
    expect(db.listArtifacts()).toEqual([]);
  });

  it("refuses to escape the scratch dir via a traversal hostPath", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    const outside = join(fx.dir, "outside.bin");
    await writeFile(outside, "keep");
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
      artifacts: [
        {
          id: "art-1",
          leaseId: fx.uuid,
          hostPath: "../../outside.bin",
          sizeBytes: 4,
          inFlight: false,
          createdAt: now - 60_000,
        },
      ],
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.destroyed).toBe(1);
    // The traversal target survived; only the scratch dir was removed.
    expect(await exists(outside)).toBe(true);
  });

  it("refuses to destroy while a vm_get_file transfer is in-flight (DRAINING)", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
      artifacts: [
        {
          id: "art-1",
          leaseId: fx.uuid,
          hostPath: "big.bin",
          sizeBytes: 1,
          inFlight: true,
          createdAt: now - 1000, // young transfer — within the hard timeout
        },
      ],
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.draining).toBe(1);
    expect(report.destroyed).toBe(0);
    expect((await proxmox.listVms()).length).toBe(1); // VM survives
    expect(db.listLeasesWithVm().length).toBe(1);
  });

  it("reaps a hung in-flight transfer past the hard timeout", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
      artifacts: [
        {
          id: "art-1",
          leaseId: fx.uuid,
          hostPath: "hung.bin",
          sizeBytes: 1,
          inFlight: true,
          createdAt: now - DEFAULT_DRAIN_TIMEOUT_MS - 1, // stuck past the hard timeout
        },
      ],
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.destroyed).toBe(1);
    expect(await proxmox.listVms()).toEqual([]);
  });

  it("leaves a live (unexpired) lease alone", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now + HOUR }), // still valid
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.expired).toBe(0);
    expect(report.destroyed).toBe(0);
    expect((await proxmox.listVms()).length).toBe(1);
  });

  it("reclaims a lease past the 24 h hard cap even if renewed", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx, { createdAt: now - 25 * HOUR }),
      lease: makeLease(fx, {
        expiresAt: now + HOUR, // agent renewed, but the hard cap has run out
        lastRenewedAt: now,
        renewCount: 10,
      }),
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.expired).toBe(1);
    expect(report.destroyed).toBe(1);
    expect(await proxmox.listVms()).toEqual([]);
  });

  it("refuses all destructive work when disk free is below the refusal threshold", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, {
      artifactDir: fx.artifactDir,
      now: () => now,
      diskFreePercent: async () => DEFAULT_DISK_FULL_REFUSAL_PCT - 1,
    });

    expect(report.refusedDiskFull).toBe(true);
    expect(report.destroyed).toBe(0);
    expect((await proxmox.listVms()).length).toBe(1);
  });

  it("uses the ProxmoxClient disk seam (diskFreeBytes/diskUsedBytes) for the refusal", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    // Host reports only 5% free via the client seam — sweep must refuse.
    proxmox.diskFreeBytes = async () => 5;
    proxmox.diskUsedBytes = async () => 95;

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.refusedDiskFull).toBe(true);
    expect(report.destroyed).toBe(0);
    expect((await proxmox.listVms()).length).toBe(1);
  });

  it("reaps normally when the client seam reports plenty of free disk", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    proxmox.diskFreeBytes = async () => 900;
    proxmox.diskUsedBytes = async () => 100;

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.refusedDiskFull).toBe(false);
    expect(report.destroyed).toBe(1);
  });

  it("never touches VMs it does not own (identity verified)", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    // An unrelated VM on the same host, different tag — must survive.
    await proxmox.createVm({
      templateId: "windows-11-24h2",
      name: "other-0000",
      proxmoxTag: "vmhub-other-0000",
    });
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });

    db = await openReaperDb(fx.dbPath);
    const report = await sweep(db, proxmox, { artifactDir: fx.artifactDir, now: () => now });

    expect(report.destroyed).toBe(1);
    const remaining = await proxmox.listVms();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.proxmoxTag).toBe("vmhub-other-0000");
  });

  it("runOnce opens the DB + a fresh MockProxmox and sweeps end-to-end", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    await proxmox.close();

    // runOnce builds its own client; we assert it does not crash and returns a report.
    const report = await runOnce({
      dbPath: fx.dbPath,
      artifactDir: fx.artifactDir,
      createClient: () => new MockProxmox(),
    });
    expect(report.scanned).toBe(1);
    expect(typeof report.destroyed).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// Multi-node fail-closed sweep (plan T9)
// ---------------------------------------------------------------------------

/** A per-node SweepNode wrapping one MockProxmox client. */
function node(id: string, client: ProxmoxClient): SweepNode {
  return { config: defaultNodeConfig(id), createClient: () => client };
}

/** A MockProxmox whose reachability probe fails (auth/connect error). */
function unreachableMock(id = "dl360p"): MockProxmox {
  const client = new MockProxmox(id);
  client.listVms = async () => {
    throw new Error(`connect ECONNREFUSED 10.0.0.9:8006 (node ${id})`);
  };
  return client;
}

describe("multi-node fail-closed sweep", () => {
  let fx: Fixture;
  let db: ReaperDb | undefined;

  beforeEach(async () => {
    fx = await makeFixture();
  });

  afterEach(async () => {
    try {
      await db?.close();
    } catch {
      // already closed (e.g. runOnce closed its own handle)
    }
    db = undefined;
    await rm(fx.dir, { recursive: true, force: true });
  });

  it("defers an unreachable node's leases, keeps the rows, and retries next sweep", async () => {
    const client = unreachableMock();
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    db = await openReaperDb(fx.dbPath);
    const ledger = new InMemorySweepLedger();
    const opts = { artifactDir: fx.artifactDir, now: () => now, ledger };

    const first = await sweepNodes(db, [node("dl360p", client)], opts);

    // Fail-closed: nothing destroyed, nothing reported clean.
    expect(first.destroyed).toBe(0);
    expect(first.nodes).toHaveLength(1);
    expect(first.nodes[0]?.outcome).toBe("auth-failed");
    expect(first.nodes[0]?.deferred).toBe(1);
    expect(first.nodes[0]?.error).toMatch(/ECONNREFUSED/);
    // Rows kept — the VM survives for when the node returns.
    expect(db.listLeasesWithVm()).toHaveLength(1);
    expect(ledger.getNode("dl360p")?.consecutiveAuthFailures).toBe(1);
    expect(ledger.getNode("dl360p")?.lastOutcome).toBe("auth-failed");

    // Retry next sweep: still unreachable → still deferred, counter climbs.
    const second = await sweepNodes(db, [node("dl360p", client)], opts);
    expect(second.nodes[0]?.outcome).toBe("auth-failed");
    expect(db.listLeasesWithVm()).toHaveLength(1);
    expect(ledger.getNode("dl360p")?.consecutiveAuthFailures).toBe(2);
    expect(ledger.getNode("dl360p")?.deferredBatches).toBe(2);
  });

  it("flips a node to stuck after 3 consecutive auth-failed sweeps and emits an alert", async () => {
    const client = unreachableMock();
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    db = await openReaperDb(fx.dbPath);
    const ledger = new InMemorySweepLedger();
    const opts = { artifactDir: fx.artifactDir, now: () => now, ledger };

    const r1 = await sweepNodes(db, [node("dl360p", client)], opts);
    const r2 = await sweepNodes(db, [node("dl360p", client)], opts);
    expect(r1.alerts).toEqual([]);
    expect(r2.alerts).toEqual([]);

    const r3 = await sweepNodes(db, [node("dl360p", client)], opts);
    expect(r3.alerts).toHaveLength(1);
    expect(r3.alerts[0]).toMatch(/STUCK/);
    expect(r3.nodes[0]?.outcome).toBe("stuck");
    expect(r3.nodes[0]?.status).toBe("stuck");
    expect(r3.nodes[0]?.deferred).toBe(1);
    expect(ledger.getNode("dl360p")?.status).toBe("stuck");
    expect(ledger.getNode("dl360p")?.consecutiveAuthFailures).toBe(STUCK_THRESHOLD);
    // Still fail-closed: rows kept, never destroyed by inference.
    expect(db.listLeasesWithVm()).toHaveLength(1);
    expect(r3.destroyed).toBe(0);
  });

  it("treats a 404 during a specific teardown as clean (VM already gone) and finishes cleanup", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    // The VM vanished between the identity scan and the destroy call (race).
    proxmox.destroyVm = async () => {
      throw { code: "NOT_FOUND", message: "proxmox vm 1000 not found", retryable: false, hint: "no-retry" };
    };
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    db = await openReaperDb(fx.dbPath);

    const report = await sweepNodes(db, [node("dl360p", proxmox)], {
      artifactDir: fx.artifactDir,
      now: () => now,
    });

    // 404 = already gone → clean; file + row cleanup still runs.
    expect(report.destroyed).toBe(1);
    expect(report.errors).toEqual([]);
    expect(db.listLeasesWithVm()).toHaveLength(0);
  });

  it("cleans up leases whose VM is already gone (identity scan finds nothing)", async () => {
    const proxmox = new MockProxmox(); // no VM seeded — already gone
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    db = await openReaperDb(fx.dbPath);

    const report = await sweepNodes(db, [node("dl360p", proxmox)], {
      artifactDir: fx.artifactDir,
      now: () => now,
    });

    expect(report.destroyed).toBe(1);
    expect(report.nodes[0]?.outcome).toBe("ok");
    expect(db.listLeasesWithVm()).toHaveLength(0);
  });

  it("reconciles deferred leases when the node comes back (sweep-on-return, idempotent by tag)", async () => {
    const client = new MockProxmox();
    await seedProxmoxVm(client, fx);
    const originalListVms = client.listVms.bind(client);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    db = await openReaperDb(fx.dbPath);
    const ledger = new InMemorySweepLedger();
    const opts = { artifactDir: fx.artifactDir, now: () => now, ledger };

    // Node goes down → leases deferred, rows kept.
    client.listVms = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.9:8006");
    };
    const down = await sweepNodes(db, [node("dl360p", client)], opts);
    expect(down.nodes[0]?.outcome).toBe("auth-failed");
    expect(db.listLeasesWithVm()).toHaveLength(1);

    // Node returns → the normal sweep destroys by tag and resets the counters.
    client.listVms = originalListVms;
    const up = await sweepNodes(db, [node("dl360p", client)], opts);
    expect(up.nodes[0]?.outcome).toBe("ok");
    expect(up.destroyed).toBe(1);
    expect(await client.listVms()).toEqual([]);
    expect(db.listLeasesWithVm()).toHaveLength(0);
    expect(ledger.getNode("dl360p")?.consecutiveAuthFailures).toBe(0);
    expect(ledger.getNode("dl360p")?.status).toBe("online");
    expect(ledger.getNode("dl360p")?.destroyedTotal).toBe(1);
  });

  it("durable ledger state survives a reaper restart (new instance, same file)", async () => {
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    const ledgerPath = join(fx.dir, "sweeps.jsonl");
    const down = unreachableMock();

    // Reaper instance 1: two sweeps while the node is down.
    {
      const dbA = await openReaperDb(fx.dbPath);
      const ledgerA = new FileSweepLedger(ledgerPath);
      await ledgerA.load();
      await sweepNodes(dbA, [node("dl360p", down)], { artifactDir: fx.artifactDir, now: () => now, ledger: ledgerA });
      await sweepNodes(dbA, [node("dl360p", down)], { artifactDir: fx.artifactDir, now: () => now, ledger: ledgerA });
      await ledgerA.flush();
      ledgerA.close();
      dbA.close();
    }

    // Restart: a brand-new ledger object reconstructs the same counters.
    {
      const ledgerB = new FileSweepLedger(ledgerPath);
      await ledgerB.load();
      expect(ledgerB.getNode("dl360p")?.consecutiveAuthFailures).toBe(2);
      expect(ledgerB.getNode("dl360p")?.deferredBatches).toBe(2);
      expect(ledgerB.getNode("dl360p")?.status).toBe("offline");
      ledgerB.close();
    }

    // Restart + node returns → the resumed sweep reconciles and resets counters.
    {
      const up = new MockProxmox();
      await seedProxmoxVm(up, fx);
      const dbB = await openReaperDb(fx.dbPath);
      const ledgerC = new FileSweepLedger(ledgerPath);
      await ledgerC.load();
      const report = await sweepNodes(dbB, [node("dl360p", up)], {
        artifactDir: fx.artifactDir,
        now: () => now,
        ledger: ledgerC,
      });
      expect(report.destroyed).toBe(1);
      expect(dbB.listLeasesWithVm()).toHaveLength(0);
      await ledgerC.flush();
      expect(ledgerC.getNode("dl360p")?.consecutiveAuthFailures).toBe(0);
      expect(ledgerC.getNode("dl360p")?.destroyedTotal).toBe(1);

      // One more restart: nothing to re-destroy (rows are the ground truth).
      const ledgerD = new FileSweepLedger(ledgerPath);
      await ledgerD.load();
      const again = await sweepNodes(dbB, [node("dl360p", up)], {
        artifactDir: fx.artifactDir,
        now: () => now,
        ledger: ledgerD,
      });
      expect(again.scanned).toBe(0);
      expect(again.destroyed).toBe(0);
      ledgerD.close();
      dbB.close();
    }
  });

  it("groups expired leases per node and destroys each on its own node's client only", async () => {
    const now = Date.now();

    // dl360p: one expired lease (VM-A) + an unrelated VM that must survive.
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    const clientA = new MockProxmox("dl360p");
    await clientA.createVm({ templateId: "windows-11-24h2", name: `${fx.namePrefix}-${fx.uuid}`, proxmoxTag: fx.proxmoxTag });
    await clientA.createVm({ templateId: "windows-11-24h2", name: "other-0000", proxmoxTag: "vmhub-other-0000" });

    // vostro: one expired lease (VM-B) on the second node.
    const uuidB = "a1b2c3d4-0000-4000-8000-000000000002";
    const vmB = makeVm(fx, { uuid: uuidB, nodeId: "vostro", namePrefix: "vstr", proxmoxTag: `vmhub-vstr-${uuidB}` });
    await seedLease(
      fx,
      { vm: vmB, lease: makeLease(fx, { vmId: uuidB, requestId: "req-vostro", expiresAt: now - 1000 }) },
      1001,
    );
    const clientB = new MockProxmox("vostro");
    await clientB.createVm({ templateId: "windows-11-24h2", name: `vstr-${uuidB}`, proxmoxTag: `vmhub-vstr-${uuidB}` });

    db = await openReaperDb(fx.dbPath);
    const report = await sweepNodes(
      db,
      [node("dl360p", clientA), node("vostro", clientB)],
      { artifactDir: fx.artifactDir, now: () => now },
    );

    expect(report.scanned).toBe(2);
    expect(report.destroyed).toBe(2);
    expect(report.nodes).toHaveLength(2);
    expect(report.nodes.map((n) => [n.nodeId, n.destroyed])).toEqual([
      ["dl360p", 1],
      ["vostro", 1],
    ]);
    // Each VM was destroyed on ITS OWN node's client; the foreign VM survived.
    const remainingA = await clientA.listVms();
    expect(remainingA).toHaveLength(1);
    expect(remainingA[0]?.proxmoxTag).toBe("vmhub-other-0000");
    expect(await clientB.listVms()).toEqual([]);
    expect(db.listLeasesWithVm()).toHaveLength(0);
  });

  it("defers leases whose node has no registry entry (never destroys by inference)", async () => {
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx, { nodeId: "unknown-node" }),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
    });
    db = await openReaperDb(fx.dbPath);

    const report = await sweepNodes(db, [node("dl360p", new MockProxmox())], {
      artifactDir: fx.artifactDir,
      now: () => now,
    });

    expect(report.destroyed).toBe(0);
    expect(report.alerts).toHaveLength(1);
    expect(report.alerts[0]).toMatch(/no node config for nodeId 'unknown-node'/);
    expect(db.listLeasesWithVm()).toHaveLength(1);
  });

  it("rejects an expired lease while draining (existing doctrine) without counting it destroyed", async () => {
    const proxmox = new MockProxmox();
    await seedProxmoxVm(proxmox, fx);
    const now = Date.now();
    await seedLease(fx, {
      vm: makeVm(fx),
      lease: makeLease(fx, { expiresAt: now - 1000 }),
      artifacts: [
        { id: "art-1", leaseId: fx.uuid, hostPath: "big.bin", sizeBytes: 1, inFlight: true, createdAt: now - 1000 },
      ],
    });
    db = await openReaperDb(fx.dbPath);

    const report = await sweepNodes(db, [node("dl360p", proxmox)], {
      artifactDir: fx.artifactDir,
      now: () => now,
    });

    expect(report.draining).toBe(1);
    expect(report.destroyed).toBe(0);
    expect(report.nodes[0]?.outcome).toBe("deferred");
    expect((await proxmox.listVms()).length).toBe(1);
  });
});

describe("node registry resolution", () => {
  const ENV_NAMES = [
    "VMHUB_NODES",
    "VMHUB_NODE_DL360P_BASE_URL",
    "VMHUB_NODE_DL360P_TOKEN",
    "VMHUB_NODE_VOSTRO_BASE_URL",
    "VMHUB_NODE_VOSTRO_TOKEN",
    "PVE_HOST",
    "PVE_TOKEN",
    "PVE_TOKEN_ID",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of ENV_NAMES) saved.set(name, process.env[name]);
  });

  afterEach(() => {
    for (const name of ENV_NAMES) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });

  it("defaults to a single dl360p node reading the legacy PVE_* env", () => {
    const cfgs = resolveNodeConfigs({});
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0]?.id).toBe("dl360p");
    expect(cfgs[0]?.tokenEnv).toBe("PVE_TOKEN");
    expect(cfgs[0]?.baseUrl).toBe("");
  });

  it("resolves a multi-node fleet from VMHUB_NODES + per-node env", () => {
    const cfgs = resolveNodeConfigs({
      VMHUB_NODES: "dl360p, vostro",
      VMHUB_NODE_DL360P_BASE_URL: "10.0.0.2:8006",
      VMHUB_NODE_VOSTRO_BASE_URL: "10.0.0.3:8006",
      VMHUB_NODE_VOSTRO_TOKEN: "secret",
    });
    expect(cfgs.map((c) => c.id)).toEqual(["dl360p", "vostro"]);
    expect(cfgs[1]?.baseUrl).toBe("10.0.0.3:8006");
    expect(cfgs[1]?.tokenEnv).toBe("VMHUB_NODE_VOSTRO_TOKEN");
    expect(cfgs[0]?.baseUrl).toBe("10.0.0.2:8006");
    // Default node still falls back to the legacy PVE_TOKEN naming.
    expect(cfgs[0]?.tokenEnv).toBe("PVE_TOKEN");
  });

  it("createClientForNode builds a node-aware MockProxmox when no token is set", () => {
    const client = createClientForNode(defaultNodeConfig("vostro"));
    expect(client).toBeInstanceOf(MockProxmox);
    expect((client as MockProxmox).nodeId).toBe("vostro");
  });

  it("createClientForNode builds a RealProxmox when token + baseUrl are present", () => {
    process.env.VMHUB_NODE_VOSTRO_BASE_URL = "10.0.0.3:8006";
    process.env.VMHUB_NODE_VOSTRO_TOKEN = "secret";
    const cfg = resolveNodeConfigs({
      VMHUB_NODES: "vostro",
      VMHUB_NODE_VOSTRO_BASE_URL: "10.0.0.3:8006",
      VMHUB_NODE_VOSTRO_TOKEN: "secret",
    })[0]!;
    const client = createClientForNode(cfg);
    expect(client).toBeInstanceOf(RealProxmox);
    const opts = (client as unknown as { opts: { nodeId?: string } }).opts;
    expect(opts.nodeId).toBe("vostro");
  });
});
