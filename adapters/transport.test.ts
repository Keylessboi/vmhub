/**
 * transport.ts unit tests — the shared SSH-into-VM transport builder.
 * Pure logic: ssh user/jump resolution, argv construction, and the
 * MCP transport wiring. No live SSH or host needed.
 */
import { describe, expect, it } from 'vitest';
import { jumpHostOpts, scpRemote, scpVmArgs, sshHostArgs, sshIntoVmArgs, sshJumpTarget, vmSshMcpTransport, vmSshUser, vmTunnel } from './transport.ts';
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
  it('hops through the jump host with a ProxyCommand and never records guest host keys', () => {
    const args = sshIntoVmArgs(vm, { VMHUB_SSH_MULTIPLEX: '0' });
    expect(args[0]).toBe('-T');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('UserKnownHostsFile=/dev/null');
    const proxy = args.find((a) => a.startsWith('ProxyCommand='));
    expect(proxy).toMatch(/^ProxyCommand=ssh .* -W %h:%p root@192\.168\.1\.220$/);
    expect(args[args.length - 1]).toBe('root@10.10.10.50');
  });

  it('uses the VM ip as the target host', () => {
    const args = sshIntoVmArgs({ ...vm, ip: '10.10.10.99' }, {});
    expect(args[args.length - 1]).toBe('root@10.10.10.99');
  });

  it('applies VMHUB_SSH_KEY to both hops', () => {
    const args = sshIntoVmArgs(vm, { VMHUB_SSH_KEY: '/k/worker_key' });
    expect(args.slice(0, args.indexOf('-i') + 2)).toContain('/k/worker_key');
    expect(args.find((a) => a.startsWith('ProxyCommand='))).toContain('-i /k/worker_key');
  });

  it('applies VMHUB_SSH_CONFIG to every hop', () => {
    const args = sshIntoVmArgs(vm, { VMHUB_SSH_CONFIG: '/c/ssh_config', VMHUB_JUMP_HOST: 'vmhub' });
    expect(args.slice(1, 3)).toEqual(['-F', '/c/ssh_config']);
    expect(args.find((a) => a.startsWith('ProxyCommand='))).toMatch(/^ProxyCommand=ssh -F \/c\/ssh_config .* root@vmhub$/);
  });

  it('escapes the jump hop %-tokens inside the ProxyCommand', () => {
    const proxy = sshIntoVmArgs(vm, { VMHUB_SSH_CONTROL_DIR: '/c' }).find((a) => a.startsWith('ProxyCommand='))!;
    expect(proxy).toContain('ControlPath=/c/vmhub-%%C');
    expect(proxy).toContain('-W %h:%p');
  });

  it('multiplexes the jump hop unless disabled', () => {
    expect(sshHostArgs({}).join(' ')).toContain('ControlMaster=auto');
    expect(sshHostArgs({ VMHUB_SSH_MULTIPLEX: '0' }).join(' ')).not.toContain('ControlMaster');
  });

  it('accepts an ssh alias or user@host jump target', () => {
    expect(sshJumpTarget({ VMHUB_JUMP_HOST: 'ops@vmhub-1' })).toBe('ops@vmhub-1');
    expect(sshJumpTarget({ VMHUB_JUMP_HOST: 'vmhub-1', VMHUB_JUMP_USER: 'admin', VMHUB_SSH_USER: 'vmuser' })).toBe('admin@vmhub-1');
  });
});

describe('scp helpers', () => {
  it('builds a user@ip:path remote and refuses VMs without an ip', () => {
    expect(scpRemote(vm, '/tmp/x', {})).toBe('root@10.10.10.50:/tmp/x');
    expect(() => scpRemote({ ...vm, ip: undefined }, '/tmp/x', {})).toThrow(/no ip/);
    expect(scpVmArgs({})).toContain('-r');
  });
});

describe('vmTunnel', () => {
  it('does not multiplex the forward (a multiplexed -L exits immediately)', () => {
    expect(jumpHostOpts({}, false).join(' ')).not.toContain('ControlMaster');
    expect(jumpHostOpts({}, true).join(' ')).toContain('ControlMaster=auto');
  });

  it('returns the guest address directly when the guest network is routable', async () => {
    await expect(vmTunnel(vm, 8000, { VMHUB_DIRECT_GUEST_NET: '1' })).resolves.toEqual({ host: '10.10.10.50', port: 8000 });
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
