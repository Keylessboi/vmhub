/**
 * proxmox-real.ts helper tests — pure logic that needs no live Proxmox:
 * osFromTemplateName (golden name → adapter OS family mapping) and the
 * per-OS template capability surface (T4b makes it honest via a shared map).
 */
import { describe, expect, it } from 'vitest';
import { osFromTemplateName, RealProxmox } from './proxmox-real.ts';
import type { Template } from '../shared/types.ts';

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

  it('maps macos/ios names to their families', () => {
    expect(osFromTemplateName('macos-14')).toBe('macos');
    expect(osFromTemplateName('mac-ventura')).toBe('macos');
    expect(osFromTemplateName('ios-sim')).toBe('ios');
  });

  it('falls back to headless for unknown names', () => {
    expect(osFromTemplateName('unknown-box')).toBe('headless');
    expect(osFromTemplateName(undefined)).toBe('headless');
    expect(osFromTemplateName('')).toBe('headless');
  });
});

/**
 * Stub the one fetch RealProxmox.listTemplates makes (GET /cluster/resources)
 * with golden VMs; the response shape is { data: [...] }.
 */
async function templatesFor(names: string[]): Promise<Template[]> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      data: names.map((name, i) => ({
        vmid: 100 + i,
        name,
        template: 1,
        maxmem: 4096 * 1024 * 1024,
        maxcpu: 2,
      })),
    }),
  })) as unknown as typeof fetch;
  try {
    return await new RealProxmox({ host: 'pve.example', tokenId: 'id', token: 'tok' }).listTemplates();
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('templateCapabilities (honest per-OS surface, T4b)', () => {
  it('x11 templates advertise exec (the adapter now has it)', async () => {
    const [t] = await templatesFor(['x11-2404']);
    expect(t?.capabilities).toContain('exec');
  });

  it('hyprland templates do NOT advertise exec', async () => {
    const [t] = await templatesFor(['hyprland-2404']);
    expect(t?.capabilities).not.toContain('exec');
  });

  it('windows templates do NOT advertise exec', async () => {
    const [t] = await templatesFor(['windows-11-24h2']);
    expect(t?.capabilities).not.toContain('exec');
  });

  it('headless templates keep exec and nothing else', async () => {
    const [t] = await templatesFor(['debian-13-golden']);
    expect(t?.capabilities).toEqual(['exec']);
  });
});

describe('shared per-OS capability map (lands in T4b)', () => {
  // The module src/shared/os-capabilities.ts does not exist yet: the
  // non-literal specifier keeps tsc green while every test here is red
  // ("Cannot find module"), which is the expected RED phase.
  async function osCapabilities(os: string): Promise<string[]> {
    const mod = await import('../shared/os-capabilities.ts' + '');
    return (mod as { osCapabilities(os: string): string[] }).osCapabilities(os);
  }

  it('x11 includes exec', async () => {
    expect(await osCapabilities('x11')).toContain('exec');
  });

  it('hyprland does not advertise exec', async () => {
    expect(await osCapabilities('hyprland')).not.toContain('exec');
  });

  it('windows does not advertise exec', async () => {
    expect(await osCapabilities('windows')).not.toContain('exec');
  });

  it('headless keeps exec', async () => {
    expect(await osCapabilities('headless')).toEqual(['exec']);
  });
});

describe('listVms (identity sweep)', () => {
  it('skips LXC containers — only qemu entries have a qemu-server config', async () => {
    const realFetch = globalThis.fetch;
    const requested: string[] = [];
    const handler = async (input: unknown): Promise<Response> => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/api2/json/nodes')) {
        return new Response(JSON.stringify({ data: [{ node: 'vmhub' }] }), { status: 200 });
      }
      if (url.includes('/cluster/resources')) {
        // An LXC container rides along in type=vm; it must be ignored.
        return new Response(
          JSON.stringify({
            data: [
              { vmid: 2110, name: 'android', type: 'qemu', node: 'vmhub' },
              { vmid: 3000, name: 'llm', type: 'lxc', node: 'vmhub' },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/qemu/2110/config')) {
        return new Response(JSON.stringify({ data: { tags: 'vmhub-test-sweep' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    };
    globalThis.fetch = handler as unknown as typeof fetch;
    try {
      const client = new RealProxmox({ host: 'pve.example', tokenId: 'id', token: 'tok' });
      const vms = await client.listVms();
      expect(vms).toHaveLength(1);
      expect(vms[0]?.vmid).toBe(2110);
      // never asked for the lxc's qemu config
      expect(requested.some((u) => u.includes('/qemu/3000/config'))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
