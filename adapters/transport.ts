/**
 * Shared SSH-into-VM transport for the VM-backed desktop adapters.
 *
 * Both the hyprland adapter (launch-hypr-mcp) and the x11 adapter
 * (launch-x11-mcp) drive a per-VM MCP server that lives inside the VM:
 *
 *   ssh -T -o StrictHostKeyChecking=no \
 *       -o ProxyJump=<jump> root@<vm.ip> <in-vm-launcher>
 *
 * The Proxmox host key and the VM root key are installed at golden build;
 * `-T` keeps stdio clean for MCP. Env-gated so operators can point at other
 * hosts/users without recompiling: VMHUB_JUMP_HOST (default 192.168.1.220),
 * VMHUB_SSH_USER (default root).
 *
 * Adapters keep their own IN_VM_LAUNCHER constant (the launcher path differs
 * per golden); everything else about the transport is shared.
 */
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Vm } from '../src/shared/types.ts';

/** SSH user for VM transport (root by default; cloud-init injects the key). */
export function vmSshUser(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_SSH_USER ?? 'root';
}

/** ProxyJump target through the Proxmox host: "root@192.168.1.220" by default. */
export function sshJumpTarget(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.VMHUB_JUMP_HOST ?? '192.168.1.220';
  return `${vmSshUser(env)}@${host}`;
}

/** ssh argv for one VM: `-T -o StrictHostKeyChecking=no -o ProxyJump=… root@<ip>`. */
export function sshIntoVmArgs(vm: Vm, env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    '-T',
    '-o', 'StrictHostKeyChecking=no',
    '-o', `ProxyJump=${sshJumpTarget(env)}`,
    `${vmSshUser(env)}@${vm.ip ?? ''}`,
  ];
}

/**
 * Per-VM MCP stdio transport: SSH through the Proxmox host into the VM and
 * run the in-VM MCP launcher there. Requires vm.ip (the static NAT address
 * lite assigns at clone time) — there is no local-desktop fallback for
 * VM-backed adapters.
 *
 * `env` prefixes the launcher with KEY=value assignments on the remote
 * command line. Some golden launchers omit session variables (e.g. the x11
 * launcher leaves XDG_SESSION_TYPE unset, which disables the X11/EWMH window
 * backend); the adapter can restore them without touching the golden.
 */
export function vmSshMcpTransport(
  vm: Vm,
  launcher: string,
  env: NodeJS.ProcessEnv = process.env,
  envPrefix: Record<string, string> = {},
): StdioClientTransport {
  if (!vm.ip) {
    throw new Error(`vmhub transport: VM ${vm.uuid} has no ip — the static NAT address is unset`);
  }
  const prefix = Object.entries(envPrefix)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const remoteCommand = prefix ? `${prefix} ${launcher}` : launcher;
  return new StdioClientTransport({
    command: 'ssh',
    args: [...sshIntoVmArgs(vm, env), remoteCommand],
  });
}
