/**
 * proxmox-real.ts helper tests — pure logic that needs no live Proxmox:
 * osFromTemplateName (golden name → adapter OS family mapping) and the
 * registry-driven per-node static-NAT allocator.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { osFromTemplateName, NodeIpPool, poolForNode, RealProxmox, ipFromConfig, guestDns, encodePs, windowsIpScript } from './proxmox-real.ts';
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

describe('listVms resilience', () => {
  /** Stub fetch: /nodes, /cluster/resources, then per-VM config. */
  function stubFetch(configResponder: (vmid: number) => { ok: boolean; body: unknown }) {
    return async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      const json = (body: unknown) => new Response(JSON.stringify({ data: body }), { status: 200 });

      if (url.endsWith('/nodes')) return json([{ node: 'vmhub' }]);
      if (url.includes('/cluster/resources')) {
        return json([
          { vmid: 3000, node: 'vmhub', name: 'orphan' },
          { vmid: 1001, node: 'vmhub', name: 'x11-abc' },
        ]);
      }
      const m = url.match(/\/qemu\/(\d+)\/config/);
      if (m) {
        const res = configResponder(Number(m[1]));
        return res.ok
          ? json(res.body)
          : new Response(JSON.stringify({ message: res.body }), { status: 500 });
      }
      return json({});
    };
  }

  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('skips a VM whose config is gone instead of failing the whole listing', async () => {
    // Reproduces the live failure: /cluster/resources still advertised vmid
    // 3000 after its qemu-server/3000.conf was gone. That one orphan threw,
    // listVms threw, the node sweep failed, and the reaper reaped nothing.
    globalThis.fetch = stubFetch((vmid) =>
      vmid === 3000
        ? { ok: false, body: "Configuration file 'nodes/vmhub/qemu-server/3000.conf' does not exist" }
        : { ok: true, body: { tags: 'vmhub-x11-abc' } },
    ) as unknown as typeof fetch;

    const client = new RealProxmox({ host: 'h:8006', tokenId: 't', token: 's', nodeId: 'dl360p' });
    const vms = await client.listVms();

    expect(vms.map((v) => v.vmid)).toEqual([1001]);
  });

  it('returns every tagged VM when all configs resolve', async () => {
    globalThis.fetch = stubFetch(() => ({
      ok: true,
      body: { tags: 'vmhub-x11-abc' },
    })) as unknown as typeof fetch;

    const client = new RealProxmox({ host: 'h:8006', tokenId: 't', token: 's', nodeId: 'dl360p' });
    const vms = await client.listVms();

    expect(vms.map((v) => v.vmid).sort()).toEqual([1001, 3000]);
  });
});

describe("ipFromConfig", () => {
  it("reads the static cloud-init address", () => {
    expect(ipFromConfig("ip=10.10.10.62/24,gw=10.10.10.1")).toBe("10.10.10.62");
    expect(ipFromConfig("gw=10.10.10.1,ip=10.10.10.7/24")).toBe("10.10.10.7");
    expect(ipFromConfig("ip=dhcp")).toBeUndefined();
    expect(ipFromConfig(undefined)).toBeUndefined();
  });
});

describe("guestDns", () => {
  it("defaults to public resolvers, never the host's tailnet DNS", () => {
    expect(guestDns({})).toBe("9.9.9.9 149.112.112.112");
    expect(guestDns({ VMHUB_GUEST_DNS: "10.10.10.1, 8.8.8.8" })).toBe("10.10.10.1 8.8.8.8");
  });
});

describe("windowsIpScript", () => {
  it("sets the lease address, gateway and DNS on the first up adapter, idempotently", () => {
    const sc = windowsIpScript("10.10.10.52", "10.10.10.1", "1.1.1.1 9.9.9.9");
    expect(sc).toContain("-IPAddress '10.10.10.52'");
    expect(sc).toContain("-DefaultGateway '10.10.10.1'");
    expect(sc).toContain("-ServerAddresses @('1.1.1.1','9.9.9.9')");
    expect(sc).toMatch(/if \(-not \(Get-NetIPAddress/);
  });
  it("encodes PowerShell as UTF-16LE base64", () => {
    expect(Buffer.from(encodePs("ls"), "base64").toString("utf16le")).toBe("ls");
  });
});
