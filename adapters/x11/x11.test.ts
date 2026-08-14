/**
 * X11Adapter unit tests — pure logic only (no live computer-use-linux server):
 * capability declaration, availableTools, and shared transport helpers.
 * Live-server behavior is exercised e2e against the golden, not here.
 */
import { describe, expect, it } from 'vitest';
import { IN_VM_LAUNCHER, x11Adapter } from '../x11/index.ts';
import { sshJumpTarget, vmSshUser } from '../transport.ts';

describe('X11Adapter capability declaration', () => {
  it('declares the x11 adapter id and os', () => {
    expect(x11Adapter.id).toBe('x11');
    expect(x11Adapter.capability.os).toBe('x11');
    expect(x11Adapter.capability.windowing).toEqual(['x11']);
  });

  it('declares input + no exec (computer-use-linux has no exec tool)', () => {
    expect(x11Adapter.capability.input).toEqual(['click', 'type', 'key', 'drag']);
    expect(x11Adapter.capability.exec).toBe(false);
    expect(x11Adapter.capability.files).toEqual([]);
  });

  it('notes the transport in the capability', () => {
    expect(x11Adapter.capability.notes).toContain('computer-use-linux');
  });
});

describe('X11Adapter availableTools', () => {
  it('serves the desktop tool surface it can drive', () => {
    const tools = x11Adapter.availableTools();
    for (const t of ['screenshot', 'inspect', 'list_windows', 'click', 'type', 'key', 'drag', 'focus', 'dispatch']) {
      expect(tools).toContain(t);
    }
  });

  it('does not advertise exec, paste, launch or close (not on the surface)', () => {
    const tools = x11Adapter.availableTools();
    for (const t of ['exec', 'paste', 'launch', 'close']) {
      expect(tools).not.toContain(t);
    }
  });
});

describe('X11 transport helpers', () => {
  it('uses the in-VM launcher path from the golden', () => {
    expect(IN_VM_LAUNCHER).toBe('/usr/local/bin/launch-x11-mcp');
  });

  it('defaults SSH user to root and jump to the Proxmox host', () => {
    expect(vmSshUser({})).toBe('root');
    expect(sshJumpTarget({})).toBe('root@192.168.1.220');
  });

  it('honors VMHUB_JUMP_HOST override', () => {
    expect(sshJumpTarget({ VMHUB_JUMP_HOST: '10.0.0.5' })).toBe('root@10.0.0.5');
  });

  it('honors VMHUB_SSH_USER override', () => {
    expect(vmSshUser({ VMHUB_SSH_USER: 'vmuser' })).toBe('vmuser');
    expect(sshJumpTarget({ VMHUB_SSH_USER: 'vmuser' })).toBe('vmuser@192.168.1.220');
  });
});
