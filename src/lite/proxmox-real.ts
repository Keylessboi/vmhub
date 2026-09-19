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
import type { NetworkMode, NetworkPolicy, Template, VmError, VmSnapshot } from "../shared/types.ts";
import { describeError } from "../shared/types.ts";
import { DEFAULT_NODE_ID } from "../shared/schema.ts";
import type { CreateProxmoxVmInput, ProxmoxClient, ProxmoxVm, ProxmoxVmStatus } from "./proxmox.ts";
import { isVmError } from "../mcp/errors.ts";

export interface RealProxmoxOptions {
  host: string;
  tokenId: string;
  token: string;
  /** vmhub node id — allocator key and the VM's node; also the API node when `node` is unset. */
  nodeId?: string;
  /** Proxmox node name for API calls; auto-discovered when both `node` and `nodeId` are unset. */
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
  /** Last host octet of the static-NAT pool (inclusive). Default 199. */
  vmIpEnd?: number;
}

const DEFAULT_TOKEN_ID = "vmhub@pve!automation";
const VM_NETWORK = "10.10.10.0/24";
const VM_GATEWAY = "10.10.10.1";
const VM_IP_START = 50; // 10.10.10.50 — first pool address for leases
const VM_IP_END = 199; // 10.10.10.199 — last pool address (150 leases per node)

function vmError(code: VmError["code"], message: string, retryable: boolean, hint: VmError["hint"], detail?: string): VmError {
  return { code, message, retryable, hint, detail };
}

// ---------------------------------------------------------------------------
// Static-NAT IP pool — registry-driven per node
// ---------------------------------------------------------------------------

export interface IpPoolConfig {
  /** Node the pool belongs to — the allocator key. */
  nodeId: string;
  /** VM network CIDR, e.g. "10.10.10.0/24". */
  subnet: string;
  /** Gateway of the VM network. */
  gateway: string;
  /** First host octet handed out (inclusive). */
  start: number;
  /** Last host octet handed out (inclusive). */
  end: number;
}

/**
 * One pool per node: VMIDs are unique per node, and so are the static-NAT IPs
 * handed out for transport. Exhaustion surfaces as HOST_CAPACITY so the
 * control plane reports capacity rather than misrouting to another node.
 */
export class NodeIpPool {
  private readonly usedIps = new Set<string>();

  constructor(readonly config: IpPoolConfig) {}

  /** Allocate the next free IP in this node's pool. Throws HOST_CAPACITY when exhausted. */
  allocate(): string {
    const { subnet, start, end } = this.config;
    const prefix = subnet.split("/")[0]!.split(".").slice(0, 3).join(".");
    for (let octet = start; octet <= end; octet++) {
      const ip = `${prefix}.${octet}`;
      if (!this.usedIps.has(ip)) {
        this.usedIps.add(ip);
        return ip;
      }
    }
    throw vmError("HOST_CAPACITY", `vmhub IP pool exhausted for node '${this.config.nodeId}' (${prefix}.${start}-${prefix}.${end})`, false, "no-retry");
  }
}

const NODE_IP_POOLS = new Map<string, NodeIpPool>();

/**
 * Registry lookup: one allocator per nodeId, shared by every client of that
 * node so allocated ranges stay consistent across the control plane. The
 * first config for a nodeId wins (config is static per node).
 */
export function poolForNode(config: IpPoolConfig): NodeIpPool {
  let pool = NODE_IP_POOLS.get(config.nodeId);
  if (!pool) {
    pool = new NodeIpPool(config);
    NODE_IP_POOLS.set(config.nodeId, pool);
  }
  return pool;
}

/**
 * Map a golden template's display name to its adapter OS family. Golden names
 * follow the catalog convention: "<os>-<version>" (hyprland-2404, x11-...,
 * windows-11-24h2, android-...). Unknown names fall back to "headless".
 */
