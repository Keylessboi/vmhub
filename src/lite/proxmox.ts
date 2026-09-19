/**
 * ProxmoxClient — the single Proxmox abstraction used by vmhub-lite's control
 * plane. MockProxmox is the in-memory implementation used until the real
 * Proxmox server exists (Phase 3.1, RealProxmox). vmhub-mcp talks to this
 * interface through the lite REST layer; the reaper talks to Proxmox directly
 * (its own client) but the identity contract below (proxmoxTag) is shared.
 *
 * Identity doctrine (plan R7): the ONLY trustworthy identity is the
 * `vmhub-<prefix>-<uuid>` tag carried on the VM. Numeric VMIDs are internal
 * and never treated as stable vmhub identities.
 */
import type { NetworkMode, NetworkPolicy, Template, VmError, VmSnapshot } from "../shared/types.ts";
import { DEFAULT_HINT } from "../shared/types.ts";
import { DEFAULT_NODE_ID } from "../shared/schema.ts";

export type ProxmoxVmStatus = "running" | "stopped" | "provisioning";

export interface ProxmoxVm {
  /** Numeric VMID — internal to Proxmox; never a vmhub identity. Unique per node. */
  vmid: number;
  /** The node this VM lives on (UNIQUE(nodeId, vmid) — vmids collide across nodes). */
  nodeId: string;
  /** Proxmox display name (informational only). */
  name: string;
  /** Template this VM was created from. */
  templateId: string;
  /** All tags on the VM (real Proxmox API shape; comma-separated on the wire). */
  tags: string[];
  /**
   * The vmhub identity tag `vmhub-<prefix>-<uuid>` — the ONLY trustworthy
   * identity. Always present in `tags`; kept as a field for convenience.
   */
  proxmoxTag: string;
  /** Static NAT IP the VM was assigned (vmbr1, 10.10.10.x) — the transport address. */
  ip?: string;
  status: ProxmoxVmStatus;
  createdAt: number;
}

export interface CreateProxmoxVmInput {
  templateId: string;
  /** Informational VM name (the identity is the tag, not the name). */
  name: string;
  proxmoxTag: string;
  /** Target node; defaults to the client's node (single-node default keeps legacy callers). */
  nodeId?: string;
  cpus?: number;
  memoryMb?: number;
}

/**
 * What the control plane needs from Proxmox. Deliberately narrow — everything
 * else (console, snapshots, live config) is out of scope for v1.
 */
export interface ProxmoxClient {
  /** The template catalog (shared Template shape, availability + reason + capabilities). */
  listTemplates(): Promise<Template[]>;
  /** Clone/create a VM from a template. Throws VmError on unknown/unavailable template. */
  createVm(input: CreateProxmoxVmInput): Promise<ProxmoxVm>;
  /** Power on an existing VM. No-op when already running. */
  startVm(vmid: number): Promise<ProxmoxVm>;
  getVm(vmid: number): Promise<ProxmoxVm>;
  /** All VMs this client knows about (reaper scans `tags` for the vmhub- prefix). */
  listVms(): Promise<ProxmoxVm[]>;
  /** Destroy a VM by VMID. Idempotent — missing VM is a no-op. */
  destroyVm(vmid: number): Promise<void>;
  /** Host free disk bytes (reaper/lite 15% disk-full guard). */
  diskFreeBytes(): Promise<number>;
  /** Host used disk bytes. */
  diskUsedBytes(): Promise<number>;
  /**
   * Probe a running VM for required capability binaries (ffmpeg, hyprctl, etc.).
   * Returns available=true when all expected binaries are present, or
   * available=false with a reason listing what is missing.
   */
  probeCapabilities(vmid: number): Promise<{ available: boolean; reason?: string }>;
  /** Snapshots of a VM (the implicit "current" entry excluded), oldest first. */
  listSnapshots(vmid: number): Promise<VmSnapshot[]>;
  createSnapshot(vmid: number, name: string, opts?: { description?: string; withMemory?: boolean }): Promise<void>;
  /** Roll back and leave the VM running. */
  rollbackSnapshot(vmid: number, name: string): Promise<void>;
  deleteSnapshot(vmid: number, name: string): Promise<void>;
  getNetworkPolicy(vmid: number): Promise<NetworkPolicy>;
  /** Apply a lease network policy via the per-VM firewall. `gateway` (host's guest-bridge IP) defaults to the node's pool gateway. */
  setNetworkPolicy(vmid: number, mode: NetworkMode, gateway?: string): Promise<NetworkPolicy>;
  /** Release any held resources. Safe to call once; mock is a no-op. */
  close?(): Promise<void>;
}

