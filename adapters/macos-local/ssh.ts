/**
 * Local macOS QEMU guest SSH channel — argv construction for exec/scp/git.
 *
 * Unlike the Proxmox-backed macos adapter (which uses ProxyJump through the
 * Proxmox host), local QEMU VMs are reached directly on the forwarded port.
 * The QEMU user-mode network forwards host:<port> → guest:22 via the
 * netdev hostfwd option.
 *
 * All functions are argv-only — never shell strings — so they are
 * mock-testable without a live guest.
 */

/**
 * SSH argv for the local macOS QEMU guest.
 * No ProxyJump — direct connection to localhost:<port>.
 */
export function localMacosSshArgs(
  host: string,
  port: number,
  keyPath: string,
): string[] {
  return [
    "-T",
    "-p", String(port),
    "-i", keyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    `admin@${host}`,
  ];
}

/**
 * SCP argv for file transfer into/out of the local macOS QEMU guest.
 * `direction` "put" = host→guest, "get" = guest→host.
 */
export function localScpArgs(
  host: string,
  port: number,
  keyPath: string,
  localPath: string,
  remotePath: string,
  direction: "put" | "get",
): string[] {
  const opts = [
    "-P", String(port),
    "-i", keyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
  ];
  const target = `admin@${host}:${remotePath}`;
  return direction === "put"
    ? [...opts, localPath, target]
    : [...opts, target, localPath];
}
