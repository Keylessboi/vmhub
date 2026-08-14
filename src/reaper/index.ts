/**
 * vmhub-reaper — the independent lease reaper.
 *
 * Owns nothing but its sweep: every run it reads the shared leases.sqlite
 * directly (NEVER through vmhub-lite's HTTP API — independence is the point),
 * finds expired leases, destroys the VM by IDENTITY (the `vmhub-<prefix>-<uuid>`
 * tag + name prefix, never an agent-supplied VMID), then deletes the lease
 * files + staged artifacts and clears the DB rows.
 *
 * Guardrails (plan R7 / 1.4):
 *  - DRAINING: refuse destroy while an artifact is in-flight (vm_get_file),
 *    with a hard timeout — past it the transfer is declared hung and reaped.
 *  - 24 h hard cap: leases past `expiresAt` or `createdAt + maxLifetimeMs`
 *    are reclaimed even if the owner is still around.
 *  - 15 % disk-full refusal: a sweep refuses all destructive work when the
 *    host disk is critically low, because it cannot safely persist its own
 *    teardown bookkeeping on a full disk.
 */

import { rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { MockProxmox, type ProxmoxClient, type ProxmoxVm } from "../lite/proxmox.ts";
import { RealProxmox } from "../lite/proxmox-real.ts";
import type { ArtifactRecord, Lease, Vm } from "../shared/types.ts";
import { openReaperDb, resolveReaperDbPath, type ReaperDb } from "./reaper.db.ts";

/** Default hard cap on lease lifetime (plan: 24 h). Overridable per lease via maxLifetimeMs. */
export const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Default hard timeout for an in-flight vm_get_file transfer before it is declared hung. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Default disk-full refusal threshold (mirrors VMHUB_DISK_FULL_REFUSAL_PCT). */
export const DEFAULT_DISK_FULL_REFUSAL_PCT = 15;

/** Env names the binary reads (names only — values live in .env, gitignored). */
export const ENV = {
  db: "VMHUB_DB",
  leaseDir: "VMHUB_LEASE_DIR",
  artifactDir: "VMHUB_ARTIFACT_DIR",
  diskFullPct: "VMHUB_DISK_FULL_REFUSAL_PCT",
  drainTimeoutMs: "VMHUB_DRAIN_TIMEOUT_MS",
  intervalMs: "VMHUB_REAPER_INTERVAL_MS",
} as const;

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
}

/** A lease is reclaimable when past its soft expiry OR past the hard lifetime cap. */
export function isLeaseExpired(lease: Lease, vm: Vm, now: number): boolean {
  if (now >= lease.expiresAt) return true;
  const cap = lease.maxLifetimeMs > 0 ? lease.maxLifetimeMs : DEFAULT_MAX_LIFETIME_MS;
  return now - vm.createdAt >= cap;
}

/** True when a transfer is still draining: in-flight and within the hard timeout. */
export function isDraining(artifacts: ArtifactRecord[], now: number, drainTimeoutMs: number): boolean {
  return artifacts.some((a) => a.inFlight && now - a.createdAt < drainTimeoutMs);
}

/**
 * Identity-verified lookup: find the Proxmox VM whose tags carry the vmhub
 * identity tag (`vmhub-<prefix>-<uuid>`) AND whose name starts with the stored
 * prefix. Matches the real API shape: the identity lives in `tags` (comma-
 * separated on the wire); `proxmoxTag` is a convenience field always present
 * in `tags`. Never trusts an agent-supplied VMID. Returns undefined when the
 * VM is already gone; throws when identity is ambiguous (never guess).
 */
export async function findVmByIdentity(
  proxmox: ProxmoxClient,
  proxmoxTag: string,
  namePrefix: string,
): Promise<ProxmoxVm | undefined> {
  const vms = await proxmox.listVms();
  const matches = vms.filter(
    (v) =>
      (v.proxmoxTag === proxmoxTag || v.tags.includes(proxmoxTag)) && v.name.startsWith(namePrefix),
  );
  if (matches.length > 1) {
    throw new Error(
      `identity collision: ${matches.length} Proxmox VMs match tag "${proxmoxTag}" + prefix "${namePrefix}"`,
    );
  }
  return matches[0];
}

/** Free-disk probe via the ProxmoxClient seam (shared with lite). */
async function clientDiskFreePercent(proxmox: ProxmoxClient): Promise<number> {
  const [free, used] = await Promise.all([proxmox.diskFreeBytes(), proxmox.diskUsedBytes()]);
  const total = free + used;
  if (total <= 0) return 100;
  return (free / total) * 100;
}

/** Resolve a stored host path safely for deletion (path-traversal guard). */
function resolveHostPath(root: string | undefined, hostPath: string): string | undefined {
  if (isAbsolute(hostPath)) return hostPath;
  if (!root) return undefined;
  const abs = resolve(root, hostPath);
  if (!abs.startsWith(resolve(root) + "/") && abs !== resolve(root)) return undefined;
  return abs;
}

/**
 * Delete an artifact's staged file. Absolute hostPath is deleted directly
 * (lite stages vm_get_file results under the host artifacts dir); a relative
 * path is resolved under scratchDir, or artifactDir when scratchDir is unset.
 * Returns true if a file was removed, false if nothing existed.
 */
