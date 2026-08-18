/**
 * vmhub-lite router tests. Run with `bun test src/lite` (bun:sqlite requires
 * the bun runtime; vitest's node pool cannot load bun:sqlite).
 *
 * Shapes under test are locked to the vmhub-mcp REST client (snake_case
 * bodies, {vm, lease} responses, plain arrays, {error: VmError} envelope).
 */
import { describe, expect, test } from "vitest";
import { LiteDb } from "./db.ts";
import { MockProxmox } from "./proxmox.ts";
import { createLiteHandler, type RouterDeps } from "./routes.ts";
import { createNodeRegistry, type NodeProbe, type NodeProbeResult } from "./nodes.ts";
import type { NodeConfig, NodeStatus, VmNode } from "../shared/types.ts";

const T = {
  hyprland: "2070",
  x11: "2060",
  windows: "2100",
};

interface Ctx {
  ctx: RouterDeps;
  db: LiteDb;
  proxmox: MockProxmox;
  advance: (ms: number) => void;
}

function makeCtx(overrides: Partial<RouterDeps> = {}): Ctx {
  const db = new LiteDb(":memory:");
  const proxmox = new MockProxmox();
  let tick = 1_000_000;
  let n = 0;
  const ctx: RouterDeps = {
    db,
    proxmox,
    now: () => tick,
    uuid: () => `uuid-${++n}`,
    diskFreePct: () => 100,
    diskRefusalThresholdPct: 15,
    leaseDurationMs: 3_600_000,
    maxLifetimeMs: 86_400_000,
    ...overrides,
  };
  return {
    ctx,
    db,
    proxmox,
    advance: (ms) => {
      tick += ms;
    },
  };
}

function handler(c: Ctx) {
  return createLiteHandler(c.ctx);
}

async function call(
  h: ReturnType<typeof handler>,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await h(new Request(`http://localhost${path}`, init));
  return { status: res.status, json: await res.json() };
}

const createLease = (h: ReturnType<typeof handler>, requestId: string, templateId = T.hyprland) =>
  call(h, "POST", "/v1/leases", { request_id: requestId, template_id: templateId, owner: "test-agent" });

