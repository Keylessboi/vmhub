/**
 * vmhub shared types — THE single machine-readable contract.
 *
 * All three artifacts (vmhub-mcp, vmhub-lite, vmhub-reaper) import from here.
 * The capability matrix defined in this file is the one source of truth for
 * what an agent can do with a VM. Nothing outside `src/shared` may define a
 * capability, error code, or lease shape.
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Windowing system families a VM may expose. */
export type WindowingSystem =
  | "hyprland"
  | "x11"
  | "windows"
  | "macos"
  | "android"
  | "ios"
  | "headless"
  | "none";

/** Input modalities an adapter can inject. */
export type InputCapability =
  | "click"
  | "type"
  | "key"
  | "paste"
  | "drag"
  | "gesture"
  | "touch";

/** Semantic inspection an adapter can offer (text-only-model path). */
export type SemanticCapability =
  | "uia"
  | "ax"
  | "uiautomator"
  | "wayland"
  | "none";

/** File transport an adapter can use. */
export type FileCapability = "scp" | "sftp" | "adb" | "docker-cp" | "none";

/** The full capability declaration for one adapter. */
export interface Capability {
  /** Stable adapter id. New OS = new adapter id + capability entry. */
  adapter: string;
  /** The OS family this adapter drives. */
  os: WindowingSystem;
  /** Which windowing systems it can control. Empty for devices/headless. */
  windowing: WindowingSystem[];
  /** Input modalities. Empty = read-only adapter. */
  input: InputCapability[];
  /** Semantic element-tree inspection. */
  semantic: SemanticCapability;
  /** File transfer transports. */
  files: FileCapability[];
  /** Whether the adapter can run arbitrary commands in the VM. */
  exec: boolean;
  /** Human-readable notes; not part of the machine contract. */
  notes?: string;
}

/** Static registry of known capability ids. */
export const CAPABILITIES = {
  screenshot: "screenshot",
  inspect: "inspect",
  listWindows: "list_windows",
  click: "click",
  type: "type",
  key: "key",
  paste: "paste",
  drag: "drag",
  gesture: "gesture",
  touch: "touch",
  launch: "launch",
  focus: "focus",
  close: "close",
  dispatch: "dispatch",
  putFile: "put_file",
  getFile: "get_file",
  cloneRepo: "clone_repo",
  exec: "exec",
} as const;

export type CapabilityId = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

// ---------------------------------------------------------------------------
// VMs and leases
// ---------------------------------------------------------------------------

export type VmStatus =
  | "provisioning"
  | "starting"
  | "ready"
  | "busy"
  | "draining"
  | "error"
  | "destroyed";

export interface Vm {
  /** vmhub-owned uuid. The ONLY stable identity; VMIDs are never trusted. */
  uuid: string;
  /** Template this VM was cloned from. */
  templateId: string;
  /** Adapter id driving this VM. */
  adapter: string;
  /** Capabilities available on this VM, from its template + adapter. */
  capabilities: CapabilityId[];
  /** Proxmox attributes used for identity-verified teardown. */
  proxmoxTag: string; // vmhub-<prefix>-<uuid>
  namePrefix: string;
  status: VmStatus;
  /** NAT host port for ssh/agent access. */
  sshPort?: number;
  /** Static NAT IP on the VM network (vmbr1, 10.10.10.x) — the transport address. */
  ip?: string;
  /** Host-side lease-scratch dir for artifacts. */
  scratchDir?: string;
  createdAt: number;
}

export interface Lease {
  /** Same uuid as the VM it grants. */
  vmId: string;
  /** Owner — the agent/session that created the lease. */
  owner: string;
  /** Idempotency key; retries with the same request_id return the same lease. */
  requestId: string;
  /** Unix ms. Hard-destroy deadline enforced by the reaper. */
  expiresAt: number;
  /** Soft deadline; renew endpoint pushes this forward. */
  lastRenewedAt: number;
  /** Count of renewals (audit). */
  renewCount: number;
  /** Max lifetime cap in ms (24h default). */
  maxLifetimeMs: number;
}

export interface ReadinessReport {
  vmId: string;
  stages: {
    guestAgent: boolean;
    cloudInit: boolean;
    /** Only for adapters that expose a display. */
    display?: boolean;
    tools: boolean;
  };
  ready: boolean;
  /** Unix ms when the wait started; bounded waits use this. */
  startedAt: number;
  /** True when the readiness wait hit its bound without success. */
  timedOut: boolean;
}

