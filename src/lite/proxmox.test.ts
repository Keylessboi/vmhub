/**
 * MockProxmox tests. Run with `bun test src/lite`.
 */
import { describe, expect, test } from "vitest";
import { MockProxmox } from "./proxmox.ts";
import { isVmError } from "./proxmox.ts";
import { DEFAULT_NODE_ID } from "../shared/schema.ts";

const input = {
  templateId: "hyprland-2404",
  name: "hl-abcd1234",
  proxmoxTag: "vmhub-hl-uuid-1",
};

describe("MockProxmox templates", () => {
  test("listTemplates returns the shared-shape catalog", async () => {
    const px = new MockProxmox();
    const templates = await px.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(4);
    const hyprland = templates.find((t) => t.id === "hyprland-2404");
    expect(hyprland).toMatchObject({
      os: "hyprland",
      availability: "available",
      ramMb: 8192,
      vcpus: 4,
    });
    expect(hyprland?.capabilities).toContain("screenshot");
    expect(hyprland?.capabilities).toContain("clone_repo");
    const ios = templates.find((t) => t.id === "ios-sim-stub");
    expect(ios?.availability).toBe("stub");
    expect(ios?.capabilities).toEqual([]);
    expect(ios?.reason).toBeTruthy();
  });
});

describe("MockProxmox createVm", () => {
  test("creates a running VM with a monotonic VMID and identity tag", async () => {
    const px = new MockProxmox();
    const a = await px.createVm({ ...input, name: "a" });
    const b = await px.createVm({ ...input, name: "b" });
    expect(a).toMatchObject({ vmid: 1000, status: "running", proxmoxTag: "vmhub-hl-uuid-1" });
    expect(a.tags).toContain("vmhub-hl-uuid-1");
    expect(b.vmid).toBe(1001);
    expect(a.vmid).not.toBe(b.vmid);
  });

  test("per-node VMID counters: two nodes can both hold vmid 1000", async () => {
    // Regression: a single shared counter made nodeB's first VM collide with
    // nodeA's first VM on multi-node. The real Proxmox UNIQUE(nodeId, vmid)
    // contract allows the same vmid on different nodes.
    const nodeA = new MockProxmox("nodeA");
    const nodeB = new MockProxmox("nodeB");
    const a = await nodeA.createVm({ ...input, name: "a" });
    const b = await nodeB.createVm({ ...input, name: "b" });
    expect(a.vmid).toBe(1000);
    expect(b.vmid).toBe(1000);
    expect(a.nodeId).toBe("nodeA");
    expect(b.nodeId).toBe("nodeB");
    expect((await nodeA.listVms()).map((vm) => vm.vmid)).toEqual([1000]);
    expect((await nodeB.listVms()).map((vm) => vm.vmid)).toEqual([1000]);
  });

  test("default nodeId is the legacy single node", async () => {
    const px = new MockProxmox();
    const vm = await px.createVm(input);
    expect(vm.nodeId).toBe(DEFAULT_NODE_ID);
  });

  test("diskFreeBytes and diskUsedBytes report the host filesystem", async () => {
    const px = new MockProxmox();
    const free = await px.diskFreeBytes();
    const used = await px.diskUsedBytes();
    expect(free).toBeGreaterThan(0);
    expect(used).toBeGreaterThan(0);
    expect(free).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  test("unknown template → typed NOT_FOUND VmError", async () => {
    const px = new MockProxmox();
    try {
      await px.createVm({ ...input, templateId: "ghost" });
      expect.unreachable();
    } catch (err) {
      expect(isVmError(err)).toBe(true);
      if (isVmError(err)) {
        expect(err.code).toBe("NOT_FOUND");
        expect(err.retryable).toBe(false);
      }
    }
  });

  test("unavailable template → CAPABILITY_UNAVAILABLE with reason", async () => {
    const px = new MockProxmox();
    try {
      await px.createVm({ ...input, templateId: "ubuntu-x11" });
      expect.unreachable();
    } catch (err) {
      if (isVmError(err)) {
        expect(err.code).toBe("CAPABILITY_UNAVAILABLE");
        expect(err.detail).toBeTruthy();
      }
    }
  });

  test("getVm + destroyVm + reset lifecycle", async () => {
    const px = new MockProxmox();
    const vm = await px.createVm(input);
    expect((await px.getVm(vm.vmid)).vmid).toBe(vm.vmid);
    await px.destroyVm(vm.vmid);
    expect(await px.listVms()).toHaveLength(0);
    // destroyVm is idempotent
    await expect(px.destroyVm(vm.vmid)).resolves.toBeUndefined();
    try {
      await px.getVm(vm.vmid);
      expect.unreachable();
    } catch (err) {
      if (isVmError(err)) expect(err.code).toBe("NOT_FOUND");
    }
    await px.createVm(input);
    expect(await px.listVms()).toHaveLength(1);
    px.reset();
    expect(await px.listVms()).toHaveLength(0);
  });
});