describe("POST /v1/leases", () => {
  test("creates an active lease with a ready VM ({vm, lease} shape)", async () => {
    const c = makeCtx();
    const { status, json } = await createLease(handler(c), "r1");
    expect(status).toBe(201);
    expect(json.lease.vmId).toBe("uuid-1");
    expect(json.lease.requestId).toBe("r1");
    expect(json.lease.owner).toBe("test-agent");
    expect(json.lease.status).toBe("active");
    expect(json.lease.renewCount).toBe(0);
    expect(json.lease.expiresAt).toBe(1_000_000 + 3_600_000);
    expect(json.lease.maxLifetimeMs).toBe(86_400_000);
    expect(json.vm).toMatchObject({
      uuid: "uuid-1",
      templateId: T.hyprland,
      adapter: "hyprland",
      status: "ready",
      proxmoxTag: "vmhub-2070-uuid-1",
    });
    expect(json.vm.capabilities).toContain("screenshot");
  });

  test("accepts the mcp-client snake_case body exactly", async () => {
    const c = makeCtx();
    const { status, json } = await createLease(handler(c), "mcp-r1");
    expect(status).toBe(201);
    expect(json.lease.requestId).toBe("mcp-r1");
    expect(json.lease.vmId).toBe("uuid-1");
  });

  test("honors ttl_ms (clamped to maxLifetimeMs)", async () => {
    const c = makeCtx();
    const { status, json } = await call(handler(c), "POST", "/v1/leases", {
      request_id: "r1",
      template_id: T.hyprland,
      ttl_ms: 600_000, // 10 min
    });
    expect(status).toBe(201);
    expect(json.lease.expiresAt).toBe(1_000_000 + 600_000);
    const over = await call(handler(c), "POST", "/v1/leases", {
      request_id: "r2",
      template_id: T.hyprland,
      ttl_ms: 10 * 86_400_000, // exceeds 24h cap
    });
    expect(over.json.lease.expiresAt).toBe(1_000_000 + 86_400_000);
  });

  test("same request_id returns the SAME lease (200, no duplicate VM)", async () => {
    const c = makeCtx();
    const h = handler(c);
    const first = await createLease(h, "r1");
    const second = await createLease(h, "r1");
    const third = await createLease(h, "r1");
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(third.status).toBe(200);
    expect(second.json.lease.vmId).toBe(first.json.lease.vmId);
    expect(third.json.lease.vmId).toBe(first.json.lease.vmId);
    expect(c.db.listVms()).toHaveLength(1);
    expect(await c.proxmox.listVms()).toHaveLength(1);
  });

  test("x-request-id header is honored as the idempotency key", async () => {
    const c = makeCtx();
    const h = handler(c);
    const res = await h(
      new Request("http://localhost/v1/leases", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "hdr-1" },
        body: JSON.stringify({ template_id: T.hyprland }),
      }),
    );
    expect(res.status).toBe(201);
    const replay = await h(
      new Request("http://localhost/v1/leases", {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": "hdr-1" },
        body: JSON.stringify({ template_id: T.hyprland }),
      }),
    );
    expect(replay.status).toBe(200);
  });

  test("different request_id yields a different lease", async () => {
    const c = makeCtx();
    const h = handler(c);
    const a = await createLease(h, "r1");
    const b = await createLease(h, "r2");
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.json.lease.vmId).not.toBe(b.json.lease.vmId);
  });

  test("replay after release still returns the same (released) lease", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    await call(h, "DELETE", `/v1/leases/${created.json.lease.vmId}`);
    const replay = await createLease(h, "r1");
    expect(replay.status).toBe(200);
    expect(replay.json.lease.vmId).toBe(created.json.lease.vmId);
    expect(replay.json.lease.status).toBe("released");
    expect(c.db.listVms()).toHaveLength(0);
  });

  test("missing request_id or template_id → 400 INVALID_REQUEST", async () => {
    const c = makeCtx();
    const h = handler(c);
    const noRid = await call(h, "POST", "/v1/leases", { template_id: T.hyprland });
    expect(noRid.status).toBe(400);
    expect(noRid.json.error.code).toBe("INVALID_REQUEST");
    const noTid = await call(h, "POST", "/v1/leases", { request_id: "r1" });
    expect(noTid.status).toBe(400);
    expect(noTid.json.error.code).toBe("INVALID_REQUEST");
  });

  test("unknown template → 404 NOT_FOUND", async () => {
    const c = makeCtx();
    const { status, json } = await createLease(handler(c), "r1", "no-such-template");
    expect(status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
    expect(json.error.retryable).toBe(false);
  });

  test("refuses to allocate when disk is below the threshold → 507 DISK_FULL", async () => {
    const c = makeCtx({ diskFreePct: () => 10 });
    const { status, json } = await createLease(handler(c), "r1");
    expect(status).toBe(507);
    expect(json.error.code).toBe("DISK_FULL");
    expect(json.error.retryable).toBe(true);
    expect(json.error.hint).toBe("teardown-then-retry");
    expect(c.db.listVms()).toHaveLength(0);
  });

  test("malformed JSON body → 400 INVALID_REQUEST", async () => {
    const c = makeCtx();
    const h = handler(c);
    const res = await h(
      new Request("http://localhost/v1/leases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_REQUEST",
    );
  });

  test("getVm verification fails after startVm → destroys VM, throws PROVISION_FAILED", async () => {
    const c = makeCtx();
    const failingProx = Object.create(c.proxmox);
    failingProx.getVm = async () => {
      throw new Error("VM not found on Proxmox");
    };
    c.ctx.proxmox = failingProx;
    const h = handler(c);
    const { status, json } = await createLease(h, "r1");
    expect(status).toBe(503);
    expect(json.error.code).toBe("PROVISION_FAILED");
    expect(json.error.retryable).toBe(false);
    expect(json.error.hint).toBe("teardown-then-retry");
    expect(json.error.detail).toBe("Error: VM not found on Proxmox");
    expect(c.db.listVms()).toHaveLength(0);
    expect(await c.proxmox.listVms()).toHaveLength(0);
  });
});