// ---------------------------------------------------------------------------
// Errors — the typed contract agents branch on
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "CAPABILITY_UNAVAILABLE"
  | "QUOTA_EXCEEDED"
  | "HOST_CAPACITY"
  | "DISK_FULL"
  | "BOOT_TIMEOUT"
  | "LOCK_CONTENTION"
  | "PROVISION_FAILED"
  | "LEASE_EXPIRED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "INVALID_REQUEST"
  | "INTERNAL";

export interface VmError {
  code: ErrorCode;
  message: string;
  /** True when the agent should retry (with backoff or after teardown). */
  retryable: boolean;
  /** Action hint: teardown-then-retry | wait-then-retry | one-retry-then-report | retry-with-backoff. */
  hint: "teardown-then-retry" | "wait-then-retry" | "one-retry-then-report" | "retry-with-backoff" | "no-retry";
  detail?: string;
}

// ---------------------------------------------------------------------------
// Template catalog — capability query BEFORE vm creation
// ---------------------------------------------------------------------------

export interface Template {
  id: string;
  os: WindowingSystem;
  /** availability: "available" | "unavailable" | "stub" */
  availability: "available" | "unavailable" | "stub";
  /** Why unavailable/stub — NEVER hidden from agents. */
  reason?: string;
  /** Capabilities a VM cloned from this template will have. */
  capabilities: CapabilityId[];
  /** Resource budget hints (RAM MB / vCPU) for host sizing. */
  ramMb: number;
  vcpus: number;
  /** Whether template creation requires nested virt. */
  nestedVirt: boolean;
  /** Human-readable notes. */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Artifacts (file transfer)
// ---------------------------------------------------------------------------

export interface ArtifactRecord {
  id: string;
  leaseId: string;
  /** Relative path inside the lease scratch dir on the host. */
  hostPath: string;
  sizeBytes: number;
  /** Whether the reaper may delete it (false while in-flight vm_get_file). */
  inFlight: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Adapter contract — implemented by every per-OS adapter module
// ---------------------------------------------------------------------------

export interface ScreenshotResult {
  /** Absolute-path PNG/JPEG bytes. */
  image: Buffer;
  /** Extension of the image ("png" | "jpg"). */
  format: "png" | "jpg";
  /** Width in pixels (image native). */
  width: number;
  height: number;
  /** For phones/tablets: orientation of the frame. */
  orientation?: "portrait" | "landscape";
  /**
   * Coordinate mapping: logical screen coordinates to image pixels.
   * For most adapters this is identity (pixels == coords). Kept as a field
   * so adapters that scale (e.g. Windows screenshot scale 0.5) can map back.
   */
  coordMapping: { scaleX: number; scaleY: number; offsetX: number; offsetY: number };
}

export type ClickAction = { kind: "click"; x: number; y: number; button?: "left" | "right" | "middle" };
export type TypeAction = { kind: "type"; text: string };
export type KeyAction = { kind: "key"; chord: string };
export type DragAction = { kind: "drag"; from: { x: number; y: number }; to: { x: number; y: number } };
export type GestureAction = { kind: "gesture"; type: "swipe" | "tap" | "longPress" | "pinch"; x: number; y: number; dx?: number; dy?: number };

export type InputAction = ClickAction | TypeAction | KeyAction | DragAction | GestureAction;

export interface WindowInfo {
  id: string;
  title: string;
  className?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Whether the window is focused. */
  focused: boolean;
  /** Whether the window is on an active/visible workspace. */
  visible: boolean;
}

export interface SemanticElement {
  role: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children: SemanticElement[];
  properties?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A DesktopAdapter drives one OS family inside a VM. Implementations live in
 * `adapters/`. The adapter is the ONLY component that knows its transport.
 */
export interface DesktopAdapter {
  id: string;
  capability: Capability;
  /**
   * List tools this adapter can serve. Returned at attach time; vmhub-mcp
   * gates tool registration on this.
   */
  availableTools(): CapabilityId[];
  screenshot(vm: Vm): Promise<ScreenshotResult>;
  input(vm: Vm, action: InputAction): Promise<void>;
  listWindows(vm: Vm): Promise<WindowInfo[]>;
  inspect(vm: Vm): Promise<SemanticElement>;
  exec(vm: Vm, cmd: string, args?: string[]): Promise<ExecResult>;
  /** File transfer. One or more may be unsupported per adapter. */
  putFile?(vm: Vm, localPath: string, remotePath: string): Promise<void>;
  getFile?(vm: Vm, remotePath: string, localPath: string): Promise<void>;
  cloneRepo?(vm: Vm, repoUrl: string, destPath: string): Promise<void>;
  /** Validated escape hatch — generalized hyprland dispatch. */
  dispatch?(vm: Vm, verb: string, args: Record<string, unknown>): Promise<unknown>;
}
