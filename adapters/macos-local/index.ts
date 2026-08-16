/**
 * Local macOS QEMU adapter — DesktopAdapter for single-tenant, local QEMU VMs.
 *
 * Unlike the Proxmox-backed macos adapter (which tunnels through SSH+MCP),
 * this adapter drives QEMU directly via the QMP monitor socket for screenshots
 * and process lifecycle, and uses SSH/SCP for exec and file operations.
 *
 * Transport:
 *   - Screenshot: QMP screendump (QemuProcess.screenshot())
 *   - Exec: QMP guest-exec via QemuProcess.exec()
 *   - Input: SSH + osascript in the guest
 *   - File ops: SCP over the forwarded SSH port (no ProxyJump)
 *   - Process lifecycle: start/stop via QemuProcess
 *
 * The adapter stores a per-VM QemuProcess keyed by Vm.uuid. The caller must
 * register a VM via startVm() before calling any DesktopAdapter method on it.
 */
import type {
  Capability,
  CapabilityId,
  DesktopAdapter,
  ExecResult,
  InputAction,
  SemanticElement,
  ScreenshotResult,
  TemplateConstraint,
  Vm,
  WindowInfo,
} from "../../src/shared/types.ts";
import { CAPABILITIES } from "../../src/shared/types.ts";
import { vmError } from "../../src/mcp/errors.ts";
import type { SshRunner } from "../transport.ts";
import { nodeSshRunner } from "../transport.ts";
import { QemuProcess } from "./transport.ts";
import type { QemuArgs, NetdevConfig } from "./types.ts";
import { localMacosSshArgs, localScpArgs } from "./ssh.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse PNG dimensions from the IHDR chunk (bytes 16-23). */
function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) return { width: 0, height: 0 };
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

/** Extract the host-forwarded SSH port from QEMU netdev options. */
function extractSshPort(netdev: NetdevConfig): number {
  const match = netdev.options.match(/hostfwd=tcp::(\d+)-:22/);
  const port = match?.[1];
  return port !== undefined ? parseInt(port, 10) : 22;
}

// ---------------------------------------------------------------------------
// Internal state per registered VM
// ---------------------------------------------------------------------------

interface VmEntry {
  proc: QemuProcess;
  args: QemuArgs;
  sshHost: string;
  sshPort: number;
  keyPath: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface MacosLocalAdapterOptions {
  /** Injectable SSH runner (default: nodeSshRunner via execFile). */
  ssh?: SshRunner;
  /** SSH host to connect to (default: "127.0.0.1"). */
  sshHost?: string;
  /** Path to the SSH private key for guest access. */
  keyPath?: string;
}

export class MacosLocalAdapter implements DesktopAdapter {
  readonly id = "macos-local";

  readonly capability: Capability = {
    adapter: "macos-local",
    os: "macos",
    windowing: ["macos"],
    input: ["click", "type", "key", "paste", "drag"],
    semantic: "none",
    files: ["scp"],
    exec: true,
    notes: "Local QEMU macOS VM — QMP screenshot/exec, SSH file ops.",
  };

  readonly templateConstraints: TemplateConstraint[] = [
    { cpu: { avx2: true }, nestedVirt: false },
  ];

  private readonly ssh: SshRunner;
  private readonly defaultSshHost: string;
  private readonly defaultKeyPath: string;
  private readonly entries = new Map<string, VmEntry>();

  constructor(opts: MacosLocalAdapterOptions = {}) {
    this.ssh = opts.ssh ?? nodeSshRunner;
    this.defaultSshHost = opts.sshHost ?? "127.0.0.1";
    this.defaultKeyPath = opts.keyPath ?? "";
  }

  // -----------------------------------------------------------------------
  // Lifecycle (local-only — not part of DesktopAdapter)
  // -----------------------------------------------------------------------

  /** Register and start a QEMU process for the given VM id. */
  async startVm(vmId: string, args: QemuArgs): Promise<void> {
    const proc = new QemuProcess(args);
    await proc.start();
    const sshPort = extractSshPort(args.netdev);
    this.entries.set(vmId, {
      proc,
      args,
      sshHost: this.defaultSshHost,
      sshPort,
      keyPath: this.defaultKeyPath,
    });
  }

  /** Stop the QEMU process and remove it from the registry. */
  async stopVm(vmId: string): Promise<void> {
    const entry = this.entries.get(vmId);
    if (!entry) return;
    await entry.proc.stop();
    this.entries.delete(vmId);
  }

  // -----------------------------------------------------------------------
  // DesktopAdapter — capability declaration
  // -----------------------------------------------------------------------

  availableTools(): CapabilityId[] {
    return [
      CAPABILITIES.screenshot,
      CAPABILITIES.inspect,
      CAPABILITIES.listWindows,
      CAPABILITIES.click,
      CAPABILITIES.type,
      CAPABILITIES.key,
      CAPABILITIES.paste,
      CAPABILITIES.drag,
      CAPABILITIES.exec,
      CAPABILITIES.putFile,
      CAPABILITIES.getFile,
      CAPABILITIES.cloneRepo,
      CAPABILITIES.dispatch,
    ];
  }

  // -----------------------------------------------------------------------
  // DesktopAdapter — visual
  // -----------------------------------------------------------------------

  async screenshot(vm: Vm): Promise<ScreenshotResult> {
    const entry = this.getEntry(vm);
    const buf = await entry.proc.screenshot();
    const { width, height } = pngDimensions(buf);
    return {
      image: buf,
      format: "png",
      width,
      height,
      coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    };
  }

