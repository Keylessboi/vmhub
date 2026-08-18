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
import { statfsSync } from "node:fs";
import type { Template, VmError } from "../shared/types.ts";
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
  {
    id: "2110",
    os: "macos",
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
      "dispatch",
      "put_file",
      "get_file",
      "clone_repo",
    ],
    ramMb: 8192,
    vcpus: 4,
    nestedVirt: false,
    constraints: [{ cpu: { avx2: true }, nestedVirt: false }],
    notes: "macOS Sequoia 15.7.9 golden (24G830) with Xcode 26.3 + iOS 26.3.1 runtime — the parent VM for the ios adapter.",
    prefix: "mac",
    vmid: 2110,
  },
  {
    id: "2120",
    os: "ios",
    availability: "stub",
    reason: "iOS adapter is a documented capabilities:[] stub (no windowing, no input).",
    capabilities: [],
    ramMb: 0,
    vcpus: 0,
    nestedVirt: false,
    notes: "Stub so agents can always discover iOS's empty capability set.",
    prefix: "ios",
    vmid: 2120,
  },
];

function notFound(message: string): VmError {
  return { code: "NOT_FOUND", message, retryable: false, hint: "no-retry" };
}

function unavailable(tpl: CannedTemplate): VmError {
  return {
    code: "CAPABILITY_UNAVAILABLE",
    message: `template '${tpl.id}' is '${tpl.availability}', not 'available'`,
    retryable: false,
    hint: "no-retry",
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
  }

  async diskFreeBytes(): Promise<number> {
    try {
      const s = statfsSync(".");
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return Number.MAX_SAFE_INTEGER; // unmeasurable → never block on disk
    }
  }

  async diskUsedBytes(): Promise<number> {
    try {
      const s = statfsSync(".");
      return (Number(s.blocks) - Number(s.bavail)) * Number(s.bsize);
    } catch {
      return 0;
    }
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