describe("GET /v1/leases/{id}", () => {
  test("returns the stored lease", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    const { status, json } = await call(h, "GET", `/v1/leases/${created.json.lease.vmId}`);
    expect(status).toBe(200);
    expect(json.lease.vmId).toBe(created.json.lease.vmId);
    expect(json.vm.uuid).toBe(created.json.lease.vmId);
  });

  test("unknown lease → 404", async () => {
    const c = makeCtx();
    const { status, json } = await call(handler(c), "GET", "/v1/leases/nope");
    expect(status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});

describe("POST /v1/leases/{id}/renew", () => {
  test("pushes expiresAt forward and bumps renewCount", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    c.advance(60_000);
    const { status, json } = await call(h, "POST", `/v1/leases/${created.json.lease.vmId}/renew`, {});
    expect(status).toBe(200);
    expect(json.renewCount).toBe(1);
    expect(json.lastRenewedAt).toBe(1_060_000);
    expect(json.expiresAt).toBe(1_060_000 + 3_600_000);

    const again = await call(h, "POST", `/v1/leases/${created.json.lease.vmId}/renew`, {});
    expect(again.json.renewCount).toBe(2);
  });

  test("renew honors ttl_ms extension", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    c.advance(60_000);
    const { json } = await call(h, "POST", `/v1/leases/${created.json.lease.vmId}/renew`, {
      ttl_ms: 300_000,
    });
    expect(json.expiresAt).toBe(1_060_000 + 300_000);
  });

  test("renew respects the maxLifetimeMs hard cap", async () => {
    // maxLifetime 4h with a 1h default → a late renew must pin to the cap.
    const c = makeCtx({ leaseDurationMs: 3_600_000, maxLifetimeMs: 4_000_000 });
    const h = handler(c);
    const created = await createLease(h, "r1");
    c.advance(3_599_000); // within expiresAt, but now + 1h exceeds the 4h cap
    const { status, json } = await call(h, "POST", `/v1/leases/${created.json.lease.vmId}/renew`, {});
    expect(status).toBe(200);
    expect(json.expiresAt).toBe(1_000_000 + 4_000_000);
    expect(json.renewCount).toBe(1);
  });

  test("renewing an expired lease → 410 LEASE_EXPIRED", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    c.advance(3_600_000 + 1_000); // past the 1h deadline
    const { status, json } = await call(h, "POST", `/v1/leases/${created.json.lease.vmId}/renew`, {});
    expect(status).toBe(410);
    expect(json.error.code).toBe("LEASE_EXPIRED");
    expect(json.error.retryable).toBe(false);
    expect(json.error.hint).toBe("no-retry");
  });

  test("renewing an unknown or released lease → 404", async () => {
    const c = makeCtx();
    const h = handler(c);
    const unknown = await call(h, "POST", "/v1/leases/nope/renew", {});
    expect(unknown.status).toBe(404);
    const created = await createLease(h, "r1");
    await call(h, "DELETE", `/v1/leases/${created.json.lease.vmId}`);
    const released = await call(h, "POST", `/v1/leases/${created.json.lease.vmId}/renew`, {});
    expect(released.status).toBe(404);
  });
});

describe("DELETE /v1/leases/{id}", () => {
  test("releases the lease, destroys the VM and its artifacts", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    const vmId = created.json.lease.vmId;
    await call(h, "POST", "/v1/artifacts", {
      lease_id: vmId,
      host_path: "/tmp/staged.bin",
      size_bytes: 7,
    });

    const { status, json } = await call(h, "DELETE", `/v1/leases/${vmId}`);
    expect(status).toBe(200);
    expect(json).toEqual({ vmId, status: "released" });
    expect(c.db.getVm(vmId)).toBeNull();
    expect(c.db.getArtifact("uuid-2")).toBeNull();
    expect(await c.proxmox.listVms()).toHaveLength(0);

    const again = await call(h, "DELETE", `/v1/leases/${vmId}`);
    expect(again.status).toBe(200);
    expect(again.json.status).toBe("released");

    const get = await call(h, "GET", `/v1/leases/${vmId}`);
    expect(get.status).toBe(200);
    expect(get.json.lease.status).toBe("released");
    expect(get.json.vm).toBeUndefined();
  });

  test("unknown lease → 404", async () => {
    const c = makeCtx();
    const { status, json } = await call(handler(c), "DELETE", "/v1/leases/nope");
    expect(status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
  });
});