  async inspect(_vm: Vm): Promise<SemanticElement> {
    // Local QEMU has no AX/UIA accessibility tree from the host side.
    // Return a minimal root element with the VM status.
    return {
      role: "VM",
      name: "local-qemu",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      children: [],
    };
  }

  async listWindows(_vm: Vm): Promise<WindowInfo[]> {
    // Without an in-VM MCP or AX bridge, window listing is unavailable.
    return [];
  }

  // -----------------------------------------------------------------------
  // DesktopAdapter — input (SSH + osascript in the guest)
  // -----------------------------------------------------------------------

  async input(vm: Vm, action: InputAction): Promise<void> {
    const entry = this.getEntry(vm);
    const sshArgs = this.sshArgs(entry);

    switch (action.kind) {
      case "click": {
        const script = `tell application "System Events" to click at {${action.x}, ${action.y}}`;
        await this.runSsh(entry, ["osascript", "-e", script]);
        return;
      }
      case "type": {
        const escaped = action.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `tell application "System Events" to keystroke "${escaped}"`;
        await this.runSsh(entry, ["osascript", "-e", script]);
        return;
      }
      case "key": {
        const script = `tell application "System Events" to key code ${action.chord}`;
        await this.runSsh(entry, ["osascript", "-e", script]);
        return;
      }
      case "paste": {
        const escaped = action.text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const script = `set the clipboard to "${escaped}"
tell application "System Events" to keystroke "v" using command down`;
        await this.runSsh(entry, ["osascript", "-e", script]);
        return;
      }
      case "drag": {
        const script = `tell application "System Events"
  set startPt to {${action.from.x}, ${action.from.y}}
  set endPt to {${action.to.x}, ${action.to.y}}
end tell`;
        await this.runSsh(entry, ["osascript", "-e", script]);
        return;
      }
      case "gesture":
        throw vmError(
          "CAPABILITY_UNAVAILABLE",
          "macos-local adapter: gestures are not supported",
        );
    }
  }

  // -----------------------------------------------------------------------
  // DesktopAdapter — exec (QMP guest-exec via QemuProcess)
  // -----------------------------------------------------------------------

  async exec(vm: Vm, cmd: string, args: string[] = []): Promise<ExecResult> {
    const entry = this.getEntry(vm);
    const fullCmd = [cmd, ...args].join(" ");
    try {
      const stdout = await entry.proc.exec(fullCmd);
      return { exitCode: 0, stdout, stderr: "" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { exitCode: 1, stdout: "", stderr: msg };
    }
  }

  // -----------------------------------------------------------------------
  // DesktopAdapter — file transfer (SCP over forwarded SSH port)
  // -----------------------------------------------------------------------

  async putFile(
    vm: Vm,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    const entry = this.getEntry(vm);
    const args = localScpArgs(
      entry.sshHost,
      entry.sshPort,
      entry.keyPath,
      localPath,
      remotePath,
      "put",
    );
    await this.ssh.run("scp", args);
  }

  async getFile(
    vm: Vm,
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    const entry = this.getEntry(vm);
    const args = localScpArgs(
      entry.sshHost,
      entry.sshPort,
      entry.keyPath,
      localPath,
      remotePath,
      "get",
    );
    await this.ssh.run("scp", args);
  }

  async cloneRepo(
    vm: Vm,
    repoUrl: string,
    destPath: string,
  ): Promise<void> {
    const entry = this.getEntry(vm);
    const sshBase = localMacosSshArgs(
      entry.sshHost,
      entry.sshPort,
      entry.keyPath,
    );
    await this.ssh.run("ssh", [...sshBase, "git", "clone", "--", repoUrl, destPath]);
  }

  // -----------------------------------------------------------------------
  // DesktopAdapter — dispatch
  // -----------------------------------------------------------------------

  async dispatch(
    vm: Vm,
    verb: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const entry = this.getEntry(vm);
    switch (verb) {
      case "exec":
        return this.exec(vm, String(args.cmd ?? ""), Array.isArray(args.args) ? args.args.map(String) : []);
      case "screenshot":
        return this.screenshot(vm);
      case "health": {
        const status = await entry.proc.status();
        return {
          screenshot: status.running ? "ok" : "degraded",
          exec: status.running ? "ok" : "degraded",
          transport: status.running ? "ok" : "degraded",
        };
      }
      default:
        throw vmError(
          "CAPABILITY_UNAVAILABLE",
          `macos-local adapter: unknown dispatch verb "${verb}"`,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private getEntry(vm: Vm): VmEntry {
    const entry = this.entries.get(vm.uuid);
    if (!entry) {
      throw vmError("INTERNAL", `macos-local adapter: VM ${vm.uuid} not running`);
    }
    return entry;
  }

  private sshArgs(entry: VmEntry): string[] {
    return localMacosSshArgs(entry.sshHost, entry.sshPort, entry.keyPath);
  }

  /** Run a command in the guest via SSH. */
  private async runSsh(
    entry: VmEntry,
    remoteArgs: string[],
  ): Promise<string> {
    const sshBase = this.sshArgs(entry);
    const result = await this.ssh.run("ssh", [...sshBase, ...remoteArgs]);
    if (typeof result.stdout === "string") return result.stdout;
    return result.stdout.toString("utf8");
  }
}
