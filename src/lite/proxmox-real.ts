/**
 * RealProxmox — ProxmoxClient backed by the live Proxmox VE API.
 *
 * Used once the real server exists (Phase 3.1). Configured from env:
 *   PVE_HOST      e.g. "192.168.1.220:8006"
 *   PVE_TOKEN_ID  e.g. "vmhub@pve!automation"  (default)
 *   PVE_TOKEN     the token secret (by reference — never logged)
 *   PVE_NODE      optional; auto-discovered when omitted
 *
 * Auth: Proxmox API token (header `Authorization: PVEAPIToken=...`).
 * Identity doctrine is preserved: `proxmoxTag` (vmhub-<prefix>-<uuid>) is the
 * only trustworthy identity; numeric VMIDs are internal. Linked clones carry
 * the tag; listVms filters to tagged VMs.
 */
import type { Template, VmError } from "../shared/types.ts";
import type { CreateProxmoxVmInput, ProxmoxClient, ProxmoxVm, ProxmoxVmStatus } from "./proxmox.ts";

export interface RealProxmoxOptions {
  host: string;
  tokenId: string;
  token: string;
  node?: string;
  /** Base path prefix, default "/api2/json". */
  basePath?: string;
  /** Verify TLS. Proxmox uses a self-signed cert by default → default false. */
  insecure?: boolean;
  /** NAT subnet for VM transport. Default 10.10.10.0/24 (vmbr1). */
  vmSubnet?: string;
  /** First usable host IP in the VM subnet. */
  vmGateway?: string;
  /** First IP handed out to VMs (default 10.10.10.50). */
  vmIpStart?: string;
}

const DEFAULT_TOKEN_ID = "vmhub@pve!automation";
const VM_NETWORK = "10.10.10.0/24";
const VM_GATEWAY = "10.10.10.1";
const VM_IP_START = 50; // 10.10.10.50 — first pool address for leases

function vmError(code: VmError["code"], message: string, retryable: boolean, hint: VmError["hint"], detail?: string): VmError {
  return { code, message, retryable, hint, detail };
}

/**
 * Map a golden template's display name to its adapter OS family. Golden names
 * follow the catalog convention: "<os>-<version>" (hyprland-2404, x11-...,
 * windows-11-24h2, android-...). Unknown names fall back to "headless".
 */
function osFromTemplateName(name: string | undefined): Template["os"] {
  const n = (name ?? "").toLowerCase();
  if (n.startsWith("hyprland")) return "hyprland";
  if (n.startsWith("windows") || n.startsWith("win")) return "windows";
  if (n.startsWith("android")) return "android";
  if (n.startsWith("x11") || n.startsWith("ubuntu-x11")) return "x11";
  if (n.startsWith("macos") || n.startsWith("mac")) return "macos";
  if (n.startsWith("ios")) return "ios";
  return "headless";
}

/**
 * Capability surface a clone of this template will have, per adapter OS.
 * Headless goldens (debian-13-golden) get exec only — never a display claim.
 */
function templateCapabilities(os: Template["os"]): Template["capabilities"] {
  if (os === "headless") return ["exec"];
  return ["screenshot", "inspect", "list_windows", "click", "type", "key", "drag", "exec"];
}

export class RealProxmox implements ProxmoxClient {
  private readonly opts: Required<Pick<RealProxmoxOptions, "host" | "tokenId" | "token" | "basePath" | "insecure">> & { node?: string };
  private readonly vmSubnetMask: string;
  private readonly vmGateway: string;
  private readonly vmIpStart: number;
  private nodePromise: Promise<string> | null = null;
  private readonly usedIps = new Set<string>();

  constructor(options: RealProxmoxOptions) {
    this.opts = {
      host: options.host,
      tokenId: options.tokenId || DEFAULT_TOKEN_ID,
      token: options.token,
      basePath: options.basePath || "/api2/json",
      insecure: options.insecure ?? true,
      node: options.node,
    };
    const cidr = options.vmSubnet ?? VM_NETWORK;
    this.vmSubnetMask = cidr.split("/")[1] ?? "24";
    this.vmGateway = options.vmGateway ?? VM_GATEWAY;
    const start = options.vmIpStart ? Number(options.vmIpStart.split(".").pop()) : VM_IP_START;
    this.vmIpStart = Number.isFinite(start) ? start : VM_IP_START;
  }

