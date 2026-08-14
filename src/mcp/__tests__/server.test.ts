/**
 * vmhub-mcp tests: the 22-tool surface, capability gating (a stub adapter
 * registers fewer tools but tools are never absent), and the template catalog.
 */
import { describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { Client as ClientType } from '@modelcontextprotocol/client';
import { buildMcpServer } from '../index.ts';
import { Registry } from '../../../adapters/index.ts';
import { fakePng } from '../../../adapters/_mock.ts';
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

  constructor(vmAdapter: string) {
    const vm: Vm = {
      uuid: 'vm-0001',
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

describe('template catalog', () => {
  async function setupFull() {
    const { client } = await connectServer({ lite: new FakeLite('hyprland') });
    return { client };
  }

  it('lists all 7 adapters with honest availability and reasons', async () => {
    const { client } = await setupFull();
    const res = await client.callTool({ name: 'vm_list_templates', arguments: {} });
    const sc = res.structuredContent as { result?: { templates?: Template[] } };
    const templates = sc.result?.templates ?? [];
    const ids = templates.map((t) => t.id).sort();
    expect(ids).toEqual(['android', 'headless', 'hyprland', 'ios', 'macos', 'windows', 'x11']);

    const hyprland = templates.find((t) => t.id === 'hyprland');
    expect(hyprland?.availability).toBe('available');
    expect(hyprland?.capabilities.length).toBeGreaterThan(8);

    const x11 = templates.find((t) => t.id === 'x11');
    expect(x11?.availability).toBe('available');
    expect(x11?.capabilities).toContain(CAPABILITIES.screenshot);
    expect(x11?.capabilities).toContain(CAPABILITIES.click);
    expect(x11?.capabilities).not.toContain(CAPABILITIES.launch);

    const headless = templates.find((t) => t.id === 'headless');
    expect(headless?.availability).toBe('available');
    expect(headless?.capabilities).toEqual([]);

    const ios = templates.find((t) => t.id === 'ios');
    expect(ios?.availability).toBe('stub');
    expect(ios?.capabilities).toEqual([]);
    expect(ios?.reason).toBeTruthy();

    const windows = templates.find((t) => t.id === 'windows');
    expect(windows?.availability).toBe('stub');
    expect(windows?.reason).toContain('mock');
    expect(windows?.capabilities).toContain(CAPABILITIES.screenshot);
    expect(windows?.capabilities).toContain(CAPABILITIES.putFile);
  });

  it('unknown template id → typed NOT_FOUND', async () => {
    const { client } = await setupFull();
    const res = await client.callTool({ name: 'vm_capabilities', arguments: { id: 'nope' } });
    const sc = res.structuredContent as { error?: { code?: string } };
    expect(res.isError).toBe(true);
    expect(sc.error?.code).toBe('NOT_FOUND');
  });

  it('hyprland template lists the dispatch capability (validated escape hatch)', async () => {
    const { client } = await setupFull();
    const res = await client.callTool({ name: 'vm_capabilities', arguments: { id: 'hyprland' } });
    const sc = res.structuredContent as { result?: { availableTools?: string[] } };
    expect(sc.result?.availableTools).toContain(CAPABILITIES.dispatch);
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