describe("GET /v1/templates", () => {
  test("lists the full catalog as a plain array", async () => {
    const c = makeCtx();
    const { status, json } = await call(handler(c), "GET", "/v1/templates");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    const templates = json as any[];
    const hyprland = templates.find((t) => t.id === T.hyprland);
    expect(hyprland).toMatchObject({ os: "hyprland", availability: "available" });
    expect(hyprland.capabilities).toContain("screenshot");
    const x11 = templates.find((t) => t.id === T.x11);
    expect(x11.availability).toBe("available");
  });
});

describe("GET /v1/vms + GET /v1/vms/{uuid}", () => {
  test("lists created VMs as a plain array", async () => {
    const c = makeCtx();
    const h = handler(c);
    const { status, json } = await call(h, "GET", "/v1/vms");
    expect(status).toBe(200);
    expect(json).toEqual([]);
    await createLease(h, "r1");
    await createLease(h, "r2");
    const after = await call(h, "GET", "/v1/vms");
    expect(after.json).toHaveLength(2);
    expect(after.json[0].proxmoxTag).toBe("vmhub-2070-uuid-1");
  });

  test("GET /v1/vms/{uuid} resolves one VM; unknown → 404", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    const vmId = created.json.lease.vmId;
    const { status, json } = await call(h, "GET", `/v1/vms/${vmId}`);
    expect(status).toBe(200);
    expect(json.uuid).toBe(vmId);
    const missing = await call(h, "GET", "/v1/vms/ghost");
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("NOT_FOUND");
  });
});

