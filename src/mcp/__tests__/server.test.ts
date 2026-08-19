/**
 * vmhub-mcp tests: the 22-tool surface, capability gating (a stub adapter
 * registers fewer tools but tools are never absent), and the template catalog.
 */
import { describe, expect, it, beforeEach } from 'vitest';

beforeEach(() => {
  process.env.VMHUB_LEASE_CREATE_COOLDOWN_MS = '0';
  process.env.VMHUB_TOOL_DRAIN = 'false';
});
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Client as ClientType } from '@modelcontextprotocol/client';
import { buildMcpServer } from '../index.ts';
import { Registry } from '../../../adapters/index.ts';
import { fakePng } from '../../../adapters/_mock.ts';
import { x11Adapter } from '../../../adapters/x11/index.ts';
import { vmError } from '../errors.ts';
import { VM_TOOLS } from '../capabilities.ts';
import type { DesktopAdapter, InputAction, SemanticElement, Vm, WindowInfo } from '../../shared/types.ts';
import { CAPABILITIES } from '../../shared/types.ts';
import type { ArtifactRecord, Lease, Template, WindowingSystem, InputCapability, FileCapability } from '../../shared/types.ts';
import type { LeaseResponse, LiteClient } from '../lite-client.ts';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Adapter with FEWER tools than the full surface — the gating fixture. */
class StubAdapter implements DesktopAdapter {
  readonly id = 'stub';
  readonly capability = {
    adapter: 'stub',
    os: 'headless' as const,
    windowing: [] as WindowingSystem[],
    input: ['click', 'type'] as InputCapability[],
    semantic: 'none' as const,
    files: [] as FileCapability[],
    exec: false,
    notes: 'Test stub: click+type only.',
  };

  availableTools() {
    return [CAPABILITIES.click, CAPABILITIES.type];
  }
  async screenshot(): Promise<never> {
    throw new Error('unreachable');
  }
  async input(_vm: Vm, action: InputAction): Promise<void> {
    this.lastInput = action;
  }
  async listWindows(): Promise<WindowInfo[]> {
    return [];
  }
  async inspect(): Promise<SemanticElement> {
    return { role: 'root', name: '', x: 0, y: 0, width: 0, height: 0, children: [] };
  }
  async exec() {
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  lastInput: InputAction | null = null;
}

/** In-memory LiteClient — no HTTP, deterministic. */
class FakeLite implements LiteClient {
  vms: Vm[] = [];
  leases = new Map<string, LeaseResponse>();
  templates: Template[] = [];
  artifacts: ArtifactRecord[] = [];
  createLeaseCalls: Array<{ templateId: string; requestId: string }> = [];

  constructor(vmAdapter: string, templates?: Template[]) {
    this.templates = templates ?? [];
    const vm: Vm = {
      uuid: 'vm-0001',
      nodeId: 'dl360p',
      templateId: vmAdapter,
      adapter: vmAdapter,
      capabilities: [],
      proxmoxTag: `vmhub-test-vm-0001`,
      namePrefix: 'test',
      status: 'ready',
      scratchDir: '/tmp/vmhub-test-scratch',
      createdAt: Date.now(),
    };
    this.vms.push(vm);
  }

  async createLease(input: { templateId: string; owner: string; requestId: string; ttlMs?: number }): Promise<LeaseResponse> {
    this.createLeaseCalls.push({ templateId: input.templateId, requestId: input.requestId });
    const vm = this.vms[0]!;
    const lease: Lease = {
      vmId: vm.uuid,
      owner: input.owner,
      requestId: input.requestId,
      expiresAt: Date.now() + (input.ttlMs ?? 86_400_000),
      lastRenewedAt: Date.now(),
      renewCount: 0,
      maxLifetimeMs: input.ttlMs ?? 86_400_000,
    };
    const res = { vm, lease };
    this.leases.set(lease.vmId, res);
    return res;
  }

  async getLease(leaseId: string): Promise<LeaseResponse> {
    const found = this.leases.get(leaseId) ?? this.leases.get(this.vms[0]!.uuid);
    if (!found) throw vmError('NOT_FOUND', `lease ${leaseId} not found`);
    return found;
  }

  async renewLease(leaseId: string, ttlMs?: number): Promise<Lease> {
    const found = this.leases.get(leaseId);
    if (!found) throw vmError('NOT_FOUND', `lease ${leaseId} not found`);
    found.lease.lastRenewedAt = Date.now();
    found.lease.renewCount += 1;
    found.lease.expiresAt = Date.now() + (ttlMs ?? 3_600_000);
    return found.lease;
  }

