/**
 * QEMU transport types for local macOS VMs.
 *
 * These types describe the QEMU process configuration and runtime status
 * for single-tenant, local QEMU VMs (no Proxmox, no reaper, no leases).
 */

/** Disk drive configuration passed to QEMU -drive flag. */
export interface DriveConfig {
  /** Path to the disk image file (e.g. "golden.qcow2"). */
  file: string;
  /** Disk format (e.g. "qcow2"). */
  format: string;
  /** Interface type (e.g. "virtio", "ide"). */
  if: string;
}

/** Network device configuration — netdev + device pair. */
export interface NetdevConfig {
  /** Netdev id (e.g. "net0"). */
  id: string;
  /** Netdev options after the type+id (e.g. "hostfwd=tcp::2222-:22").
   *  The full -netdev line becomes: `user,id=<id>,<options>`. */
  options: string;
  /** Device model (e.g. "virtio-net-pci"). */
  device: string;
}

/** Serial port configuration. */
export interface SerialConfig {
  /** Serial target type: "file" for log file, "stdio" for console I/O. */
  type: 'file' | 'stdio';
  /** Path when type is "file" (e.g. "serial.log"). Ignored for "stdio". */
  path?: string;
}

/** Full QEMU process configuration. */
export interface QemuArgs {
  /** Absolute path to the qemu-system binary (e.g. "/usr/bin/qemu-system-x86_64"). */
  qemuPath: string;
  /** Memory allocation (e.g. "8192" for 8 GB, "4G"). */
  memory: string;
  /** CPU model (e.g. "Skylake-Client,-hle,-rtm"). */
  cpu: string;
  /** Disk drives to attach. */
  drives: DriveConfig[];
  /** Network device configuration. */
  netdev: NetdevConfig;
  /** Serial port configuration. */
  serial: SerialConfig;
  /** Monitor socket path (unix socket for QMP/monitor commands). */
  monitor: string;
  /** Display backend (e.g. "none" for headless, "cocoa" for macOS host GUI). */
  display: string;
}

/** Runtime status of a QEMU process. */
export interface QemuStatus {
  /** Whether the process is currently running. */
  running: boolean;
  /** OS process ID (0 if not started). */
  pid: number;
  /** Accumulated serial console output (from serial log file or in-memory buffer). */
  serialLog: string;
}

/** Spawn function signature — injectable for testing. */
export type SpawnFn = (
  command: string,
  args: string[],
  options?: Record<string, unknown>,
) => { pid?: number; kill: (signal?: string | number) => boolean; on: (event: string, cb: (...args: unknown[]) => void) => void };

/** ReadFile function signature — injectable for testing. Returns string for text, Buffer for binary. */
export type ReadFileFn = (path: string, encoding: BufferEncoding) => Promise<string | Buffer>;
