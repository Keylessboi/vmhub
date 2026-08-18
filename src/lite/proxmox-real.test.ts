/**
 * proxmox-real.ts helper tests — pure logic that needs no live Proxmox:
 * osFromTemplateName (golden name → adapter OS family mapping) and the
 * registry-driven per-node static-NAT allocator.
 */
import { describe, expect, it } from 'vitest';
import { osFromTemplateName, NodeIpPool, poolForNode } from './proxmox-real.ts';
import { isVmError } from '../mcp/errors.ts';

describe('osFromTemplateName', () => {
  it('maps golden names to their OS family', () => {
    expect(osFromTemplateName('hyprland-2404')).toBe('hyprland');
    expect(osFromTemplateName('x11-2404')).toBe('x11');
    expect(osFromTemplateName('ubuntu-x11')).toBe('x11');
    expect(osFromTemplateName('windows-11-24h2')).toBe('windows');
    expect(osFromTemplateName('win11-builder')).toBe('windows');
    expect(osFromTemplateName('android-9-golden')).toBe('android');
    expect(osFromTemplateName('debian-13-golden')).toBe('headless');
  });

  it('is case-insensitive', () => {
    expect(osFromTemplateName('Hyprland-2404')).toBe('hyprland');
    expect(osFromTemplateName('WINDOWS-11')).toBe('windows');
  });

  it('falls back to headless for unknown names', () => {
    expect(osFromTemplateName('unknown-box')).toBe('headless');
    expect(osFromTemplateName(undefined)).toBe('headless');
    expect(osFromTemplateName('')).toBe('headless');
  });
});

describe('NodeIpPool allocator', () => {
  const poolConfig = (nodeId: string, start: number, end: number) => ({
    nodeId,
    subnet: '10.10.10.0/24',
    gateway: '10.10.10.1',
    start,
    end,
  });

  it('allocates from the configured range, per node', () => {
    const pool = new NodeIpPool(poolConfig('alloc-a', 50, 52));
    expect(pool.allocate()).toBe('10.10.10.50');
    expect(pool.allocate()).toBe('10.10.10.51');
    expect(pool.allocate()).toBe('10.10.10.52');
  });

  it('two nodes both start at the first pool address without colliding', () => {
    const a = poolForNode(poolConfig('alloc-a', 50, 52));
    const b = poolForNode(poolConfig('alloc-b', 50, 52));
    expect(a.allocate()).toBe('10.10.10.50');
    expect(b.allocate()).toBe('10.10.10.50');
  });

  it('registry returns the same pool per nodeId and distinct pools across nodeIds', () => {
    expect(poolForNode(poolConfig('registry-a', 50, 60))).toBe(poolForNode(poolConfig('registry-a', 50, 60)));
    expect(poolForNode(poolConfig('registry-a', 50, 60))).not.toBe(poolForNode(poolConfig('registry-b', 50, 60)));
  });

  it('exhaustion throws a typed HOST_CAPACITY VmError', () => {
    const pool = new NodeIpPool(poolConfig('tiny', 200, 200));
    expect(pool.allocate()).toBe('10.10.10.200');
    try {
      pool.allocate();
      expect.unreachable();
    } catch (err) {
      expect(isVmError(err)).toBe(true);
      if (isVmError(err)) {
        expect(err.code).toBe('HOST_CAPACITY');
        expect(err.retryable).toBe(false);
      }
    }
  });
});
