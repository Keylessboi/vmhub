/**
 * vmhub-reaper teardown primitives — the identity doctrine and cleanup
 * mechanics shared by every sweep.
 *
 * The ONLY trustworthy identity is the `vmhub-<prefix>-<uuid>` tag carried on
 * the Proxmox VM; numeric VMIDs are internal and never trusted. teardownLease
 * destroys by that identity, treats a 404 as "already gone" (clean), then
 * removes staged files + rows in one transaction.
 */

import { rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isVmError, type ProxmoxClient, type ProxmoxVm } from "../lite/proxmox.ts";
import type { ArtifactRecord, Lease, Vm } from "../shared/types.ts";
import type { ReaperDb } from "./reaper.db.ts";

/** Default hard cap on lease lifetime (plan: 24 h). Overridable per lease via maxLifetimeMs. */
export const DEFAULT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Default hard timeout for an in-flight vm_get_file transfer before it is declared hung. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;

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
export async function clientDiskFreePercent(proxmox: ProxmoxClient): Promise<number> {
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
 */
async function deleteStagedArtifact(
  artifact: ArtifactRecord,
  scratchDir: string | undefined,
  artifactDir: string | undefined,
): Promise<void> {
  const target = resolveHostPath(scratchDir ?? artifactDir, artifact.hostPath);
  if (!target) return;
  try {
    await rm(target, { force: true });
  } catch {
    // staged file already gone — cleanup continues
  }
}

/** Remove the whole lease scratch dir (lease files + staged artifacts). */
async function deleteScratchDir(scratchDir: string | undefined): Promise<void> {
  if (!scratchDir) return;
  await rm(scratchDir, { recursive: true, force: true });
}

/** One lease's teardown verdict — the sweep aggregates these. */
export type TeardownResult = { kind: "destroyed" } | { kind: "draining" } | { kind: "error"; message: string };

/** A lease with its VM + artifacts, as produced by listLeasesWithVm. */
export interface LeaseEntry {
  vm: Vm;
  lease: Lease;
  artifacts: ArtifactRecord[];
}

export interface TeardownOptions {
  now: number;
  drainTimeoutMs: number;
  artifactDir?: string;
}

/**
 * Tear down one expired lease on the given node's client: refuse while an
 * artifact is in-flight (within the hard timeout), destroy the VM by identity
 * tag (never VMID), treat a 404 mid-teardown as clean (already gone), then
 * remove staged files + scratch dir and clear the DB rows.
 */
export async function teardownLease(
  db: ReaperDb,
  client: ProxmoxClient,
  entry: LeaseEntry,
  opts: TeardownOptions,
): Promise<TeardownResult> {
  if (isDraining(entry.artifacts, opts.now, opts.drainTimeoutMs)) return { kind: "draining" };

  try {
    const { vm, artifacts } = entry;
    const found = await findVmByIdentity(client, vm.proxmoxTag, vm.namePrefix);
    if (found) {
      try {
        await client.destroyVm(found.vmid);
      } catch (err) {
        // 404 during teardown = VM vanished mid-sweep (race) → already gone → CLEAN.
        if (!(isVmError(err) && err.code === "NOT_FOUND")) throw err;
      }
    }
    // (found === undefined → VM already gone; still clean files + rows below.)

    for (const artifact of artifacts) {
      await deleteStagedArtifact(artifact, vm.scratchDir, opts.artifactDir);
    }
    await deleteScratchDir(vm.scratchDir);
    db.deleteLease(vm.uuid);

    return { kind: "destroyed" };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
