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

const T = {
  hyprland: "hyprland-2404",
  x11: "ubuntu-x11",
  ios: "ios-sim-stub",
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
      proxmoxTag: "vmhub-hyprland-uuid-1",
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

  test("unavailable/stub templates → 409 CAPABILITY_UNAVAILABLE with reason", async () => {
    const c = makeCtx();
    const h = handler(c);
    const x11 = await createLease(h, "r-x11", T.x11);
    expect(x11.status).toBe(409);
    expect(x11.json.error.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(x11.json.error.detail).toBeTruthy();
    const ios = await createLease(h, "r-ios", T.ios);
    expect(ios.status).toBe(409);
    expect(ios.json.error.code).toBe("CAPABILITY_UNAVAILABLE");
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
    const ios = templates.find((t) => t.id === T.ios);
    expect(ios.availability).toBe("stub");
    expect(ios.capabilities).toEqual([]);
    const x11 = templates.find((t) => t.id === T.x11);
    expect(x11.availability).toBe("unavailable");
    expect(x11.reason).toBeTruthy();
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
    expect(after.json[0].proxmoxTag).toBe("vmhub-hyprland-uuid-1");
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