async function deleteStagedArtifact(
  artifact: ArtifactRecord,
  scratchDir: string | undefined,
  artifactDir: string | undefined,
): Promise<boolean> {
  const target = resolveHostPath(scratchDir ?? artifactDir, artifact.hostPath);
  if (!target) return false;
  try {
    await rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Remove the whole lease scratch dir (lease files + staged artifacts). */
async function deleteScratchDir(scratchDir: string | undefined): Promise<void> {
  if (!scratchDir) return;
  await rm(scratchDir, { recursive: true, force: true });
}

/**
 * Run one sweep. Reads all leases, reclaims the expired ones, and returns a
 * report. Per-lease failures are collected — one bad lease never aborts the
 * sweep.
 */
export async function sweep(db: ReaperDb, proxmox: ProxmoxClient, opts: SweepOptions = {}): Promise<SweepReport> {
  const now = opts.now?.() ?? Date.now();
  const drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const refusalPct = opts.diskFullRefusalPct ?? DEFAULT_DISK_FULL_REFUSAL_PCT;
  const diskFreePercent = opts.diskFreePercent ?? (() => clientDiskFreePercent(proxmox));

  const report: SweepReport = { scanned: 0, expired: 0, draining: 0, destroyed: 0, refusedDiskFull: false, errors: [] };
  const all = db.listLeasesWithVm();
  report.scanned = all.length;

  const expired = all.filter(({ lease, vm }) => isLeaseExpired(lease, vm, now));
  report.expired = expired.length;
  if (expired.length === 0) return report;

  // 15 % disk-full refusal — refuse ALL destructive work below the threshold.
  const freePct = await diskFreePercent();
  if (freePct < refusalPct) {
    report.refusedDiskFull = true;
    report.errors.push({
      vmId: "*",
      message: `sweep refused: disk free ${freePct.toFixed(1)}% < ${refusalPct}% refusal threshold`,
    });
    return report;
  }

  for (const { vm, lease, artifacts } of expired) {
    try {
      // DRAINING: an in-flight transfer within the hard timeout blocks destroy.
      if (isDraining(artifacts, now, drainTimeoutMs)) {
        report.draining++;
        continue;
      }

      // Identity-verified destroy — tag + prefix, never agent-supplied VMID.
      const found = await findVmByIdentity(proxmox, vm.proxmoxTag, vm.namePrefix);
      if (found) {
        await proxmox.destroyVm(found.vmid);
      }
      // (found === undefined → VM already gone; still clean files + rows below.)

      // Delete lease files + staged artifacts, then clear the DB rows.
      for (const artifact of artifacts) {
        await deleteStagedArtifact(artifact, vm.scratchDir, opts.artifactDir);
      }
      await deleteScratchDir(vm.scratchDir);
      db.deleteLease(vm.uuid);

      report.destroyed++;
    } catch (err) {
      report.errors.push({
        vmId: vm.uuid,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

export interface ReaperRuntimeOptions {
  dbPath?: string;
  leaseDir?: string;
  artifactDir?: string;
  diskFullRefusalPct?: number;
  drainTimeoutMs?: number;
  /** Create a Proxmox client. Defaults to MockProxmox until Phase 3.1. */
  createClient?: () => ProxmoxClient;
}

/** Open the DB + client and run one sweep (the oneshot systemd path). */
export async function runOnce(opts: ReaperRuntimeOptions = {}): Promise<SweepReport> {
  const db = await openReaperDb(opts.dbPath);
  const proxmox = opts.createClient?.() ?? new MockProxmox();
  try {
    return await sweep(db, proxmox, {
      artifactDir: opts.artifactDir,
      diskFullRefusalPct: opts.diskFullRefusalPct,
      drainTimeoutMs: opts.drainTimeoutMs,
    });
  } finally {
    await proxmox.close?.();
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

  if (argv.includes("--help")) {
    console.log(
      [
        "vmhub-reaper — independent lease reaper",
        "",
        `  ${ENV.db}            sqlite path (default: <VMHUB_LEASE_DIR>/leases.sqlite)`,
        `  ${ENV.leaseDir}       lease dir (default: ./leases)`,
        `  ${ENV.artifactDir}    staged artifact root`,
        `  ${ENV.diskFullPct}    disk-full refusal %% (default ${DEFAULT_DISK_FULL_REFUSAL_PCT})`,
        `  ${ENV.drainTimeoutMs} in-flight transfer hard timeout ms (default ${DEFAULT_DRAIN_TIMEOUT_MS})`,
        `  ${ENV.intervalMs}     if > 0, loop instead of running once (dev)`,
        "",
        "Requires PVE_HOST/PVE_TOKEN via .env once Phase 3.1 lands.",
      ].join("\n"),
    );
    return;
  }

  const createClient = () => {
    // RealProxmox when PVE_HOST/PVE_TOKEN are present (same rule as lite);
    // otherwise the in-memory mock (dev/test).
    if (process.env.PVE_HOST && process.env.PVE_TOKEN) {
      return new RealProxmox({
        host: process.env.PVE_HOST,
        tokenId: process.env.PVE_TOKEN_ID || "vmhub@pve!automation",
        token: process.env.PVE_TOKEN,
      });
    }
    return new MockProxmox();
  };

  const run = async () => {
    const report = await runOnce({
      dbPath,
      leaseDir,
      artifactDir,
      diskFullRefusalPct,
      drainTimeoutMs,
      createClient,
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
