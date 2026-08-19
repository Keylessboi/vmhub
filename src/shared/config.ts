/**
 * Shared node configuration resolution — THE single source of truth for
 * resolving `NodeConfig[]` from environment variables.
 *
 * Both the control plane (vmhub-lite) and the independent reaper
 * (vmhub-reaper) import this function. The previous dual implementations
 * had subtle differences in token resolution for the default node; this
 * unified version uses the reaper's correct behavior (checking env var
 * existence, not reading the value as a name).
 *
 * Env contract:
 *   VMHUB_NODES                    comma-separated node ids (default: dl360p)
 *   VMHUB_NODE_<ID>_BASE_URL       per-node API base host[:port]
 *   VMHUB_NODE_<ID>_TOKEN          per-node scoped token (env NAME in tokenEnv)
 *   PVE_HOST                       legacy default-node base URL fallback
 *   PVE_TOKEN                      legacy default-node token env var name
 */
import type { NodeConfig } from "./types.ts";
import { DEFAULT_NODE_ID } from "./schema.ts";

/** Env var listing the node fleet ids (comma-separated). */
const NODES_ENV = "VMHUB_NODES";

/**
 * Static metadata for known nodes. The control plane uses this for constraint
 * evaluation; the reaper ignores it (sweep only needs id/baseUrl/tokenEnv).
 */
const NODE_STATIC_METADATA: Record<string, NodeConfig["metadata"]> = {
  dl360p: { os: ["hyprland", "windows", "x11"], avx2: false, nestedVirt: true, ramMb: 131_072 },
};

/** Default empty metadata for unknown nodes. */
const EMPTY_METADATA: NodeConfig["metadata"] = { os: [], avx2: false, nestedVirt: false, ramMb: 0 };

/**
 * Build the static node registry from env variables.
 *
 * Single-node deployments (the common case) set no VMHUB_NODES and get the
 * default dl360p node, which reads its base URL from PVE_HOST and its token
 * from the env var named by `tokenEnv` (default: "PVE_TOKEN").
 *
 * Multi-node fleets set VMHUB_NODES=a,b,c and provide per-node env vars.
 */
export function resolveNodeConfigs(env: Record<string, string | undefined> = process.env): NodeConfig[] {
  const raw = (env[NODES_ENV] ?? "").trim();
  const ids = raw !== "" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [DEFAULT_NODE_ID];
  return ids.map((id) => {
    const upper = id.toUpperCase();
    const perNodeToken = env[`VMHUB_NODE_${upper}_TOKEN`];
    return {
      id,
      baseUrl: env[`VMHUB_NODE_${upper}_BASE_URL`] ?? (id === DEFAULT_NODE_ID ? env.PVE_HOST : undefined) ?? "",
      // Per-node token: if the per-node env var exists, use its standard name.
      // Legacy default node falls back to PVE_TOKEN when no per-node token is set.
      tokenEnv:
        perNodeToken !== undefined
          ? `VMHUB_NODE_${upper}_TOKEN`
          : id === DEFAULT_NODE_ID
            ? "PVE_TOKEN"
            : `VMHUB_NODE_${upper}_TOKEN`,
      metadata: NODE_STATIC_METADATA[id] ?? EMPTY_METADATA,
    };
  });
}
