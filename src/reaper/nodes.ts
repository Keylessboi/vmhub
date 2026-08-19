/**
 * vmhub-reaper per-node registry — static NodeConfig (the frozen shared shape)
 * plus a client factory resolved AT SWEEP TIME.
 *
 * Node API base URLs change (Tailscale), so a client is built fresh per node
 * per sweep and never cached across sweeps. The registry is config-only: live
 * state (status/stuck counters) lives in the ledger, never here.
 */

import { MockProxmox, type ProxmoxClient } from "../lite/proxmox.ts";
import { RealProxmox } from "../lite/proxmox-real.ts";
import type { NodeConfig } from "../shared/types.ts";
import { DEFAULT_NODE_ID } from "../shared/schema.ts";
import { resolveNodeConfigs } from "../shared/config.ts";

/** Re-export from shared config (single source of truth). */
export { resolveNodeConfigs } from "../shared/config.ts";

/**
 * A node the reaper can sweep. `createClient` is called at sweep time (per
 * sweep, never cached across sweeps) because node API base URLs change
 * (Tailscale). The static shape is the shared frozen NodeConfig.
 */
export interface SweepNode {
  config: NodeConfig;
  /** Build a fresh client for THIS node. Called once per sweep. */
  createClient: () => ProxmoxClient;
}

/** Static default node config (single-node deployments / legacy path). */
export function defaultNodeConfig(id: string = DEFAULT_NODE_ID): NodeConfig {
  return { id, baseUrl: "", tokenEnv: "", metadata: { os: [], avx2: false, nestedVirt: false, ramMb: 0 } };
}

/**
 * Per-node client factory: RealProxmox when the node has a token AND a base
 * URL; otherwise a node-aware MockProxmox (dev/test). Reads the token from the
 * env var named by config.tokenEnv at call time — never cached.
 */
export function createClientForNode(config: NodeConfig): ProxmoxClient {
  const token = process.env[config.tokenEnv];
  if (token && config.baseUrl) {
    return new RealProxmox({
      host: config.baseUrl,
      tokenId: process.env.PVE_TOKEN_ID || "vmhub@pve!automation",
      token,
      nodeId: config.id,
    });
  }
  return new MockProxmox(config.id);
}
