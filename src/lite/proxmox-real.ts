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
}

const DEFAULT_TOKEN_ID = "vmhub@pve!automation";

function vmError(code: VmError["code"], message: string, retryable: boolean, hint: VmError["hint"], detail?: string): VmError {
  return { code, message, retryable, hint, detail };
}

export class RealProxmox implements ProxmoxClient {
  private readonly opts: Required<Pick<RealProxmoxOptions, "host" | "tokenId" | "token" | "basePath" | "insecure">> & { node?: string };
  private nodePromise: Promise<string> | null = null;

  constructor(options: RealProxmoxOptions) {
    this.opts = {
      host: options.host,
      tokenId: options.tokenId || DEFAULT_TOKEN_ID,
      token: options.token,
      basePath: options.basePath || "/api2/json",
      insecure: options.insecure ?? true,
      node: options.node,
    };
  }

  private authHeader(): string {
    return `PVEAPIToken=${this.opts.tokenId}=${this.opts.token}`;
  }

  private url(pathname: string): string {
    const scheme = this.opts.insecure ? "https" : "https"; // Proxmox is TLS-only
    return `${scheme}://${this.opts.host}${this.opts.basePath}${pathname}`;
  }

  private async request(method: string, pathname: string, body?: Record<string, unknown>): Promise<any> {
    const res = await fetch(this.url(pathname), {
      method,
      headers: {
        Authorization: this.authHeader(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
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

  private toVm(q: any, tags: string[]): ProxmoxVm {
    const proxmoxTag = tags.find((t) => t.startsWith("vmhub-")) ?? "";
    return {
      vmid: Number(q.vmid),
      name: q.name || "",
      templateId: q.template ?? "",
      tags,
      proxmoxTag,
      status: (q.status as ProxmoxVmStatus) || "stopped",
      createdAt: q.uptime ? Date.now() - Number(q.uptime) * 1000 : Date.now(),
    };
  }

  async listTemplates(): Promise<Template[]> {
    // Golden templates are Proxmox VMs (config templated). We return a catalog
    // derived from what the control plane can actually clone. For v1 the
    // canned catalog (MockProxmox's) is authoritative for availability; this
    // method surfaces the real VM templates as "available" when present.
    const node = await this.node();
    const content = (await this.request("GET", `/nodes/${node}/storage/local/content`)) as { vmid?: string }[];
    const ids = content?.map((c) => c.vmid).filter(Boolean) ?? [];
    // Distinct template ids from storage content (vzdump/iso/qcow2 entries
    // carry `vmid` for VM templates). Keep it minimal: report raw vmids.
    const unique = [...new Set(ids)];
    return unique.map((vmid) => ({
      id: String(vmid),
      os: "headless" as const,
      availability: "available" as const,
      capabilities: ["screenshot", "exec"] as any,
      ramMb: 4096,
      vcpus: 2,
      nestedVirt: false,
      notes: `Real Proxmox VM template ${vmid}`,
    }));
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
      tags: input.proxmoxTag, // identity travels with the clone
    });
    const config = (await this.request("GET", `/nodes/${node}/qemu/${vmid}/config`)) as { tags?: string };
    const tags = this.parseTags(config);
    return this.toVm({ vmid, name: input.name, status: "provisioning" }, tags);
  }

  async getVm(vmid: number): Promise<ProxmoxVm> {
    const node = await this.node();
    const vm = (await this.request("GET", `/nodes/${node}/qemu/${vmid}`)) as any;
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

  async destroyVm(vmid: number): Promise<void> {
    const node = await this.node();
    try {
      await this.request("DELETE", `/nodes/${node}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`);
    } catch (e) {
      // Idempotent: a missing VM is a successful destroy.
      if (isVmError(e) && e.code === "NOT_FOUND") return;
      throw e;
    }
  }

  async diskFreeBytes(): Promise<number> {
    const node = await this.node();
    const st = (await this.request("GET", `/nodes/${node}/storage/local/status`)) as { avail?: number };
    return Number(st.avail ?? 0);
  }

  async diskUsedBytes(): Promise<number> {
    const node = await this.node();
    const st = (await this.request("GET", `/nodes/${node}/storage/local/status`)) as { used?: number };
    return Number(st.used ?? 0);
  }
}

function isVmError(e: unknown): e is VmError {
  return typeof e === "object" && e !== null && typeof (e as VmError).code === "string";
}