export function osFromTemplateName(name: string | undefined): Template["os"] {
  const n = (name ?? "").toLowerCase();
  if (n.startsWith("hyprland")) return "hyprland";
  if (n.startsWith("windows") || n.startsWith("win")) return "windows";
  if (n.startsWith("android")) return "android";
  if (n.startsWith("x11") || n.startsWith("ubuntu-x11")) return "x11";
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
  private readonly opts: Required<Pick<RealProxmoxOptions, "host" | "tokenId" | "token" | "basePath" | "insecure">> & { node?: string; nodeId?: string };
  private readonly pool: NodeIpPool;
  private nodePromise: Promise<string> | null = null;

  constructor(options: RealProxmoxOptions) {
    this.opts = {
      host: options.host,
      tokenId: options.tokenId || DEFAULT_TOKEN_ID,
      token: options.token,
      basePath: options.basePath || "/api2/json",
      insecure: options.insecure ?? true,
      node: options.node,
      nodeId: options.nodeId,
    };
    const subnet = options.vmSubnet ?? VM_NETWORK;
    const start = options.vmIpStart ? Number(options.vmIpStart.split(".").pop()) : VM_IP_START;
    this.pool = poolForNode({
      nodeId: options.nodeId ?? DEFAULT_NODE_ID,
      subnet,
      gateway: options.vmGateway ?? VM_GATEWAY,
      start: Number.isFinite(start) ? start : VM_IP_START,
      end: options.vmIpEnd ?? VM_IP_END,
    });
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

  private toVm(q: any, tags: string[], node: string, ip?: string): ProxmoxVm {
    const proxmoxTag = tags.find((t) => t.startsWith("vmhub-")) ?? "";
    return {
      vmid: Number(q.vmid),
      nodeId: this.opts.nodeId ?? node,
      name: q.name || "",
      templateId: q.template ?? "",
      tags,
      proxmoxTag,
      ip,
      status: (q.status as ProxmoxVmStatus) || "stopped",
      createdAt: q.uptime ? Date.now() - Number(q.uptime) * 1000 : Date.now(),
    };
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
    const vmIp = this.pool.allocate();
    await this.request("POST", `/nodes/${node}/qemu/${vmid}/config`, {
      tags: input.proxmoxTag,
      ipconfig0: `ip=${vmIp}/${this.pool.config.subnet.split("/")[1] ?? "24"},gw=${this.pool.config.gateway}`,
      // Without an explicit nameserver, Proxmox hands the guest the HOST's
      // resolv.conf — here Tailscale MagicDNS (100.100.100.100) and the
      // tailnet search domain. Lease VMs get public resolvers instead.
      nameserver: guestDns(),
      searchdomain: "vmhub.invalid",
      // Proxmox defaults ciupgrade=1: every clone runs a full dist-upgrade on
      // first boot, which replaced xserver-xorg-core under the running x11
      // session (no display until the next boot), slows every lease and
      // makes runs non-reproducible. Leases boot exactly what the golden has.
      ciupgrade: process.env.VMHUB_GUEST_UPGRADE === "1" ? 1 : 0,
    });
    const config = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/config`)) as { tags?: string };
    const tags = this.parseTags(config);
    return this.toVm({ vmid, name: input.name, status: "provisioning" }, tags, node, vmIp);
  }

  async startVm(vmid: number): Promise<ProxmoxVm> {
    const node = await this.node();
    const vm = await this.status(vmid);
    if (vm !== "running") {
      await this.request("POST", `/nodes/${node}/qemu/${vmid}/status/start`, {});
    }
    return this.getVm(vmid);
  }

  /**
   * Boot readiness, judged from the host side: the VM is running and — when
   * the template enables the QEMU guest agent — the agent answers ping, which
   * means the guest OS is up. Guest-level access (SSH, CursorTouch, adb) is
   * the MCP adapters' job; lite never needs a route or a key into the guest.
   * A guest that is slow to answer is still handed out (the adapters retry)
   * rather than destroyed.
   */
  async probeCapabilities(vmid: number): Promise<{ available: boolean; reason?: string }> {
    const node = await this.node();
    const config = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/config`)) as { agent?: string };
    if ((await this.status(vmid)) !== "running") return { available: false, reason: `VM ${vmid} is not running` };
    if (!config.agent || !/^(1|enabled=1)/.test(String(config.agent))) return { available: true };
    const deadline = Date.now() + Number(process.env.VMHUB_BOOT_WAIT_MS ?? 90_000);
    while (Date.now() < deadline) {
      try {
        await this.request("POST", `/nodes/${node}/qemu/${vmid}/agent/ping`, {});
        return { available: true };
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    return { available: true, reason: "guest agent did not answer yet; the guest may still be booting" };
  }

  async getVm(vmid: number): Promise<ProxmoxVm> {
    const node = await this.node();
    const vm = await this.statusVm(vmid);
    const config = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/config`)) as { tags?: string; ipconfig0?: string };
    return this.toVm({ ...vm, vmid }, this.parseTags(config), node, ipFromConfig(config.ipconfig0));
  }

  async listVms(): Promise<ProxmoxVm[]> {
    const node = await this.node();
    const vms = (await this.request("GET", `/cluster/resources?type=vm`)) as any[];
    const out: ProxmoxVm[] = [];
    for (const v of vms ?? []) {
      if (v.node !== node) continue;
      // /cluster/resources lags the real config: a VM deleted (or half-created)
      // can linger there with no qemu-server/<vmid>.conf behind it. Letting that
      // throw failed the WHOLE listing, which failed the whole node sweep — one
      // orphaned record was enough to stop the reaper reaping anything at all.
      // A VM whose config we cannot read is one we cannot identify as ours, so
      // skipping it keeps the identity contract fail-closed.
      let config: { tags?: string };
      try {
        config = (await this.request("GET", `/nodes/${node}/qemu/${v.vmid}/config`)) as { tags?: string };
      } catch (err) {
        console.error(`[proxmox] skipping vm ${v.vmid} on ${node}: ${describeError(err)}`);
        continue;
      }
      const tags = this.parseTags(config);
      if (tags.some((t) => t.startsWith("vmhub-"))) out.push(this.toVm(v, tags, node));
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
        // stop is an async task: wait for it (a VM just rolled back or holding
        // a snapshot lock can take well over 30s), then confirm the state.
        // A VM just rolled back / snapshotted can still hold its config lock
        // ("can't lock file … got timeout"): retry the stop a few times.
        for (let attempt = 1; ; attempt++) {
          try {
            const upid = await this.request("POST", `/nodes/${node}/qemu/${vmid}/status/stop`, { timeout: 60 });
            await this.waitTask(upid, 120_000);
            break;
          } catch (e) {
            if (attempt >= 3 || !/lock/i.test(describeError(e))) throw e;
            await new Promise((r) => setTimeout(r, 5000 * attempt));
          }
        }
        for (let i = 0; i < 60; i++) {
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
    const st = (await this.request("GET", `/nodes/${node}/storage/${await this.storageName()}/status`)) as { avail?: number };
    return Number(st.avail ?? 0);
  }

  async diskUsedBytes(): Promise<number> {
    const node = await this.node();
    const st = (await this.request("GET", `/nodes/${node}/storage/${await this.storageName()}/status`)) as { used?: number };
    return Number(st.used ?? 0);
  }

  /**
   * Wait for an async Proxmox task (UPID) to finish; throw on failure.
   * Snapshot/rollback return a UPID immediately and run in the background.
   */
  private async waitTask(upid: unknown, timeoutMs = 600_000): Promise<void> {
    if (typeof upid !== "string" || !upid.startsWith("UPID:")) return;
    const node = upid.split(":")[1] ?? (await this.node());
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const st = (await this.request("GET", `/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`)) as { status?: string; exitstatus?: string };
      if (st.status === "stopped") {
        if (st.exitstatus && st.exitstatus !== "OK" && !st.exitstatus.startsWith("WARNINGS")) {
          throw vmError("INTERNAL", `proxmox task failed: ${st.exitstatus}`, false, "no-retry");
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw vmError("BOOT_TIMEOUT", `proxmox task ${upid} still running after ${timeoutMs}ms`, true, "retry-with-backoff");
  }

  async listSnapshots(vmid: number): Promise<VmSnapshot[]> {
    const node = await this.node();
    const rows = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/snapshot`)) as {
      name: string; description?: string; snaptime?: number; vmstate?: number; parent?: string;
    }[];
    return (rows ?? [])
      .filter((r) => r.name !== "current")
      .map((r) => ({
        name: r.name,
        description: r.description?.trim() || undefined,
        createdAt: r.snaptime ? r.snaptime * 1000 : undefined,
        withMemory: Number(r.vmstate) === 1,
        parent: r.parent,
      }))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  async createSnapshot(vmid: number, name: string, opts: { description?: string; withMemory?: boolean } = {}): Promise<void> {
    const node = await this.node();
    const upid = await this.request("POST", `/nodes/${node}/qemu/${vmid}/snapshot`, {
      snapname: name,
      description: opts.description ?? "vmhub snapshot",
      vmstate: opts.withMemory ? 1 : 0,
    });
    await this.waitTask(upid);
  }

  async rollbackSnapshot(vmid: number, name: string): Promise<void> {
    const node = await this.node();
    const upid = await this.request("POST", `/nodes/${node}/qemu/${vmid}/snapshot/${encodeURIComponent(name)}/rollback`, { start: 1 });
    await this.waitTask(upid);
    // Disk-only snapshots roll back to a stopped VM on older PVE; make sure it runs.
    if ((await this.status(vmid)) !== "running") await this.startVm(vmid);
  }

  async deleteSnapshot(vmid: number, name: string): Promise<void> {
    const node = await this.node();
    const upid = await this.request("DELETE", `/nodes/${node}/qemu/${vmid}/snapshot/${encodeURIComponent(name)}`);
    await this.waitTask(upid);
  }

  /** Datacenter firewall state: VM rules are inert unless it is enabled. */
  private async datacenterFirewall(): Promise<{ enabled: boolean; reason?: string }> {
    try {
      const o = (await this.request("GET", `/cluster/firewall/options`)) as { enable?: number };
      return Number(o?.enable) === 1 ? { enabled: true } : { enabled: false, reason: "datacenter firewall is disabled (Datacenter → Firewall → Options → Firewall: Yes)" };
    } catch (e) {
      return { enabled: false, reason: `cannot read datacenter firewall options: ${describeError(e)}` };
    }
  }

  async getNetworkPolicy(vmid: number): Promise<NetworkPolicy> {
    const node = await this.node();
    const opts = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/firewall/options`)) as { enable?: number };
    const rules = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/firewall/rules`)) as { comment?: string }[];
    const tag = rules.map((r) => r.comment ?? "").find((c) => c.startsWith("vmhub:mode="));
    if (!tag || Number(opts?.enable) !== 1) return { mode: "unmanaged", enforced: false, reason: "no vmhub policy applied to this VM" };
    const mode = tag.slice("vmhub:mode=".length).split(" ")[0] as NetworkMode;
    const dc = await this.datacenterFirewall();
    return { mode, enforced: dc.enabled, reason: dc.reason };
  }

  async setNetworkPolicy(vmid: number, mode: NetworkMode, gw?: string): Promise<NetworkPolicy> {
    const node = await this.node();
    const gateway = gw ?? this.pool.config.gateway;
    const base = `/nodes/${node}/qemu/${vmid}`;
    // 1. The NIC must opt into the firewall bridge.
    const config = (await this.request("GET", `${base}/config`)) as Record<string, string>;
    const net0 = config.net0 ?? "";
    if (!/(^|,)firewall=1(,|$)/.test(net0)) {
      if (!net0) throw vmError("INTERNAL", `VM ${vmid} has no net0 to firewall`, false, "no-retry");
      await this.request("POST", `${base}/config`, { net0: `${net0.replace(/(^|,)firewall=\d/, "")},firewall=1` });
    }
    // 2. Replace every vmhub-owned rule (highest position first so indexes stay valid).
    const rules = (await this.request("GET", `${base}/firewall/rules`)) as { pos: number; comment?: string }[];
    for (const r of [...rules].filter((r) => (r.comment ?? "").startsWith("vmhub:")).sort((a, b) => b.pos - a.pos)) {
      await this.request("DELETE", `${base}/firewall/rules/${r.pos}`);
    }
    // Rules are inserted at pos 0, so add them in reverse of evaluation order.
    const wanted: Record<string, unknown>[] = [];
    wanted.push({ type: "in", action: "ACCEPT", source: gateway, comment: `vmhub:mode=${mode} host control path` });
    if (mode === "internet") {
      wanted.push({ type: "out", action: "ACCEPT", dest: gateway, proto: "udp", dport: "53", comment: "vmhub: dns via host" });
      wanted.push({ type: "out", action: "ACCEPT", dest: gateway, proto: "tcp", dport: "53", comment: "vmhub: dns via host" });
      for (const cidr of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"]) {
        wanted.push({ type: "out", action: "DROP", dest: cidr, comment: `vmhub: no private/tailnet ${cidr}` });
      }
    }
    for (const rule of wanted.reverse()) {
      await this.request("POST", `${base}/firewall/rules`, { ...rule, enable: 1, pos: 0 });
    }
    // 3. Policies: inbound only from the host; outbound per mode.
    await this.request("PUT", `${base}/firewall/options`, {
      enable: 1,
      policy_in: "DROP",
      policy_out: mode === "internet" ? "ACCEPT" : "DROP",
      dhcp: 1,
      ndp: 0,
      radv: 0,
    });
    // pve-firewall compiles rule changes on a ~10s cycle, so a running VM
    // keeps its old policy until then (measured: internet→isolated still let
    // traffic out at +0s, blocked at +12s). Do not report a mode before it
    // is in force. A stopped VM picks the rules up before its NIC exists.
    const settleMs = Number(process.env.VMHUB_FIREWALL_SETTLE_MS ?? 12_000);
    if (settleMs > 0 && (await this.status(vmid)) === "running") {
      await new Promise((r) => setTimeout(r, settleMs));
    }
    const dc = await this.datacenterFirewall();
    return { mode, enforced: dc.enabled, reason: dc.reason };
  }

  /**
   * Resolve the VM-data pool this node allocates from. Reads the node's own
   * storage list at runtime (first zfspool, else first lvmthin) so multi-node
   * works without a global PVE_STORAGE. Falls back to PVE_STORAGE, then
   * "vmhub" (legacy).
   */
  private async storageName(): Promise<string> {
    const explicit = process.env.PVE_STORAGE;
    if (explicit && explicit.trim() !== "") return explicit;
    const node = await this.node();
    try {
      const stores = (await this.request("GET", `/nodes/${node}/storage`)) as {
        storage: string;
        type?: string;
      }[];
      const pool = stores.find((s) => s.type === "zfspool") ?? stores.find((s) => s.type === "lvmthin");
      if (pool) return pool.storage;
    } catch {
      // storage list unreachable — fall through to the legacy name
    }
    return "vmhub";
  }
}

