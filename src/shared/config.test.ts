import { describe, it, expect } from "vitest";
import { resolveNodeConfigs } from "./config.ts";

describe("resolveNodeConfigs", () => {
  it("defaults to a single dl360p node with legacy PVE_TOKEN fallback", () => {
    const cfgs = resolveNodeConfigs({});
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0]?.id).toBe("dl360p");
    expect(cfgs[0]?.tokenEnv).toBe("PVE_TOKEN");
    expect(cfgs[0]?.baseUrl).toBe("");
  });

  it("uses PVE_HOST as baseUrl fallback for the default node", () => {
    const cfgs = resolveNodeConfigs({ PVE_HOST: "10.0.0.1:8006" });
    expect(cfgs[0]?.baseUrl).toBe("10.0.0.1:8006");
    expect(cfgs[0]?.tokenEnv).toBe("PVE_TOKEN");
  });

  it("per-node BASE_URL overrides PVE_HOST for the default node", () => {
    const cfgs = resolveNodeConfigs({
      PVE_HOST: "10.0.0.1:8006",
      VMHUB_NODE_DL360P_BASE_URL: "10.0.0.2:8006",
    });
    expect(cfgs[0]?.baseUrl).toBe("10.0.0.2:8006");
  });

  it("uses per-node token env when VMHUB_NODE_<ID>_TOKEN exists", () => {
    const cfgs = resolveNodeConfigs({
      VMHUB_NODES: "dl360p, nodeb",
      VMHUB_NODE_NODEB_TOKEN: "secret",
    });
    expect(cfgs[1]?.tokenEnv).toBe("VMHUB_NODE_NODEB_TOKEN");
  });

  it("default node falls back to PVE_TOKEN when no per-node token is set", () => {
    const cfgs = resolveNodeConfigs({
      VMHUB_NODES: "dl360p, nodeb",
      VMHUB_NODE_NODEB_TOKEN: "secret",
    });
    expect(cfgs[0]?.tokenEnv).toBe("PVE_TOKEN");
  });

  it("default node uses per-node token env when VMHUB_NODE_DL360P_TOKEN exists", () => {
    const cfgs = resolveNodeConfigs({
      VMHUB_NODE_DL360P_TOKEN: "custom",
    });
    expect(cfgs[0]?.tokenEnv).toBe("VMHUB_NODE_DL360P_TOKEN");
  });

  it("non-default node without per-node token still returns the standard env var name", () => {
    const cfgs = resolveNodeConfigs({
      VMHUB_NODES: "nodeb",
    });
    expect(cfgs[0]?.tokenEnv).toBe("VMHUB_NODE_NODEB_TOKEN");
  });

  it("trims whitespace from node ids", () => {
    const cfgs = resolveNodeConfigs({
      VMHUB_NODES: "  dl360p , nodeb , nodec  ",
    });
    expect(cfgs.map((c) => c.id)).toEqual(["dl360p", "nodeb", "nodec"]);
  });

  it("filters out empty entries from comma-separated list", () => {
    const cfgs = resolveNodeConfigs({
      VMHUB_NODES: "dl360p,,nodeb,",
    });
    expect(cfgs.map((c) => c.id)).toEqual(["dl360p", "nodeb"]);
  });

  it("returns empty metadata for unknown nodes", () => {
    const cfgs = resolveNodeConfigs({ VMHUB_NODES: "unknown-node" });
    expect(cfgs[0]?.metadata).toEqual({ os: [], avx2: false, nestedVirt: false, ramMb: 0 });
  });

  it("returns static metadata for dl360p", () => {
    const cfgs = resolveNodeConfigs({});
    expect(cfgs[0]?.metadata.os).toEqual(["hyprland", "windows", "x11"]);
    expect(cfgs[0]?.metadata.avx2).toBe(false);
    expect(cfgs[0]?.metadata.nestedVirt).toBe(true);
    expect(cfgs[0]?.metadata.ramMb).toBe(131_072);
  });

  it("empty VMHUB_NODES falls back to default node", () => {
    const cfgs = resolveNodeConfigs({ VMHUB_NODES: "" });
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0]?.id).toBe("dl360p");
  });

  it("whitespace-only VMHUB_NODES falls back to default node", () => {
    const cfgs = resolveNodeConfigs({ VMHUB_NODES: "   " });
    expect(cfgs).toHaveLength(1);
    expect(cfgs[0]?.id).toBe("dl360p");
  });

  it("per-node BASE_URL for non-default nodes", () => {
    const cfgs = resolveNodeConfigs({
      VMHUB_NODES: "nodeb",
      VMHUB_NODE_NODEB_BASE_URL: "10.0.0.3:8006",
    });
    expect(cfgs[0]?.baseUrl).toBe("10.0.0.3:8006");
  });

  it("non-default node without BASE_URL gets empty string", () => {
    const cfgs = resolveNodeConfigs({ VMHUB_NODES: "nodeb" });
    expect(cfgs[0]?.baseUrl).toBe("");
  });

  it("preserves idempotency: same env produces same configs", () => {
    const env = { VMHUB_NODES: "dl360p, nodeb", VMHUB_NODE_NODEB_TOKEN: "t" };
    const a = resolveNodeConfigs(env);
    const b = resolveNodeConfigs(env);
    expect(a).toEqual(b);
  });
});
