/**
 * macOS local adapter — SSH runner + file transport unit tests.
 *
 * Mocks the QemuProcess (no real QEMU) and the SshRunner (no real SSH).
 * Tests that the adapter delegates to the correct runner with correct argv,
 * handles success and error paths, and includes the key path in SSH args.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SshRunner, SshRunResult } from "../transport.ts";
import type { Vm, InputAction } from "../../src/shared/types.ts";
import { CAPABILITIES } from "../../src/shared/types.ts";

// ---------------------------------------------------------------------------
// Mock QemuProcess — avoids spawning real QEMU
// ---------------------------------------------------------------------------

let mockExecResult: { stdout: string; stderr: string } = {
  stdout: "",
  stderr: "",
};
let mockExecReject = false;

vi.mock("./transport.ts", () => {
  return {
    QemuProcess: class MockQemuProcess {
      constructor(_args: unknown) {}
      async start() {}
      async stop() {}
      async status() {
        return { running: true, pid: 12345, serialLog: "" };
      }
      async screenshot() {
        // Return a minimal valid PNG (1x1 pixel).
        return Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
          0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
          0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
          0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
          0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00,
          0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc, 0x33, 0x00, 0x00, 0x00,
          0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
        ]);
      }
      async exec(cmd: string) {
        if (mockExecReject) {
          throw new Error("QMP exec failed");
        }
        return mockExecResult.stdout;
      }
      buildArgs() {
        return [];
      }
    },
  };
});

// ---------------------------------------------------------------------------
// Import after mock setup
// ---------------------------------------------------------------------------

import { MacosLocalAdapter } from "./index.ts";

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

const QEMU_ARGS = {
  qemuPath: "/usr/bin/qemu-system-x86_64",
  memory: "8192",
  cpu: "Skylake-Client,-hle,-rtm",
  drives: [{ file: "golden.qcow2", format: "qcow2", if: "virtio" }],
  netdev: {
    id: "net0",
    options: "hostfwd=tcp::2222-:22",
    device: "virtio-net-pci",
  },
  serial: { type: "file" as const, path: "serial.log" },
  monitor: "/tmp/qemu-monitor.sock",
  display: "none",
};

function makeMockSshRunner(): SshRunner & {
  calls: Array<{ bin: string; args: string[] }>;
  results: SshRunResult[];
  throwOnNext: boolean;
} {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const results: SshRunResult[] = [];
  const state = { throwOnNext: false };
  return {
    calls,
    results,
    get throwOnNext() { return state.throwOnNext; },
    set throwOnNext(v: boolean) { state.throwOnNext = v; },
    async run(bin: string, args: string[], _opts?: unknown): Promise<SshRunResult> {
      calls.push({ bin, args });
      if (state.throwOnNext) {
        state.throwOnNext = false;
        throw new Error(results.shift()?.stderr ?? "connection refused");
      }
      const result = results.shift() ?? {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
      return result;
    },
  };
}

async function makeAdapterWithVm(
  sshRunner?: SshRunner,
  keyPath = "/tmp/id_rsa",
) {
  const runner = sshRunner ?? makeMockSshRunner();
  const adapter = new MacosLocalAdapter({
    ssh: runner,
    sshHost: "127.0.0.1",
    keyPath,
  });
  await adapter.startVm("test-vm-001", QEMU_ARGS);
  return { adapter, runner };
}

// ---------------------------------------------------------------------------
// runCommand — exec via QMP guest-exec
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter runCommand (exec)", () => {
  it("returns stdout and exitCode 0 on success", async () => {
    mockExecResult = { stdout: "hello from guest\n", stderr: "" };
    mockExecReject = false;
    const { adapter } = await makeAdapterWithVm();
    const vm = makeVm();
    const result = await adapter.exec(vm, "echo", ["hello"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from guest\n");
    expect(result.stderr).toBe("");
  });

  it("returns exitCode 1 and stderr on QMP failure", async () => {
    mockExecReject = true;
    const { adapter } = await makeAdapterWithVm();
    const vm = makeVm();
    const result = await adapter.exec(vm, "bad-command");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("QMP exec failed");
  });

  it("throws when VM is not registered", async () => {
    const { adapter } = await makeAdapterWithVm();
    const vm = makeVm({ uuid: "nonexistent" });
    await expect(adapter.exec(vm, "ls")).rejects.toThrow("not running");
  });
});

// ---------------------------------------------------------------------------
// putFile — SCP upload (host → guest)
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter putFile (upload)", () => {
  it("runs scp with correct args for put direction", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await adapter.putFile(vm, "/local/file.txt", "/remote/file.txt");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.bin).toBe("scp");
    const args = runner.calls[0]!.args;
    // SCP options
    expect(args).toContain("-P");
    expect(args).toContain("2222");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/id_rsa");
    expect(args).toContain("-o");
    expect(args).toContain("StrictHostKeyChecking=no");
    expect(args).toContain("UserKnownHostsFile=/dev/null");
    // Local path comes before remote target in put direction
    expect(args).toContain("/local/file.txt");
    expect(args.some((a) => a.includes("admin@127.0.0.1:/remote/file.txt"))).toBe(true);
  });

  it("propagates SSH runner connection errors", async () => {
    const runner = makeMockSshRunner();
    runner.results.push({ exitCode: 1, stdout: "", stderr: "scp: Connection refused" });
    runner.throwOnNext = true;
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await expect(adapter.putFile(vm, "/local/file.txt", "/remote/file.txt")).rejects.toThrow(
      "scp: Connection refused",
    );
  });
});

// ---------------------------------------------------------------------------
// getFile — SCP download (guest → host)
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter getFile (download)", () => {
  it("runs scp with correct args for get direction", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await adapter.getFile(vm, "/remote/file.txt", "/local/file.txt");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.bin).toBe("scp");
    const args = runner.calls[0]!.args;
    expect(args).toContain("-P");
    expect(args).toContain("2222");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/id_rsa");
    // Remote target comes before local path in get direction
    expect(args.some((a) => a.includes("admin@127.0.0.1:/remote/file.txt"))).toBe(true);
    expect(args).toContain("/local/file.txt");
  });

  it("propagates SSH runner connection errors", async () => {
    const runner = makeMockSshRunner();
    runner.results.push({ exitCode: 1, stdout: "", stderr: "scp: No such file" });
    runner.throwOnNext = true;
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await expect(adapter.getFile(vm, "/remote/file.txt", "/local/file.txt")).rejects.toThrow(
      "scp: No such file",
    );
  });
});

// ---------------------------------------------------------------------------
// cloneRepo — SSH + git clone
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter cloneRepo", () => {
  it("runs ssh with git clone command and correct args", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await adapter.cloneRepo(vm, "https://github.com/user/repo.git", "/tmp/repo");
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.bin).toBe("ssh");
    const args = runner.calls[0]!.args;
    // SSH base args
    expect(args).toContain("-T");
    expect(args).toContain("-p");
    expect(args).toContain("2222");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/id_rsa");
    expect(args).toContain("admin@127.0.0.1");
    // git clone command appended after SSH base
    expect(args).toContain("git");
    expect(args).toContain("clone");
    expect(args).toContain("--");
    expect(args).toContain("https://github.com/user/repo.git");
    expect(args).toContain("/tmp/repo");
  });

  it("propagates SSH runner connection errors", async () => {
    const runner = makeMockSshRunner();
    runner.results.push({ exitCode: 128, stdout: "", stderr: "git: not found" });
    runner.throwOnNext = true;
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await expect(adapter.cloneRepo(vm, "https://x.com/r.git", "/tmp/r")).rejects.toThrow(
      "git: not found",
    );
  });
});

// ---------------------------------------------------------------------------
// SSH key path in args — withKeyPath
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter withKeyPath", () => {
  it("includes key path in SSH args for exec-like SSH calls", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner, "/home/user/.ssh/id_ed25519");
    const vm = makeVm();
    // cloneRepo exercises the SSH runner with keyPath
    await adapter.cloneRepo(vm, "https://github.com/user/repo.git", "/tmp/repo");
    const args = runner.calls[0]!.args;
    expect(args).toContain("-i");
    expect(args).toContain("/home/user/.ssh/id_ed25519");
  });

  it("includes key path in SCP args for putFile", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner, "/custom/key");
    const vm = makeVm();
    await adapter.putFile(vm, "/local/file", "/remote/file");
    const args = runner.calls[0]!.args;
    expect(args).toContain("-i");
    expect(args).toContain("/custom/key");
  });

  it("includes key path in SCP args for getFile", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner, "/custom/key");
    const vm = makeVm();
    await adapter.getFile(vm, "/remote/file", "/local/file");
    const args = runner.calls[0]!.args;
    expect(args).toContain("-i");
    expect(args).toContain("/custom/key");
  });
});

// ---------------------------------------------------------------------------
// input via SSH — osascript delegation
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter input via SSH", () => {
  it("click runs osascript via SSH runner", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await adapter.input(vm, { kind: "click", x: 100, y: 200 });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.bin).toBe("ssh");
    const args = runner.calls[0]!.args;
    expect(args).toContain("osascript");
    expect(args.some((a) => a.includes("click at {100, 200}"))).toBe(true);
  });

  it("type runs osascript keystroke via SSH runner", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await adapter.input(vm, { kind: "type", text: "hello world" });
    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0]!.args;
    expect(args.some((a) => a.includes("keystroke"))).toBe(true);
    expect(args.some((a) => a.includes("hello world"))).toBe(true);
  });

  it("paste runs osascript with clipboard + keystroke v", async () => {
    const runner = makeMockSshRunner();
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await adapter.input(vm, { kind: "paste", text: "pasted text" });
    expect(runner.calls).toHaveLength(1);
    const args = runner.calls[0]!.args;
    expect(args.some((a) => a.includes("clipboard"))).toBe(true);
    expect(args.some((a) => a.includes("keystroke"))).toBe(true);
  });

  it("propagates SSH runner connection errors on input failure", async () => {
    const runner = makeMockSshRunner();
    runner.results.push({ exitCode: 255, stdout: "", stderr: "ssh: connect failed" });
    runner.throwOnNext = true;
    const { adapter } = await makeAdapterWithVm(runner);
    const vm = makeVm();
    await expect(adapter.input(vm, { kind: "click", x: 0, y: 0 })).rejects.toThrow(
      "ssh: connect failed",
    );
  });
});

// ---------------------------------------------------------------------------
// dispatch — verb routing through SSH
// ---------------------------------------------------------------------------

describe("MacosLocalAdapter dispatch", () => {
  it("dispatch exec routes to QMP exec", async () => {
    mockExecResult = { stdout: "dispatched output", stderr: "" };
    mockExecReject = false;
    const { adapter } = await makeAdapterWithVm();
    const vm = makeVm();
    const result = (await adapter.dispatch(vm, "exec", { cmd: "echo", args: ["dispatched"] })) as {
      exitCode: number;
      stdout: string;
    };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("dispatched output");
  });

  it("dispatch health returns status object", async () => {
    const { adapter } = await makeAdapterWithVm();
    const vm = makeVm();
    const result = (await adapter.dispatch(vm, "health", {})) as {
      screenshot: string;
      exec: string;
      transport: string;
    };
    expect(result.screenshot).toBe("ok");
    expect(result.exec).toBe("ok");
    expect(result.transport).toBe("ok");
  });

  it("dispatch unknown verb throws CAPABILITY_UNAVAILABLE", async () => {
    const { adapter } = await makeAdapterWithVm();
    const vm = makeVm();
    await expect(adapter.dispatch(vm, "unknown_verb", {})).rejects.toThrow("unknown dispatch verb");
  });
});
