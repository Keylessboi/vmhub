/**
 * transport.ts unit tests — the shared SSH-into-VM transport builder.
 * Pure logic: ssh user/jump resolution, argv construction, and the
 * MCP transport wiring. No live SSH or host needed.
 */
import { describe, expect, it } from 'vitest';
import { sshIntoVmArgs, sshJumpTarget, vmSshMcpTransport, vmSshUser } from './transport.ts';
import type { Vm } from '../src/shared/types.ts';

const vm: Vm = {
  uuid: 'u1',
  nodeId: 'dl360p',
  templateId: 'tpl',
  adapter: 'x11',
  capabilities: ['screenshot'],
  proxmoxTag: 'vmhub-x-u1',
  namePrefix: 'x',
  status: 'ready',
  ip: '10.10.10.50',
  createdAt: 0,
};

describe('vmSshUser / sshJumpTarget', () => {
  it('defaults to root and the Proxmox host', () => {
    expect(vmSshUser({})).toBe('root');
    expect(sshJumpTarget({})).toBe('root@192.168.1.220');
  });

  it('honors VMHUB_SSH_USER and VMHUB_JUMP_HOST overrides', () => {
    expect(vmSshUser({ VMHUB_SSH_USER: 'vmuser' })).toBe('vmuser');
    expect(sshJumpTarget({ VMHUB_JUMP_HOST: '10.0.0.5' })).toBe('root@10.0.0.5');
    expect(sshJumpTarget({ VMHUB_SSH_USER: 'ops', VMHUB_JUMP_HOST: '10.0.0.5' })).toBe('ops@10.0.0.5');
  });
});

describe('sshIntoVmArgs', () => {
  it('builds ssh argv for a VM', () => {
    const args = sshIntoVmArgs(vm, {});
    expect(args).toEqual([
      '-T',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ProxyJump=root@192.168.1.220',
      'root@10.10.10.50',
    ]);
  });

  it('uses the VM ip as the target host', () => {
    const args = sshIntoVmArgs({ ...vm, ip: '10.10.10.99' }, {});
    expect(args[args.length - 1]).toBe('root@10.10.10.99');
  });
});

describe('vmSshMcpTransport', () => {
  it('throws when the VM has no ip', () => {
    expect(() => vmSshMcpTransport({ ...vm, ip: undefined }, '/usr/local/bin/launch-x11-mcp', {})).toThrow(/no ip/);
  });

  it('throws PROVISION_FAILED when VM status is error', () => {
    expect(() => vmSshMcpTransport({ ...vm, status: 'error' }, '/usr/local/bin/launch-x11-mcp', {})).toThrow(/does not exist on Proxmox/);
  });

  it('throws PROVISION_FAILED when VM status is destroyed', () => {
    expect(() => vmSshMcpTransport({ ...vm, status: 'destroyed' }, '/usr/local/bin/launch-x11-mcp', {})).toThrow(/does not exist on Proxmox/);
  });

  it('constructs a stdio transport for a VM with an ip (no throw)', () => {
    const t = vmSshMcpTransport(vm, '/usr/local/bin/launch-x11-mcp', {});
    expect(t).toBeDefined();
  });

  it('constructs with an env prefix (no throw)', () => {
    const t = vmSshMcpTransport(vm, '/usr/local/bin/launch-x11-mcp', {}, { XDG_SESSION_TYPE: 'x11' });
    expect(t).toBeDefined();
  });
});

describe('vmSshMcpTransport error types', () => {
  it('throws typed VmError with INTERNAL code when VM has no ip', () => {
    try {
      vmSshMcpTransport({ ...vm, ip: undefined }, '/usr/local/bin/launch-x11-mcp', {});
      expect.unreachable();
    } catch (e) {
      expect(e).toHaveProperty('code', 'INTERNAL');
      expect(e).toHaveProperty('retryable');
    }
  });

  it('throws typed VmError with PROVISION_FAILED code when VM status is error', () => {
    try {
      vmSshMcpTransport({ ...vm, status: 'error' }, '/usr/local/bin/launch-x11-mcp', {});
      expect.unreachable();
    } catch (e) {
      expect(e).toHaveProperty('code', 'PROVISION_FAILED');
      expect(e).toHaveProperty('retryable');
    }
  });
});
