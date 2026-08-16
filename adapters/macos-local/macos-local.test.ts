/**
 * MacosLocalAdapter unit tests — mocked SSH and process lifecycle.
 * No live QEMU or SSH required. Tests capability declaration, error paths,
 * dispatch routing, and SSH arg construction.
 */
import { describe, expect, it, vi } from "vitest";
import { MacosLocalAdapter } from "./index.ts";
import { localMacosSshArgs, localScpArgs } from "./ssh.ts";
import type { Vm, CapabilityId, InputAction } from "../../src/shared/types.ts";
import { CAPABILITIES } from "../../src/shared/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVm(overrides: Partial<Vm> = {}): Vm {
  return {
    uuid: "test-vm-001",
    nodeId: "local",
    templateId: "macos-qemu",
    adapter: "macos-local",
    capabilities: [
      CAPABILITIES.screenshot,
      CAPABILITIES.inspect,
      CAPABILITIES.exec,
    ],
    proxmoxTag: "vmhub-test-test-vm-001",
    namePrefix: "test",
    status: "ready",
    createdAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Adapter capability declaration
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter capabilities", () => {
  it("declares correct adapter identity", () => {
    const adapter = new MacosLocalAdapter();
    expect(adapter.id).toBe("macos-local");
  });

  it("declares macOS windowing system", () => {
    const adapter = new MacosLocalAdapter();
    expect(adapter.capability.os).toBe("macos");
    expect(adapter.capability.windowing).toContain("macos");
  });

  it("declares all input modalities", () => {
    const adapter = new MacosLocalAdapter();
    expect(adapter.capability.input).toContain("click");
    expect(adapter.capability.input).toContain("type");
    expect(adapter.capability.input).toContain("key");
    expect(adapter.capability.input).toContain("paste");
    expect(adapter.capability.input).toContain("drag");
  });

  it("declares SCP file transport and exec support", () => {
    const adapter = new MacosLocalAdapter();
    expect(adapter.capability.files).toContain("scp");
    expect(adapter.capability.exec).toBe(true);
  });

  it("availableTools returns all expected capability ids", () => {
    const adapter = new MacosLocalAdapter();
    const tools = adapter.availableTools();
    expect(tools).toContain(CAPABILITIES.screenshot);
    expect(tools).toContain(CAPABILITIES.inspect);
    expect(tools).toContain(CAPABILITIES.click);
    expect(tools).toContain(CAPABILITIES.type);
    expect(tools).toContain(CAPABILITIES.key);
    expect(tools).toContain(CAPABILITIES.paste);
    expect(tools).toContain(CAPABILITIES.drag);
    expect(tools).toContain(CAPABILITIES.exec);
    expect(tools).toContain(CAPABILITIES.putFile);
    expect(tools).toContain(CAPABILITIES.getFile);
    expect(tools).toContain(CAPABILITIES.cloneRepo);
    expect(tools).toContain(CAPABILITIES.dispatch);
  });
});

// ---------------------------------------------------------------------------
// Error paths — methods called on non-existent / unregistered VMs
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter error paths", () => {
  it("exec throws when called on unregistered VM", async () => {
    const adapter = new MacosLocalAdapter();
    const vm = makeVm();
    await expect(adapter.exec(vm, "ls")).rejects.toThrow("not running");
  });

  it("screenshot throws when called on unregistered VM", async () => {
    const adapter = new MacosLocalAdapter();
    const vm = makeVm();
    await expect(adapter.screenshot(vm)).rejects.toThrow("not running");
  });

  it("input throws when called on unregistered VM", async () => {
    const adapter = new MacosLocalAdapter();
    const vm = makeVm();
    const action: InputAction = { kind: "click", x: 100, y: 200 };
    await expect(adapter.input(vm, action)).rejects.toThrow("not running");
  });

  it("dispatch throws for unknown verb on unregistered VM", async () => {
    const adapter = new MacosLocalAdapter();
    const vm = makeVm();
    await expect(adapter.dispatch(vm, "bogus", {})).rejects.toThrow(
      "not running",
    );
  });
});

// ---------------------------------------------------------------------------
// Inspect and listWindows — work without a running process
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter inspect/listWindows", () => {
  it("inspect returns a root semantic element", async () => {
    const adapter = new MacosLocalAdapter();
    const vm = makeVm();
    const result = await adapter.inspect(vm);
    expect(result.role).toBe("VM");
    expect(result.name).toBe("local-qemu");
    expect(result.children).toEqual([]);
  });

  it("listWindows returns empty array without a running process", async () => {
    const adapter = new MacosLocalAdapter();
    const vm = makeVm();
    const windows = await adapter.listWindows(vm);
    expect(windows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dispatch routing
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter dispatch", () => {
  it("dispatch throws INTERNAL for unknown verb on unregistered VM", async () => {
    const adapter = new MacosLocalAdapter();
    const vm = makeVm();
    try {
      await adapter.dispatch(vm, "unknown", {});
      expect.fail("should have thrown");
    } catch (e: unknown) {
      // getEntry() throws INTERNAL before the verb switch
      expect((e as { code: string }).code).toBe("INTERNAL");
    }
  });
});

// ---------------------------------------------------------------------------
// stopVm — resolves silently for non-existent VM
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter stopVm", () => {
  it("resolves silently when VM is not registered", async () => {
    const adapter = new MacosLocalAdapter();
    await adapter.stopVm("nonexistent"); // no throw
  });
});

// ---------------------------------------------------------------------------
// SSH arg construction — local, no ProxyJump
// ---------------------------------------------------------------------------

describe("localMacosSshArgs", () => {
  it("builds SSH argv with port, key, and no ProxyJump", () => {
    const args = localMacosSshArgs("127.0.0.1", 2222, "/tmp/id_rsa");
    expect(args).toContain("-p");
    expect(args).toContain("2222");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/id_rsa");
    expect(args).toContain("-o");
    expect(args).toContain("StrictHostKeyChecking=no");
    expect(args.some((a) => a.includes("ProxyJump"))).toBe(false);
    expect(args).toContain("admin@127.0.0.1");
  });

  it("includes UserKnownHostsFile=/dev/null to avoid polluting known_hosts", () => {
    const args = localMacosSshArgs("10.0.0.1", 3333, "/home/user/.ssh/id_ed25519");
    expect(args).toContain("UserKnownHostsFile=/dev/null");
  });
});

describe("localScpArgs", () => {
  it("builds put argv (host→guest)", () => {
    const args = localScpArgs("127.0.0.1", 2222, "/tmp/id_rsa", "/local/file", "/remote/file", "put");
    expect(args).toContain("-P");
    expect(args).toContain("2222");
    expect(args).toContain("/local/file");
    expect(args.some((a) => a.includes("admin@127.0.0.1:/remote/file"))).toBe(true);
  });

  it("builds get argv (guest→host)", () => {
    const args = localScpArgs("127.0.0.1", 2222, "/tmp/id_rsa", "/local/file", "/remote/file", "get");
    expect(args.some((a) => a.includes("admin@127.0.0.1:/remote/file"))).toBe(true);
    expect(args).toContain("/local/file");
  });
});