  async releaseLease(leaseId: string): Promise<void> {
    this.leases.delete(leaseId);
  }

  async getTemplates(): Promise<Template[]> {
    return this.templates;
  }

  async listVms(): Promise<Vm[]> {
    return this.vms;
  }

  async getVm(vmUuid: string): Promise<Vm> {
    const vm = this.vms.find((v) => v.uuid === vmUuid);
    if (!vm) throw vmError('NOT_FOUND', `vm ${vmUuid} not found`);
    return vm;
  }

  async createArtifact(input: { leaseId: string; hostPath: string; sizeBytes: number }): Promise<ArtifactRecord> {
    const rec: ArtifactRecord = { id: `art-${this.artifacts.length + 1}`, leaseId: input.leaseId, hostPath: input.hostPath, sizeBytes: input.sizeBytes, inFlight: false, createdAt: Date.now() };
    this.artifacts.push(rec);
    return rec;
  }

  async getArtifact(id: string): Promise<ArtifactRecord> {
    const rec = this.artifacts.find((a) => a.id === id);
    if (!rec) throw vmError('NOT_FOUND', `artifact ${id} not found`);
    return rec;
  }

  async incrementToolCalls(_vmUuid: string): Promise<void> {}
  async decrementToolCalls(_vmUuid: string): Promise<void> {}
}

async function connectServer(options: { registry?: Registry; lite?: LiteClient }) {
  const server = buildMcpServer({ registry: options.registry, lite: options.lite });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client: ClientType = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientT);
  return { client, server };
}

// ---------------------------------------------------------------------------
// The 22-tool surface
// ---------------------------------------------------------------------------