  private authHeader(): string {
    return `PVEAPIToken=${this.opts.tokenId}=${this.opts.token}`;
  }

  private url(pathname: string): string {
    return `https://${this.opts.host}${this.opts.basePath}${pathname}`; // Proxmox is TLS-only
  }

  private async request(method: string, pathname: string, body?: Record<string, unknown>): Promise<any> {
    const res = await fetch(this.url(pathname), {
      method,
      headers: {
        Authorization: this.authHeader(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      ...(this.opts.insecure ? { tls: { rejectUnauthorized: false } } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const msg = data?.errors ? Object.values(data.errors).join("; ") : data?.message || `HTTP ${res.status}`;
      // 401/403 → retryable=false (credential problem); 5xx/lock → retryable=true
      const retryable = res.status >= 500 || res.status === 409;
      throw vmError("INTERNAL", `proxmox ${method} ${pathname}: ${msg}`, retryable, retryable ? "retry-with-backoff" : "no-retry");
    }
    return data?.data ?? data;
  }

  private async node(): Promise<string> {
    if (this.opts.node) return this.opts.node;
    if (!this.nodePromise) {
      this.nodePromise = (async () => {
        const nodes = (await this.request("GET", "/nodes")) as { node: string }[];
        if (!nodes?.length) throw vmError("HOST_CAPACITY", "no proxmox nodes available", false, "no-retry");
        return nodes[0]!.node;
      })();
    }
    return this.nodePromise;
  }

  private parseTags(config: { tags?: string }): string[] {
    if (!config?.tags) return [];
    return config.tags.split(";").map((t) => t.trim()).filter(Boolean);
  }

  private toVm(q: any, tags: string[], ip?: string): ProxmoxVm {
    const proxmoxTag = tags.find((t) => t.startsWith("vmhub-")) ?? "";
    return {
      vmid: Number(q.vmid),
      name: q.name || "",
      templateId: q.template ?? "",
      tags,
      proxmoxTag,
      ip,
      status: (q.status as ProxmoxVmStatus) || "stopped",
      createdAt: q.uptime ? Date.now() - Number(q.uptime) * 1000 : Date.now(),
    };
  }

  /** Allocate the next free VM IP in the pool (10.10.10.50+). */
  private allocVmIp(): string {
    for (let i = this.vmIpStart; i < 200; i++) {
      const ip = `10.10.10.${i}`;
      if (!this.usedIps.has(ip)) {
        this.usedIps.add(ip);
        return ip;
      }
    }
    throw vmError("HOST_CAPACITY", "vmhub IP pool exhausted (10.10.10.50-199)", false, "no-retry");
  }

  async listTemplates(): Promise<Template[]> {
    // Golden templates are Proxmox VMs with template=1. cluster/resources is
    // the single authoritative view of all VMs on any storage — no hardcoded
    // storage name, which would miss templates on non-"local" pools.
    const vms = (await this.request("GET", `/cluster/resources?type=vm`)) as {
      vmid: number; name?: string; template?: number; maxmem?: number; maxcpu?: number;
    }[];
    const templates = vms?.filter((v) => Number(v.template) === 1) ?? [];
    return templates.map((t) => {
      const os = osFromTemplateName(t.name);
      return {
        id: String(t.vmid),
        os,
        availability: "available" as const,
        capabilities: templateCapabilities(os),
        ramMb: Math.round(Number(t.maxmem) / (1024 * 1024)) || 4096,
        vcpus: Number(t.maxcpu) || 2,
        nestedVirt: false,
        notes: t.name ? `Golden template ${t.name}` : `Real Proxmox VM template ${t.vmid}`,
      };
    });
  }

  async createVm(input: CreateProxmoxVmInput): Promise<ProxmoxVm> {
    const node = await this.node();
    const templates = await this.listTemplates();
    if (!templates.some((t) => t.id === input.templateId)) {
      throw vmError("NOT_FOUND", `template '${input.templateId}' not found on ${node}`, false, "no-retry");
    }
    // Allocate a fresh VMID (pick first free >= 2000).
    const existing = (await this.request("GET", `/cluster/resources?type=vm`)) as { vmid: number }[];
    const used = new Set(existing.map((v) => Number(v.vmid)));
    let vmid = 2000;
    while (used.has(vmid)) vmid++;

    await this.request("POST", `/nodes/${node}/qemu/${input.templateId}/clone`, {
      newid: vmid,
      name: input.name,
      full: 0, // linked clone — cheap, the whole architecture depends on it
    });
    // The clone endpoint rejects `tags`, but the tag is the identity doctrine
    // (reaper matches vmhub-* tags, never VMIDs). Set it right after cloning,
    // before the VM can be observed as tag-less by any sweep.
    // A static IP is set the same way: deterministic transport, no DHCP race.
    const vmIp = this.allocVmIp();
    await this.request("POST", `/nodes/${node}/qemu/${vmid}/config`, {
      tags: input.proxmoxTag,
      ipconfig0: `ip=${vmIp}/${this.vmSubnetMask},gw=${this.vmGateway}`,
    });
    const config = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/config`)) as { tags?: string };
    const tags = this.parseTags(config);
    return this.toVm({ vmid, name: input.name, status: "provisioning" }, tags, vmIp);
  }

  async startVm(vmid: number): Promise<ProxmoxVm> {
    const node = await this.node();
    const vm = await this.status(vmid);
    if (vm !== "running") {
      await this.request("POST", `/nodes/${node}/qemu/${vmid}/status/start`, {});
    }
    return this.getVm(vmid);
  }

  async getVm(vmid: number): Promise<ProxmoxVm> {
    const node = await this.node();
    const vm = await this.statusVm(vmid);
    const config = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/config`)) as { tags?: string };
    return this.toVm({ ...vm, vmid }, this.parseTags(config));
  }

  async listVms(): Promise<ProxmoxVm[]> {
    const node = await this.node();
    const vms = (await this.request("GET", `/cluster/resources?type=vm`)) as any[];
    const out: ProxmoxVm[] = [];
    for (const v of vms ?? []) {
      if (v.node !== node) continue;
      const config = (await this.request("GET", `/nodes/${node}/qemu/${v.vmid}/config`)) as { tags?: string };
      const tags = this.parseTags(config);
      if (tags.some((t) => t.startsWith("vmhub-"))) out.push(this.toVm(v, tags));
    }
    return out;
  }

  /** VM power state only. GET /qemu/{vmid} is a subdir listing, not status. */
  private async status(vmid: number): Promise<string> {
    const node = await this.node();
    const s = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/status/current`)) as { status?: string };
    return s?.status ?? "unknown";
  }

  /** Full VM state from /status/current (fields: status, name, uptime, ...). */
  private async statusVm(vmid: number): Promise<Record<string, unknown>> {
    const node = await this.node();
    return (await this.request("GET", `/nodes/${node}/qemu/${vmid}/status/current`)) as Record<string, unknown>;
  }

  async destroyVm(vmid: number): Promise<void> {
    const node = await this.node();
    try {
      if ((await this.status(vmid)) === "running") {
        // Proxmox refuses to delete a running VM — stop it first, then delete.
        await this.request("POST", `/nodes/${node}/qemu/${vmid}/status/stop`, {});
        for (let i = 0; i < 30; i++) {
          if ((await this.status(vmid)) !== "running") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      await this.request("DELETE", `/nodes/${node}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`);
    } catch (e) {
      // Idempotent: a missing VM is a successful destroy.
      if (isVmError(e) && e.code === "NOT_FOUND") return;
      throw e;
    }
  }

  async diskFreeBytes(): Promise<number> {
    const node = await this.node();
    const st = (await this.request("GET", `/nodes/${node}/storage/${this.storageName()}/status`)) as { avail?: number };
    return Number(st.avail ?? 0);
  }

  async diskUsedBytes(): Promise<number> {
    const node = await this.node();
    const st = (await this.request("GET", `/nodes/${node}/storage/${this.storageName()}/status`)) as { used?: number };
    return Number(st.used ?? 0);
  }

  private storageName(): string {
    // The VM-data pool is the only storage vmhub allocates from. Resolve the
    // storage by the pool name; the installer registers zfspool <pool>.
    return process.env.PVE_STORAGE || "vmhub";
  }
}

function isVmError(e: unknown): e is VmError {
  return typeof e === "object" && e !== null && typeof (e as VmError).code === "string";
}