describe("POST /v1/artifacts + GET /v1/artifacts/{id}", () => {
  test("registers and fetches an artifact (snake_case body)", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    const { status, json } = await call(h, "POST", "/v1/artifacts", {
      lease_id: created.json.lease.vmId,
      host_path: "/tmp/staged.bin",
      size_bytes: 42,
    });
    expect(status).toBe(201);
    expect(json).toMatchObject({
      id: "uuid-2",
      leaseId: created.json.lease.vmId,
      hostPath: "/tmp/staged.bin",
      sizeBytes: 42,
      inFlight: false,
    });
    const fetched = await call(h, "GET", `/v1/artifacts/${json.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json.sizeBytes).toBe(42);
  });

  test("camelCase artifact body still works", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    const { status, json } = await call(h, "POST", "/v1/artifacts", {
      leaseId: created.json.lease.vmId,
      hostPath: "/tmp/x.bin",
      sizeBytes: 9,
    });
    expect(status).toBe(201);
    expect(json.sizeBytes).toBe(9);
  });

  test("registers a missing file with size 0", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    const { status, json } = await call(h, "POST", "/v1/artifacts", {
      lease_id: created.json.lease.vmId,
      host_path: "/nonexistent/nowhere.bin",
    });
    expect(status).toBe(201);
    expect(json.sizeBytes).toBe(0);
  });

  test("artifacts require an active lease", async () => {
    const c = makeCtx();
    const h = handler(c);
    const noLease = await call(h, "POST", "/v1/artifacts", { lease_id: "nope", host_path: "/x" });
    expect(noLease.status).toBe(404);
    const created = await createLease(h, "r1");
    await call(h, "DELETE", `/v1/leases/${created.json.lease.vmId}`);
    const released = await call(h, "POST", "/v1/artifacts", {
      lease_id: created.json.lease.vmId,
      host_path: "/x",
    });
    expect(released.status).toBe(404);
  });

  test("artifact registration refuses on disk-full", async () => {
    const c = makeCtx();
    const h = handler(c);
    const created = await createLease(h, "r1");
    // Same db + proxmox, simulated full disk on a fresh handler.
    const full = createLiteHandler({ ...c.ctx, diskFreePct: () => 10 });
    const { status, json } = await call(full, "POST", "/v1/artifacts", {
      lease_id: created.json.lease.vmId,
      host_path: "/tmp/staged.bin",
    });
    expect(status).toBe(507);
    expect(json.error.code).toBe("DISK_FULL");
  });

  test("missing fields → 400; unknown artifact → 404", async () => {
    const c = makeCtx();
    const h = handler(c);
    const missing = await call(h, "POST", "/v1/artifacts", { lease_id: "x" });
    expect(missing.status).toBe(400);
    const missingPath = await call(h, "POST", "/v1/artifacts", { host_path: "/x" });
    expect(missingPath.status).toBe(400);
    const notFound = await call(h, "GET", "/v1/artifacts/nope");
    expect(notFound.status).toBe(404);
  });
});

describe("router hygiene", () => {
  test("unknown route → 404 typed error", async () => {
    const c = makeCtx();
    const h = handler(c);
    const res = await h(new Request("http://localhost/v1/bogus", { method: "GET" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  test("trailing slash still matches", async () => {
    const c = makeCtx();
    const h = handler(c);
    const res = await h(new Request("http://localhost/v1/templates/", { method: "GET" }));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Multi-node routing
// ---------------------------------------------------------------------------

interface FakeNode {
  config: NodeConfig;
  client: MockProxmox;
  node: VmNode;
  ramHeadroomMb: number;
}

/** Build a node with a live MockProxmox client behind a static NodeConfig. */
function fakeNode(id: string, overrides: Partial<VmNode["metadata"]> = {}, ramHeadroomMb = 8192): FakeNode {
  const config: NodeConfig = {
    id,
    baseUrl: `https://${id}.local:8006`,
    tokenEnv: `VMHUB_NODE_${id.toUpperCase()}_TOKEN`,
    metadata: { os: ["hyprland", "windows"], avx2: true, nestedVirt: true, ramMb: 8192 },
  };
  const client = new MockProxmox(id);
  const node: VmNode = {
    id,
    name: id,
    status: "online",
    metadata: {
      os: ["hyprland", "windows"],
      avx2: true,
      nestedVirt: true,
      ramMb: 8192,
      diskFreePct: 80,
      goldens: ["2070", "2100"],
      ...overrides,
    },
  };
  return { config, client, node, ramHeadroomMb };
}

class FakeProbe implements NodeProbe {
  constructor(private nodes: FakeNode[]) {}

  async snapshot(): Promise<VmNode[]> {
    return this.nodes.map((n) => n.node);
  }

  async results(): Promise<NodeProbeResult[]> {
    return this.nodes.map((n) => ({
      node: n.node,
      ramHeadroomMb: n.ramHeadroomMb,
      diskFreeBytes: 0,
      diskUsedBytes: 0,
    }));
  }

  async refresh(nodeId: string): Promise<NodeProbeResult | undefined> {
    const n = this.nodes.find((x) => x.config.id === nodeId);
    if (!n) return undefined;
    return { node: n.node, ramHeadroomMb: n.ramHeadroomMb, diskFreeBytes: 0, diskUsedBytes: 0 };
  }

  setStatus(nodeId: string, status: NodeStatus): void {
    const n = this.nodes.find((x) => x.config.id === nodeId);
    if (n) n.node = { ...n.node, status };
  }
}

function makeMultiNodeCtx(nodes: FakeNode[]): { ctx: RouterDeps; db: LiteDb } {
  const db = new LiteDb(":memory:");
  const registry = createNodeRegistry(
    nodes.map((n) => n.config),
    (cfg) => nodes.find((n) => n.config.id === cfg.id)!.client,
  );
  const ctx: RouterDeps = {
    db,
    proxmox: new MockProxmox("dl360p"),
    nodes: registry,
    probe: new FakeProbe(nodes),
    now: () => 1_000_000,
    uuid: (() => {
      let n = 0;
      return () => `uuid-${++n}`;
    })(),
    diskFreePct: () => 100,
    diskRefusalThresholdPct: 15,
    leaseDurationMs: 3_600_000,
    maxLifetimeMs: 86_400_000,
  };
  return { ctx, db };
}

describe("multi-node lease routing", () => {
  test("routes the lease to the node satisfying constraints (both online)", async () => {
    const nodes = [fakeNode("nodeA"), fakeNode("nodeB")];
    const { ctx } = makeMultiNodeCtx(nodes);
    const h = createLiteHandler(ctx);
    const { status, json } = await createLease(h, "r1");
    expect(status).toBe(201);
    expect(json.vm.nodeId).toBe("nodeA"); // tie broken by nodeId asc
    const nodeA = nodes.find((n) => n.config.id === "nodeA")!;
    expect((await nodeA.client.listVms())[0]).toMatchObject({
      proxmoxTag: "vmhub-2070-uuid-1",
      nodeId: "nodeA",
    });
  });

  test("skips a node that lacks the template's golden", async () => {
    const nodes = [
      fakeNode("nodeA"),
      fakeNode("nodeB", { goldens: ["2060"] }), // no hyprland golden
    ];
    const { ctx } = makeMultiNodeCtx(nodes);
    const { status, json } = await createLease(createLiteHandler(ctx), "r1");
    expect(status).toBe(201);
    expect(json.vm.nodeId).toBe("nodeA");
  });

  test("node with 0 RAM headroom → template unavailable, typed retryable", async () => {
    const nodes = [fakeNode("nodeA", {}, 0)];
    const { ctx } = makeMultiNodeCtx(nodes);
    const { status, json } = await createLease(createLiteHandler(ctx), "r1");
    expect(status).toBe(503);
    expect(json.error).toMatchObject({
      code: "NODE_UNAVAILABLE",
      retryable: true,
      hint: "wait-then-retry",
    });
    expect(json.error.detail).toContain("node");
  });

  test("all nodes unreachable → NODE_UNAVAILABLE retryable", async () => {
    const nodes = [fakeNode("nodeA"), fakeNode("nodeB")];
    const { ctx } = makeMultiNodeCtx(nodes);
    const probe = ctx.probe as FakeProbe;
    probe.setStatus("nodeA", "offline");
    probe.setStatus("nodeB", "stuck");
    const { status, json } = await createLease(createLiteHandler(ctx), "r1");
    expect(status).toBe(503);
    expect(json.error.code).toBe("NODE_UNAVAILABLE");
    expect(json.error.retryable).toBe(true);
  });

  test("TOCTOU: node dies between catalog read and create → typed retryable, no VM leaked", async () => {
    const nodes = [fakeNode("nodeA")];
    const { ctx } = makeMultiNodeCtx(nodes);
    const probe = ctx.probe as FakeProbe;
    // The catalog read passes, then the node flips offline before create.
    probe.setStatus("nodeA", "offline");
    const { status, json } = await createLease(createLiteHandler(ctx), "r1");
    expect(status).toBe(503);
    expect(json.error.code).toBe("NODE_UNAVAILABLE");
    const nodeA = nodes.find((n) => n.config.id === "nodeA")!;
    expect(await nodeA.client.listVms()).toHaveLength(0);
  });

  test("GET /v1/nodes returns observed node state", async () => {
    const nodes = [fakeNode("nodeA"), fakeNode("nodeB")];
    const { ctx } = makeMultiNodeCtx(nodes);
    const { status, json } = await call(createLiteHandler(ctx), "GET", "/v1/nodes");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
    expect(json.map((n: VmNode) => n.id)).toEqual(["nodeA", "nodeB"]);
    expect(json[0].status).toBe("online");
  });

  test("force-destroy requires a stuck node + explicit confirmation", async () => {
    const nodes = [fakeNode("nodeA")];
    const { ctx, db } = makeMultiNodeCtx(nodes);
    const h = createLiteHandler(ctx);
    const created = await createLease(h, "r1");
    const vmId = created.json.lease.vmId;

    // Node online → force-destroy refused.
    const notStuck = await call(h, "DELETE", `/v1/leases/${vmId}/force`, { confirm: "destroy" });
    expect(notStuck.status).toBe(400);

    // Missing confirmation → refused even when stuck.
    const probe = ctx.probe as FakeProbe;
    probe.setStatus("nodeA", "stuck");
    const noConfirm = await call(h, "DELETE", `/v1/leases/${vmId}/force`, {});
    expect(noConfirm.status).toBe(400);

    // Confirmed + stuck → lease released, VM destroyed.
    const forced = await call(h, "DELETE", `/v1/leases/${vmId}/force`, { confirm: "destroy" });
    expect(forced.status).toBe(200);
    expect(forced.json).toMatchObject({ vmId, status: "released", forced: true });
    expect(db.getLease(vmId)?.status).toBe("released");
    const nodeA = nodes.find((n) => n.config.id === "nodeA")!;
    expect(await nodeA.client.listVms()).toHaveLength(0);
  });
});
