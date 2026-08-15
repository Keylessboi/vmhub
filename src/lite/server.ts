/**
 * vmhub-lite — the control plane HTTP server (Phase 1.3).
 *
 * SECURITY NOTE (v1): there is deliberately NO auth layer. The server binds to
 * 127.0.0.1 only and is meant for vmhub-mcp running on the same host. Never
 * expose this port on a network; an auth/token layer is planned for a later
 * phase.
 *
 * Proxmox client selection: PVE_HOST/PVE_TOKEN are read from the environment
 * when present. The real Proxmox client lands in Phase 3.1, so both paths
 * currently resolve to the in-memory MockProxmox.
 */
import { serve } from "bun";
import { mkdirSync } from "node:fs";
import { LiteDb, resolveDbPath } from "./db.ts";
import { MockProxmox, type ProxmoxClient } from "./proxmox.ts";
import { RealProxmox } from "./proxmox-real.ts";
import { createLiteHandler, type RouterDeps } from "./routes.ts";
import { checkDesktopReady } from "./readiness.ts";

export interface LiteServerConfig {
  port?: number;
  hostname?: string;
  /** Directory holding leases.sqlite + per-lease scratch. Default ./leases. */
  leaseDir?: string;
  /** Injected db (tests use :memory:). */
  db?: LiteDb;
  /** Injected proxmox client (tests inject MockProxmox). */
  proxmox?: ProxmoxClient;
  /** Extra router options (clock/uuid/disk injection for tests). */
  deps?: Partial<RouterDeps>;
}

export function startLiteServer(config: LiteServerConfig = {}): ReturnType<typeof serve> {
  const leaseDir = config.leaseDir ?? process.env.VMHUB_LEASE_DIR ?? "./leases";
  mkdirSync(leaseDir, { recursive: true });

  const db = config.db ?? new LiteDb(resolveDbPath(leaseDir));
  const proxmox = config.proxmox ?? createProxmoxClient();
  const handler = createLiteHandler({
    db,
    proxmox,
    diskRefusalThresholdPct: readThresholdPct(),
    // Readiness gate (issue #3): only x11 leases probe the desktop (openbox).
    // Other adapters have no openbox (hyprland runs Hyprland, headless has no
    // desktop, windows/android/macos/ios have no in-VM openbox) — gating them
    // on an openbox probe would turn every healthy lease into 'error'.
    desktopReady: (vm) => (vm.adapter === "x11" ? checkDesktopReady(vm) : Promise.resolve(true)),
    ...(config.deps ?? {}),
  });

  const hostname = config.hostname ?? "127.0.0.1";
  const port = config.port ?? Number(process.env.VMHUB_PORT ?? 8787);
  return serve({
    hostname,
    port,
    fetch: (req) => handler(req),
  });
}

/**
 * Select the Proxmox client. PVE_HOST/PVE_TOKEN enable the real client
 * (Phase 3.1); otherwise the in-memory mock is used.
 */
export function createProxmoxClient(): ProxmoxClient {
  if (process.env.PVE_HOST && process.env.PVE_TOKEN) {
    return new RealProxmox({
      host: process.env.PVE_HOST,
      tokenId: process.env.PVE_TOKEN_ID || "vmhub@pve!automation",
      token: process.env.PVE_TOKEN,
    });
  }
  return new MockProxmox();
}

function readThresholdPct(): number {
  const raw = Number(process.env.VMHUB_DISK_FULL_REFUSAL_PCT);
  return Number.isFinite(raw) && raw > 0 && raw < 100 ? raw : 15;
}

if (import.meta.main) {
  const client = createProxmoxClient();
  const server = startLiteServer({ proxmox: client });
  const mode = client instanceof RealProxmox ? `real proxmox (${process.env.PVE_HOST})` : "mock proxmox";
  console.log(`vmhub-lite listening on http://${server.hostname}:${server.port} (${mode})`);
}
