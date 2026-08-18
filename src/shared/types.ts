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
  | "android"
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

// ---------------------------------------------------------------------------
// Nodes (multi-node)
// ---------------------------------------------------------------------------

/** Liveness/health state of a Proxmox node as observed by the control plane. */
export type NodeStatus = "online" | "offline" | "stuck" | "unknown";

/**
 * A Proxmox node in the fleet registry. Static shape (id, metadata) comes from
 * config; live fields (status, diskFreePct, goldens) are PROBE results from the
 * shared probe loop, never config. A node is a host that satisfies template
 * constraints — templates route to nodes, agents never pin.
 */
export interface VmNode {
  /** Stable node id used in Vm.nodeId / registry lookups. */
  id: string;
  /** Human-readable name (informational only). */
  name?: string;
  /** API base URL, resolved at sweep/request time (IPs change). */
  baseUrl?: string;
  /** Observed state — "online"/"offline" are probes; "stuck" = repeated auth failure. */
  status: NodeStatus;
  metadata: {
    /** OS families this node can host (adapter os values). */
    os: WindowingSystem[];
    /** True when the host CPU exposes AVX2 (macOS Ventura+ requirement). */
    avx2: boolean;
    /** Whether the host supports nested virtualization. */
    nestedVirt: boolean;
    /** Total RAM MB (static config hint). */
    ramMb: number;
    /** Free disk percent — PROBED, never config. */
    diskFreePct?: number;
    /** Golden ids staged on this node's storage — PROBED via storage listing. */
    goldens?: string[];
  };
}

/** Template→node affinity constraints. Evaluated against node metadata at query time. */
export interface TemplateConstraint {
  /** Required host OS family. MAY differ from Template.os. */
  os?: WindowingSystem;
  cpu?: { avx2?: boolean };
  nestedVirt?: boolean;
  /** Minimum free RAM the node must have (live-probed headroom). */
  minRamMb?: number;
  /** Minimum free disk percent (live-probed). */
  minDiskFreePct?: number;
  /** Version-paired runtime required on the node. */
  runtime?: string;
}

/**
 * Static node registration — config, never probed state. The control plane
 * resolves one Proxmox client per node from this. Live fields (status,
 * diskFreePct, goldens) live on VmNode and come from the shared probe loop.
 */
export interface NodeConfig {
  /** Stable node id — must match VmNode.id and Vm.nodeId. */
  id: string;
  /** API base URL (host[:port]); resolved at request time, never cached. */
  baseUrl: string;
  /** Env var name holding this node's scoped automation token. */
  tokenEnv: string;
  /** Static host metadata for constraint evaluation. */
  metadata: {
    /** OS families this node can host. */
    os: WindowingSystem[];
    avx2: boolean;
    nestedVirt: boolean;
    /** Total RAM MB. */
    ramMb: number;
  };
}

export interface Vm {
  /** vmhub-owned uuid. The ONLY stable identity; VMIDs are never trusted. */
  uuid: string;
  /** The node this VM lives on. Sticky — never changes after creation. */
  nodeId: string;
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
  | "NODE_UNAVAILABLE"
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
  /** Template→node affinity constraints. Absent = any capable node. */
  constraints?: TemplateConstraint[];
  /** Parent template id for derived templates. */
  derivedFrom?: string;
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
export type PasteAction = { kind: "paste"; text: string };
export type GestureAction = { kind: "gesture"; type: "swipe" | "tap" | "longPress" | "pinch"; x: number; y: number; dx?: number; dy?: number };

export type InputAction = ClickAction | TypeAction | KeyAction | DragAction | PasteAction | GestureAction;

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