describe('tool surface', () => {
  it('registers exactly the 22 vm_* tools, in plan order', async () => {
    const registry = new Registry({ stub: new StubAdapter() });
    const { client } = await connectServer({ registry, lite: new FakeLite('stub') });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...VM_TOOLS]);
    // every tool has a description (agents read these)
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('gating never removes a tool — stub adapter still exposes all 22', async () => {
    const registry = new Registry({ stub: new StubAdapter() });
    const { client } = await connectServer({ registry, lite: new FakeLite('stub') });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of VM_TOOLS) expect(names).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

describe('capability gating', () => {
  async function setup() {
    const stub = new StubAdapter();
    const registry = new Registry({ stub });
    const { client } = await connectServer({ registry, lite: new FakeLite('stub') });
    return { client, stub };
  }

  it('serves a tool the stub adapter provides', async () => {
    const { client, stub } = await setup();
    const res = await client.callTool({ name: 'vm_click', arguments: { vm_id: 'vm-0001', x: 10, y: 20 } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { ok?: boolean; result?: unknown };
    expect(sc.ok).toBe(true);
    expect(stub.lastInput).toMatchObject({ kind: 'click', x: 10, y: 20 });
  });

  it('returns typed CAPABILITY_UNAVAILABLE for a tool the stub lacks', async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: 'vm_screenshot', arguments: { vm_id: 'vm-0001' } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { ok?: boolean; error?: { code?: string; message?: string } };
    expect(sc.ok).toBe(false);
    expect(sc.error?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(sc.error?.message).toContain('vm_screenshot');
    expect(sc.error?.message).toContain('stub');
  });

  it('vm_paste is gated on the paste capability (stub lacks it)', async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: 'vm_paste', arguments: { vm_id: 'vm-0001', text: 'héllo' } });
    const sc = res.structuredContent as { ok?: boolean; error?: { code?: string } };
    expect(res.isError).toBe(true);
    expect(sc.error?.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  it('vm_capabilities reports the stub honestly at runtime', async () => {
    const { client } = await setup();
    const res = await client.callTool({ name: 'vm_capabilities', arguments: { id: 'stub' } });
    const sc = res.structuredContent as { result?: { availableTools?: string[]; capability?: { input?: string[] } } };
    expect(sc.result?.availableTools).toEqual(['click', 'type']);
    expect(sc.result?.capability?.input).toEqual(['click', 'type']);
  });
});

// ---------------------------------------------------------------------------
// Template catalog (pre-create capability query)
// ---------------------------------------------------------------------------

/** Production-like real catalog: ids are the actual Proxmox VMIDs. */
function realCatalog(): Template[] {
  return [
    {
      id: '2030',
      os: 'headless',
      availability: 'available',
      capabilities: [CAPABILITIES.exec],
      ramMb: 4096,
      vcpus: 2,
      nestedVirt: false,
      notes: 'Golden template debian-13-golden',
    },
    {
      id: '2060',
      os: 'x11',
      availability: 'available',
      capabilities: [
        CAPABILITIES.screenshot,
        CAPABILITIES.inspect,
        CAPABILITIES.listWindows,
        CAPABILITIES.click,
        CAPABILITIES.type,
        CAPABILITIES.key,
        CAPABILITIES.drag,
        CAPABILITIES.exec,
      ],
      ramMb: 4096,
      vcpus: 2,
      nestedVirt: false,
      notes: 'Golden template x11-2404',
    },
    {
      id: '2070',
      os: 'hyprland',
      availability: 'available',
      capabilities: [
        CAPABILITIES.screenshot,
        CAPABILITIES.inspect,
        CAPABILITIES.listWindows,
        CAPABILITIES.click,
        CAPABILITIES.type,
        CAPABILITIES.key,
        CAPABILITIES.drag,
        CAPABILITIES.dispatch,
        CAPABILITIES.exec,
      ],
      ramMb: 4096,
      vcpus: 2,
      nestedVirt: false,
      notes: 'Golden template hyprland-2404',
    },
  ];
}

describe('template catalog (real Proxmox VMIDs are the ids)', () => {
  async function setupReal() {
    const { client } = await connectServer({ lite: new FakeLite('hyprland', realCatalog()) });
    return { client };
  }

  it('available templates are the real Proxmox VMIDs, not adapter aliases', async () => {
    const { client } = await setupReal();
    const res = await client.callTool({ name: 'vm_list_templates', arguments: {} });
    const sc = res.structuredContent as { result?: { templates?: Template[] } };
    const templates = sc.result?.templates ?? [];
    const available = templates.filter((t) => t.availability === 'available');
    expect(available.map((t) => t.id).sort()).toEqual(['2030', '2060', '2070']);

    const hyprland = templates.find((t) => t.id === '2070');
    expect(hyprland?.availability).toBe('available');
    expect(hyprland?.capabilities).toContain(CAPABILITIES.dispatch);

    const x11 = templates.find((t) => t.id === '2060');
    expect(x11?.availability).toBe('available');
    expect(x11?.capabilities).toContain(CAPABILITIES.screenshot);
    expect(x11?.capabilities).toContain(CAPABILITIES.click);
    expect(x11?.capabilities).not.toContain(CAPABILITIES.launch);

    const headless = templates.find((t) => t.id === '2030');
    expect(headless?.availability).toBe('available');
    expect(headless?.capabilities).toEqual([CAPABILITIES.exec]);
  });

  it('adapter ids with a live golden are replaced (no duplicate entries)', async () => {
    const { client } = await setupReal();
    const res = await client.callTool({ name: 'vm_list_templates', arguments: {} });
    const sc = res.structuredContent as { result?: { templates?: Template[] } };
    const ids = (sc.result?.templates ?? []).map((t) => t.id);
    expect(ids).not.toContain('hyprland');
    expect(ids).not.toContain('x11');
    expect(ids).not.toContain('headless');
  });

  it('adapters with no live golden are unavailable with a reason (never hidden)', async () => {
    const { client } = await setupReal();
    const res = await client.callTool({ name: 'vm_list_templates', arguments: {} });
    const sc = res.structuredContent as { result?: { templates?: Template[] } };
    const templates = sc.result?.templates ?? [];
    for (const id of ['windows', 'android']) {
      const t = templates.find((x) => x.id === id);
      expect(t).toBeDefined();
      expect(t?.availability).not.toBe('available');
      expect(t?.reason).toBeTruthy();
    }
  });

  it('unknown template id → typed NOT_FOUND', async () => {
    const { client } = await setupReal();
    const res = await client.callTool({ name: 'vm_capabilities', arguments: { id: 'nope' } });
    const sc = res.structuredContent as { error?: { code?: string } };
    expect(res.isError).toBe(true);
    expect(sc.error?.code).toBe('NOT_FOUND');
  });

  it('vm_capabilities accepts a real Proxmox VMID', async () => {
    const { client } = await setupReal();
    const res = await client.callTool({ name: 'vm_capabilities', arguments: { id: '2070' } });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { result?: { template?: Template; availableTools?: string[] } };
    expect(sc.result?.template?.id).toBe('2070');
    expect(sc.result?.availableTools).toContain(CAPABILITIES.screenshot);
  });

  it('hyprland adapter id still answers vm_capabilities (registry path)', async () => {
    const { client } = await setupReal();
    const res = await client.callTool({ name: 'vm_capabilities', arguments: { id: 'hyprland' } });
    const sc = res.structuredContent as { result?: { availableTools?: string[] } };
    expect(sc.result?.availableTools).toContain(CAPABILITIES.dispatch);
  });
});

// ---------------------------------------------------------------------------
// Lease lifecycle (FakeLite-backed — no HTTP, no host)
// ---------------------------------------------------------------------------

describe('lease lifecycle tools', () => {
  it('vm_lease_create resolves an adapter alias and forwards the real VMID to lite', async () => {
    const lite = new FakeLite('x11', realCatalog());
    const { client } = await connectServer({ registry: new Registry({ x11: x11Adapter }), lite });
    const res = await client.callTool({
      name: 'vm_lease_create',
      arguments: { template_id: 'x11', owner: 'me', request_id: 'req-1' },
    });
    const sc = res.structuredContent as { ok?: boolean; result?: { vm?: { uuid?: string } } };
    expect(sc.ok).toBe(true);
    expect(sc.result?.vm?.uuid).toBe('vm-0001');
    expect(lite.createLeaseCalls).toContainEqual({ templateId: '2060', requestId: 'req-1' });
  });

  it('vm_lease_create accepts a real Proxmox VMID as template_id', async () => {
    const lite = new FakeLite('x11', realCatalog());
    const { client } = await connectServer({ registry: new Registry({ x11: x11Adapter }), lite });
    const res = await client.callTool({
      name: 'vm_lease_create',
      arguments: { template_id: '2060', owner: 'me', request_id: 'req-2' },
    });
    const sc = res.structuredContent as { ok?: boolean };
    expect(sc.ok).toBe(true);
    expect(lite.createLeaseCalls).toContainEqual({ templateId: '2060', requestId: 'req-2' });
  });

  it('vm_lease_create refuses a template with no live golden (typed CAPABILITY_UNAVAILABLE)', async () => {
    const lite = new FakeLite('x11', realCatalog());
    const { client } = await connectServer({ lite });
    const res = await client.callTool({
      name: 'vm_lease_create',
      arguments: { template_id: 'windows', owner: 'me', request_id: 'req-3' },
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error?: { code?: string; message?: string } };
    expect(sc.error?.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(sc.error?.message).toContain('windows');
  });

  it('vm_lease_create with an unknown template id → typed NOT_FOUND', async () => {
    const lite = new FakeLite('x11', realCatalog());
    const { client } = await connectServer({ lite });
    const res = await client.callTool({
      name: 'vm_lease_create',
      arguments: { template_id: '9999', owner: 'me', request_id: 'req-4' },
    });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error?: { code?: string } };
    expect(sc.error?.code).toBe('NOT_FOUND');
  });

  it('vm_lease_status resolves the leased VM', async () => {
    const lite = new FakeLite('x11', realCatalog());
    const { client } = await connectServer({ registry: new Registry({ x11: x11Adapter }), lite });
    await client.callTool({ name: 'vm_lease_create', arguments: { template_id: 'x11', owner: 'me', request_id: 'req-1' } });
    const res = await client.callTool({ name: 'vm_lease_status', arguments: { lease_id: 'vm-0001' } });
    const sc = res.structuredContent as { ok?: boolean };
    expect(sc.ok).toBe(true);
  });

  it('vm_lease_renew increments renewCount', async () => {
    const lite = new FakeLite('x11', realCatalog());
    const { client } = await connectServer({ registry: new Registry({ x11: x11Adapter }), lite });
    await client.callTool({ name: 'vm_lease_create', arguments: { template_id: 'x11', owner: 'me', request_id: 'req-1' } });
    await client.callTool({ name: 'vm_lease_renew', arguments: { lease_id: 'vm-0001' } });
    expect(lite.leases.get('vm-0001')?.lease.renewCount).toBe(1);
  });

  it('vm_lease_release removes the lease', async () => {
    const lite = new FakeLite('x11', realCatalog());
    const { client } = await connectServer({ registry: new Registry({ x11: x11Adapter }), lite });
    await client.callTool({ name: 'vm_lease_create', arguments: { template_id: 'x11', owner: 'me', request_id: 'req-1' } });
    const res = await client.callTool({ name: 'vm_lease_release', arguments: { lease_id: 'vm-0001' } });
    const sc = res.structuredContent as { ok?: boolean };
    expect(sc.ok).toBe(true);
    expect(lite.leases.has('vm-0001')).toBe(false);
  });

  it('vm_lease_status on an unknown lease → typed NOT_FOUND', async () => {
    const lite = new FakeLite('x11', realCatalog());
    const { client } = await connectServer({ registry: new Registry({ x11: x11Adapter }), lite });
    const res = await client.callTool({ name: 'vm_lease_status', arguments: { lease_id: 'ghost' } });
    expect(res.isError).toBe(true);
    const sc = res.structuredContent as { error?: { code?: string } };
    expect(sc.error?.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Additional tool coverage (FakeLite + StubAdapter — no HTTP, no host)
// ---------------------------------------------------------------------------

describe('vm_health', () => {
  it('reports ok when lite is reachable', async () => {
    const lite = new FakeLite('x11');
    const { client } = await connectServer({ registry: new Registry({ x11: x11Adapter }), lite });
    const res = await client.callTool({ name: 'vm_health', arguments: {} });
    const sc = res.structuredContent as { ok?: boolean; result?: { status?: string; lite?: { reachable?: boolean } } };
    expect(sc.ok).toBe(true);
    expect(sc.result?.status).toBe('ok');
    expect(sc.result?.lite?.reachable).toBe(true);
  });
});

describe('tools on the stub surface (never hidden, typed when unsupported)', () => {
  it('vm_type is served by the stub adapter', async () => {
    const stub = new StubAdapter();
    const lite = new FakeLite('stub');
    const { client } = await connectServer({ registry: new Registry({ stub: stub as never }), lite });
    const res = await client.callTool({ name: 'vm_type', arguments: { vm_id: 'vm-0001', text: 'hello' } });
    const sc = res.structuredContent as { ok?: boolean };
    expect(sc.ok).toBe(true);
    expect(stub.lastInput).toMatchObject({ kind: 'type', text: 'hello' });
  });

  it('unsupported tools return typed CAPABILITY_UNAVAILABLE (never absent)', async () => {
    const stub = new StubAdapter();
    const lite = new FakeLite('stub');
    const { client } = await connectServer({ registry: new Registry({ stub: stub as never }), lite });
    const cases: Array<[string, Record<string, unknown>]> = [
      ['vm_inspect', { vm_id: 'vm-0001' }],
      ['vm_list_windows', { vm_id: 'vm-0001' }],
      ['vm_key', { vm_id: 'vm-0001', chord: 'ctrl+alt+t' }],
      ['vm_drag', { vm_id: 'vm-0001', from_x: 1, from_y: 2, to_x: 3, to_y: 4 }],
      ['vm_launch', { vm_id: 'vm-0001', command: 'xterm' }],
      ['vm_focus', { vm_id: 'vm-0001', window: 'w1' }],
      ['vm_close', { vm_id: 'vm-0001', window: 'w1' }],
      ['vm_dispatch', { vm_id: 'vm-0001', verb: 'closewindow', args: { window: 'w1' } }],
      ['vm_put_file', { vm_id: 'vm-0001', local_path: '/tmp/x', remote_path: '/tmp/x' }],
      ['vm_get_file', { vm_id: 'vm-0001', remote_path: '/tmp/x', local_path: '/tmp/y' }],
      ['vm_clone_repo', { vm_id: 'vm-0001', repo_url: 'https://github.com/a/b.git', dest_path: '/tmp/r' }],
    ];
    for (const [tool, args] of cases) {
      const res = await client.callTool({ name: tool, arguments: args });
      const sc = res.structuredContent as { error?: { code?: string } };
      expect(sc.error?.code).toBe('CAPABILITY_UNAVAILABLE');
    }
  });
});

// ---------------------------------------------------------------------------
// Fake PNG sanity
// ---------------------------------------------------------------------------

describe('fakePng', () => {
  it('produces a valid PNG with the requested dimensions', () => {
    const png = fakePng(64, 48, [10, 20, 30]);
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(0, 8).equals(sig)).toBe(true);
    expect(png.readUInt32BE(16)).toBe(64); // IHDR width
    expect(png.readUInt32BE(20)).toBe(48); // IHDR height
  });
});