/** Internal extension: catalog entries carry the tag prefix for naming. */
interface CannedTemplate extends Template {
  prefix: string;
  vmid: number;
}

/**
 * Canned template catalog. Availability + reason + capabilities follow the
 * shared contract: stubs and unavailable templates are NEVER hidden.
 */
const CANNED_TEMPLATES: CannedTemplate[] = [
  {
    id: "2060",
    os: "x11",
    availability: "available",
    capabilities: [
      "screenshot",
      "inspect",
      "list_windows",
      "click",
      "type",
      "key",
      "drag",
      "launch",
      "focus",
      "close",
      "exec",
    ],
    ramMb: 4096,
    vcpus: 2,
    nestedVirt: false,
    notes: "X11 golden (Phase 3.2).",
    prefix: "x11",
    vmid: 2060,
  },
  {
    id: "2070",
    os: "hyprland",
    availability: "available",
    capabilities: [
      "screenshot",
      "inspect",
      "list_windows",
      "click",
      "type",
      "key",
      "drag",
      "launch",
      "focus",
      "close",
      "dispatch",
      "put_file",
      "get_file",
      "clone_repo",
      "exec",
    ],
    ramMb: 8192,
    vcpus: 4,
    nestedVirt: false,
    notes: "Ubuntu 24.04 golden with Hyprland — the primary local adapter.",
    prefix: "hl",
    vmid: 2070,
  },
  {
    id: "2100",
    os: "windows",
    availability: "available",
    capabilities: [
      "screenshot",
      "inspect",
      "list_windows",
      "click",
      "type",
      "key",
      "paste",
      "drag",
      "launch",
      "focus",
      "close",
      "put_file",
      "get_file",
      "clone_repo",
      "exec",
    ],
    ramMb: 16384,
    vcpus: 8,
    nestedVirt: false,
    notes: "Windows 11 golden with CursorTouch (pinned v0.8.5).",
    prefix: "win",
    vmid: 2100,
  },
];

/** Fake storage pool size backing MockProxmox's disk seam (1 TiB). */
const MOCK_POOL_BYTES = 1024 ** 4;

/**
 * Free space in the node's VM storage pool, as a percentage.
 *
 * This is the number the allocation guard must use: VMs are allocated out of
 * the Proxmox pool, not out of whatever filesystem the control plane happens
 * to be running on. Returns 100 when the pool cannot be measured, so an
 * unreachable node fails later with a real error instead of a bogus DISK_FULL.
 */
export async function proxmoxDiskFreePercent(client: ProxmoxClient): Promise<number> {
  try {
    const [free, used] = await Promise.all([client.diskFreeBytes(), client.diskUsedBytes()]);
    const total = free + used;
    if (!Number.isFinite(total) || total <= 0) return 100;
    return (free / total) * 100;
  } catch {
    return 100;
  }
}

function notFound(message: string): VmError {
  return { code: "NOT_FOUND", message, retryable: false, hint: DEFAULT_HINT.NOT_FOUND };
}

function unavailable(tpl: CannedTemplate): VmError {
  return {
    code: "CAPABILITY_UNAVAILABLE",
    message: `template '${tpl.id}' is '${tpl.availability}', not 'available'`,
    retryable: false,
    hint: DEFAULT_HINT.CAPABILITY_UNAVAILABLE,
    detail: tpl.reason,
  };
}

/**
 * In-memory MockProxmox. Created VMs are immediately "running" (instant
 * provisioning), VMIDs increment per node from 1000, and the identity tag is
 * stored as given. Used until the real Proxmox server exists (Phase 3.1).
 * One client = one node; the per-node counter map honors the shared
 * UNIQUE(nodeId, vmid) contract when an input overrides the client's node.
 */
export class MockProxmox implements ProxmoxClient {
  readonly nodeId: string;
  private vms = new Map<string, ProxmoxVm>();
  private nextVmid = new Map<string, number>();

  constructor(nodeId: string = DEFAULT_NODE_ID) {
    this.nodeId = nodeId;
  }

  private key(nodeId: string, vmid: number): string {
    return `${nodeId}:${vmid}`;
  }

  async listTemplates(): Promise<Template[]> {
    return CANNED_TEMPLATES.map(({ prefix: _prefix, vmid: _vmid, ...tpl }) => tpl);
  }