/**
 * Plain per-node configuration for the control plane: one entry per node,
 * from which a RealProxmox client (and its static-NAT pool) is constructed.
 * No env access — the caller owns where config comes from.
 */
export interface RealProxmoxNodeConfig {
  /** vmhub node id — allocator key and the Proxmox node name. */
  nodeId: string;
  /** API base "host[:port]", e.g. "192.168.1.220:8006". */
  baseUrl: string;
  tokenId?: string;
  token: string;
  /** Static-NAT pool for this node's VMs. Defaults: 10.10.10.0/24, gw .1, 50-199. */
  ipPool?: {
    subnet?: string;
    gateway?: string;
    /** First host octet handed out (inclusive), default 50. */
    start?: number;
    /** Last host octet handed out (inclusive), default 199. */
    end?: number;
  };
  basePath?: string;
  insecure?: boolean;
}

/** Per-node client factory — one RealProxmox per node for the control plane. */
export function createRealProxmox(config: RealProxmoxNodeConfig): RealProxmox {
  const pool = config.ipPool ?? {};
  return new RealProxmox({
    host: config.baseUrl,
    tokenId: config.tokenId ?? DEFAULT_TOKEN_ID,
    token: config.token,
    nodeId: config.nodeId,
    basePath: config.basePath,
    insecure: config.insecure,
    vmSubnet: pool.subnet,
    vmGateway: pool.gateway,
    vmIpStart: pool.start !== undefined ? hostIp(pool.subnet ?? VM_NETWORK, pool.start) : undefined,
    vmIpEnd: pool.end,
  });
}

/** "10.10.10.0/24", 50 → "10.10.10.50" — octet-based config to legacy IP string. */
function hostIp(subnet: string, octet: number): string {
  return `${subnet.split("/")[0]!.split(".").slice(0, 3).join(".")}.${octet}`;
}

/** "ip=10.10.10.62/24,gw=10.10.10.1" → "10.10.10.62" (static cloud-init address). */
export function ipFromConfig(ipconfig?: string): string | undefined {
  const m = /(?:^|,)ip=(\d+\.\d+\.\d+\.\d+)/.exec(ipconfig ?? "");
  return m?.[1];
}

/** Resolvers written into every lease VM's cloud-init (VMHUB_GUEST_DNS, space-separated). */
export function guestDns(env: NodeJS.ProcessEnv = process.env): string {
  return (env.VMHUB_GUEST_DNS ?? "1.1.1.1 9.9.9.9").trim().split(/[\s,]+/).join(" ");
}