  async createVm(input: CreateProxmoxVmInput): Promise<ProxmoxVm> {
    const tpl = CANNED_TEMPLATES.find((t) => t.id === input.templateId);
    if (!tpl) throw notFound(`template '${input.templateId}' not found`);
    if (tpl.availability !== "available") throw unavailable(tpl);

    const nodeId = input.nodeId ?? this.nodeId;
    const next = this.nextVmid.get(nodeId) ?? 1000;
    this.nextVmid.set(nodeId, next + 1);
    const vmid = next;
    const vm: ProxmoxVm = {
      vmid,
      nodeId,
      name: input.name,
      templateId: input.templateId,
      tags: [input.proxmoxTag],
      proxmoxTag: input.proxmoxTag,
      status: "running",
      ip: `10.10.10.${vmid % 256}`,
      createdAt: Date.now(),
    };
    this.vms.set(this.key(nodeId, vmid), vm);
    return vm;
  }

  async getVm(vmid: number): Promise<ProxmoxVm> {
    const vm = this.vms.get(this.key(this.nodeId, vmid));
    if (!vm) throw notFound(`proxmox vm ${vmid} not found`);
    return vm;
  }

  async startVm(vmid: number): Promise<ProxmoxVm> {
    const vm = this.vms.get(this.key(this.nodeId, vmid));
    if (!vm) throw notFound(`proxmox vm ${vmid} not found`);
    vm.status = "running";
    return vm;
  }

  async listVms(): Promise<ProxmoxVm[]> {
    return [...this.vms.values()];
  }

  async destroyVm(vmid: number): Promise<void> {
    this.vms.delete(this.key(this.nodeId, vmid));
    this.snaps.delete(vmid);
    this.policies.delete(vmid);
  }

  private snaps = new Map<number, VmSnapshot[]>();
  private policies = new Map<number, NetworkPolicy>();

  /** Existence check that does not go through getVm (tests count getVm calls). */
  private must(vmid: number): ProxmoxVm {
    const vm = this.vms.get(this.key(this.nodeId, vmid));
    if (!vm) throw notFound(`proxmox vm ${vmid} not found`);
    return vm;
  }

  async listSnapshots(vmid: number): Promise<VmSnapshot[]> {
    this.must(vmid);
    return [...(this.snaps.get(vmid) ?? [])];
  }

  async createSnapshot(vmid: number, name: string, opts: { description?: string; withMemory?: boolean } = {}): Promise<void> {
    this.must(vmid);
    const list = this.snaps.get(vmid) ?? [];
    if (list.some((s) => s.name === name)) {
      throw { code: "ALREADY_EXISTS", message: `snapshot '${name}' exists`, retryable: false, hint: DEFAULT_HINT.ALREADY_EXISTS } as VmError;
    }
    list.push({ name, description: opts.description, createdAt: Date.now(), withMemory: opts.withMemory ?? false, parent: list.at(-1)?.name });
    this.snaps.set(vmid, list);
  }

  async rollbackSnapshot(vmid: number, name: string): Promise<void> {
    const vm = this.must(vmid);
    if (!(this.snaps.get(vmid) ?? []).some((s) => s.name === name)) throw notFound(`snapshot '${name}' not found`);
    vm.status = "running";
  }

  async deleteSnapshot(vmid: number, name: string): Promise<void> {
    this.must(vmid);
    const list = this.snaps.get(vmid) ?? [];
    if (!list.some((s) => s.name === name)) throw notFound(`snapshot '${name}' not found`);
    this.snaps.set(vmid, list.filter((s) => s.name !== name));
  }

  async getNetworkPolicy(vmid: number): Promise<NetworkPolicy> {
    this.must(vmid);
    return this.policies.get(vmid) ?? { mode: "unmanaged", enforced: false, reason: "no policy applied" };
  }

  async setNetworkPolicy(vmid: number, mode: NetworkMode, _gateway?: string): Promise<NetworkPolicy> {
    this.must(vmid);
    const policy: NetworkPolicy = { mode, enforced: true };
    this.policies.set(vmid, policy);
    return policy;
  }

  /**
   * Fake pool: 90% free, fixed.
   *
   * This deliberately does NOT read the host filesystem. Reporting the
   * developer's real free space made every disk-sensitive test depend on the
   * machine it ran on — suites went green or red based on `df`. Tests that
   * care about disk override these two methods explicitly.
   */
  async diskFreeBytes(): Promise<number> {
    return MOCK_POOL_BYTES * 0.9;
  }

  async diskUsedBytes(): Promise<number> {
    return MOCK_POOL_BYTES * 0.1;
  }

  async probeCapabilities(_vmid: number): Promise<{ available: boolean; reason?: string }> {
    return { available: true };
  }

  async close(): Promise<void> {
    // nothing to release for the in-memory mock
  }

  /** Test helper: wipe all mock VMs and reset the per-node VMID counters. */
  reset(): void {
    this.vms.clear();
    this.nextVmid.clear();
  }
}
