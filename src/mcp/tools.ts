/**
 * The 22 vm_* tools. Every handler: resolve VM → adapter → capability gate →
 * adapter call → typed result or typed VmError. Tools are NEVER absent;
 * unsupported capability = CAPABILITY_UNAVAILABLE error (see capabilities.ts).
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { DesktopAdapter, Template, Vm } from '../shared/types.ts';
import type { AdapterRegistry } from '../../adapters/index.ts';
import type { LiteClient } from './lite-client.ts';
import { assertToolAvailable, capabilityReport, getTemplate, templateCatalog, templateFromAdapter, type VmToolName } from './capabilities.ts';
import { errorResult, okResult, toVmError, vmError } from './errors.ts';
import { pollUntil, POLL_BOUND_MS } from './polling.ts';
import { writeScreenshot } from './files.ts';

export interface McpDeps {
  lite: LiteClient;
  registry: AdapterRegistry;
  /** Base URL reported by vm_health (not the request target — deps.lite is). */
  liteUrl: string;
}

// ---------------------------------------------------------------------------
// Real-catalog template resolution (the VMID namespace contract)
//
// lite's REAL template catalog is the single source of truth for template ids:
// in production those ids ARE the live Proxmox VMIDs (2030, 2060, 2070 ...).
// A local adapter id still resolves as an alias when a live golden exists for
// that OS family (backward compatible), and adapters with no live golden
// resolve to an `unavailable` entry so vm_lease_create NEVER forwards an id
// lite cannot clone. When lite is unreachable the local matrix is used
// degraded — never an error.
// ---------------------------------------------------------------------------

async function resolveTemplate(deps: McpDeps, templateId: string): Promise<Template> {
  let real: Template[] | undefined;
  try {
    real = await deps.lite.getTemplates();
  } catch {
    real = undefined; // lite unreachable → degraded local matrix
  }

  // Exact real id (a Proxmox VMID) — the authoritative path.
  const exact = real?.find((t) => t.id === templateId);
  if (exact) return exact;

  // Local adapter id — alias to its live golden, or an honest unavailable.
  if (deps.registry.has(templateId)) {
    const local = templateFromAdapter(deps.registry.get(templateId));
    const realForOs = real?.find((t) => t.os === local.os);
    if (realForOs) return realForOs;
    if (real === undefined) return local; // degraded (lite unreachable)
    return {
      ...local,
      availability: 'unavailable',
      reason: noGoldenReason(local.id, real),
    };
  }

  const known =
    real !== undefined
      ? [...deps.registry.ids(), ...real.map((t) => t.id)].join(', ')
      : deps.registry.ids().join(', ');
  throw vmError('NOT_FOUND', `unknown template "${templateId}"`, `known templates: ${known}`);
}

function noGoldenReason(adapterId: string, real: Template[]): string {
  const ids = real.map((t) => t.id).join(', ');
  return `no live golden template on Proxmox for "${adapterId}" — provisionable template ids: ${ids || 'none'}`;
}

function sortCatalog(templates: Template[]): Template[] {
  return [...templates].sort((a, b) => {
    const aReady = a.availability === 'available' ? 0 : 1;
    const bReady = b.availability === 'available' ? 0 : 1;
    return aReady !== bReady ? aReady - bReady : a.id.localeCompare(b.id);
  });
}

/** Resolve a VM's adapter and enforce capability gating before any call. */
async function adapterFor(deps: McpDeps, vm: Vm, tool: VmToolName): Promise<DesktopAdapter> {
  if (!deps.registry.has(vm.adapter)) {
    throw vmError(
      'NOT_FOUND',
      `VM ${vm.uuid} uses adapter "${vm.adapter}", which is not registered in this vmhub-mcp build`,
      `registered adapters: ${deps.registry.ids().join(', ')}`,
    );
  }
  const adapter = deps.registry.get(vm.adapter);
  assertToolAvailable(tool, adapter);
  return adapter;
}

/** Helper for tools that need a VM by uuid. */
async function vmOf(deps: McpDeps, vmId: string): Promise<Vm> {
  return deps.lite.getVm(vmId);
}

/** A lease's VM counts as "done provisioning" in these statuses. */
const DONE_STATUSES = new Set(['ready', 'error', 'destroyed']);

export function registerTools(server: McpServer, deps: McpDeps): void {
  // ── CATALOG / CAPABILITIES / HEALTH ─────────────────────────────────────

  server.registerTool(
    'vm_list_templates',
    {
      title: 'List VM templates',
      description:
        'Pre-create capability catalog: every template with availability ("available" | "unavailable" | "stub"), reason when not available, and the exact capabilities a VM cloned from it will have. Pick a template here BEFORE vm_lease_create.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const start = Date.now();
      try {
        // lite's REAL catalog is the source of truth: template ids ARE the
        // live Proxmox VMIDs. Local adapters with a live golden are replaced
        // by their real entry; adapters with no golden are demoted to
        // `unavailable` so the catalog never advertises an id lite cannot
        // clone.
        const local = templateCatalog(deps.registry);
        let real: Template[] = [];
        try {
          real = await deps.lite.getTemplates();
        } catch {
          real = []; // lite unreachable → degrade to the local matrix
        }
        const realByOs = new Map(real.map((t) => [t.os, t]));
        const merged = local.map((t) => {
          const realForOs = realByOs.get(t.os);
          if (realForOs) return realForOs;
          return {
            ...t,
            availability: 'unavailable' as const,
            reason:
              real.length === 0
                ? 'vmhub-lite reports no golden templates — nothing can be provisioned right now'
                : noGoldenReason(t.id, real),
          };
        });
        const mergedIds = new Set(merged.map((t) => t.id));
        const liteOnly = real.filter((r) => !mergedIds.has(r.id));
        return okResult('vm_list_templates', { templates: sortCatalog([...merged, ...liteOnly]) }, start);
      } catch (e) {
        return errorResult('vm_list_templates', toVmError(e, 'vm_list_templates'), start);
      }
    },
  );

  server.registerTool(
    'vm_capabilities',
    {
      title: 'VM capabilities (runtime query)',
      description:
        'Runtime capability query for one template/adapter id: the full Capability declaration (windowing, input modalities, semantic tree, file transports, exec) plus the tool-surface capabilities actually available.',
      inputSchema: z.object({ id: z.string().describe('Template/adapter id, e.g. "hyprland", "windows", "ios"') }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const start = Date.now();
      try {
        if (deps.registry.has(id)) {
          const adapter = deps.registry.get(id);
          const report = capabilityReport(adapter);
          return okResult('vm_capabilities', { ...report, template: getTemplate(deps.registry, id) }, start);
        }
        // Real Proxmox VMID path: resolve from lite's live catalog and map to
        // the adapter by OS family.
        const real = await deps.lite.getTemplates();
        const t = real.find((r) => r.id === id);
        if (!t) {
          throw vmError(
            'NOT_FOUND',
            `unknown template "${id}"`,
            `known templates: ${[...deps.registry.ids(), ...real.map((r) => r.id)].join(', ')}`,
          );
        }
        const adapter = deps.registry.has(t.os) ? deps.registry.get(t.os) : undefined;
        const report = adapter
          ? capabilityReport(adapter)
          : { adapter: id, os: t.os, capability: null, availableTools: t.capabilities };
        return okResult('vm_capabilities', { ...report, template: t }, start);
      } catch (e) {
        return errorResult('vm_capabilities', toVmError(e, 'vm_capabilities'), start);
      }
    },
  );

  server.registerTool(
    'vm_health',
    {
      title: 'Server and lite health',
      description:
        'Reachability of vmhub-lite (the lease/provisioning backend) plus the adapter registry summary. Informational — errors here are degraded, not fatal.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const start = Date.now();
      try {
        let liteReachable = true;
        let liteError: string | undefined;
        try {
          await deps.lite.getTemplates();
        } catch (e) {
          liteReachable = false;
          liteError = e instanceof Error ? e.message : String(e);
        }
        const adapters = deps.registry.ids().map((id) => {
          const a = deps.registry.get(id);
          return { id, os: a.capability.os, tools: a.availableTools().length, availability: getTemplate(deps.registry, id).availability };
        });
        return okResult(
          'vm_health',
          {
            status: liteReachable ? 'ok' : 'degraded',
            lite: { reachable: liteReachable, baseUrl: deps.liteUrl, error: liteError },
            adapters,
          },
          start,
        );
      } catch (e) {
        return errorResult('vm_health', toVmError(e, 'vm_health'), start);
      }
    },
  );

  // ── LEASE LIFECYCLE ──────────────────────────────────────────────────────

  server.registerTool(
    'vm_lease_create',
    {
      title: 'Create a VM lease',
      description:
        'Clone a template and lease it. Idempotent on request_id: retries with the same request_id return the same lease. Waits up to 20s (chunked polling) for the VM to become ready; on timedOut:true keep calling vm_lease_status with the lease_id.',
      inputSchema: z.object({
        template_id: z.string().describe('Template id from vm_list_templates'),
        owner: z.string().describe('Who owns the lease (agent/session id)'),
        request_id: z.string().describe('Idempotency key — reuse on retries'),
        ttl_ms: z.number().int().positive().max(86_400_000).optional().describe('Lease lifetime cap in ms (default 24h)'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ template_id, owner, request_id, ttl_ms }) => {
      const start = Date.now();
      try {
        const template = await resolveTemplate(deps, template_id);
        if (template.availability !== 'available') {
          throw vmError(
            'CAPABILITY_UNAVAILABLE',
            `template "${template_id}" is not available: ${template.reason ?? 'no live golden template'}`,
          );
        }
        // Forward the RESOLVED id (a real Proxmox VMID when one exists), never
        // a local adapter alias lite cannot clone.
        const created = await deps.lite.createLease({ templateId: template.id, owner, requestId: request_id, ttlMs: ttl_ms });
        const outcome = await pollUntil(
          () => deps.lite.getLease(created.lease.vmId),
          (s) => DONE_STATUSES.has(s.vm.status),
          { timeoutMs: POLL_BOUND_MS },
        );
        const { vm, lease } = outcome.value;
        const ready = vm.status === 'ready';
        return okResult(
          'vm_lease_create',
          {
            vm,
            lease,
            ready,
            timedOut: outcome.timedOut,
            polls: outcome.polls,
            hint: outcome.timedOut ? 'call vm_lease_status with this lease_id until ready' : undefined,
          },
          start,
        );
      } catch (e) {
        return errorResult('vm_lease_create', toVmError(e, 'vm_lease_create'), start);
      }
    },
  );

  server.registerTool(
    'vm_lease_status',
    {
      title: 'Lease / VM status',
      description:
        'Current status of a lease and its VM. With wait_ms (bounded to 20s) this polls in chunks until the VM finishes provisioning or the bound hits.',
      inputSchema: z.object({
        lease_id: z.string(),
        wait_ms: z.number().int().min(0).max(20_000).optional().describe('Bounded wait in ms (max 20000); 0/omitted = single snapshot'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ lease_id, wait_ms }) => {
      const start = Date.now();
      try {
        const single = await deps.lite.getLease(lease_id);
        if (!wait_ms) {
          return okResult('vm_lease_status', { vm: single.vm, lease: single.lease, ready: single.vm.status === 'ready' }, start);
        }
        const outcome = await pollUntil(
          () => deps.lite.getLease(lease_id),
          (s) => DONE_STATUSES.has(s.vm.status),
          { timeoutMs: wait_ms },
        );
        return okResult(
          'vm_lease_status',
          { vm: outcome.value.vm, lease: outcome.value.lease, ready: outcome.value.vm.status === 'ready', timedOut: outcome.timedOut, polls: outcome.polls },
          start,
        );
      } catch (e) {
        return errorResult('vm_lease_status', toVmError(e, 'vm_lease_status'), start);
      }
    },
  );

  server.registerTool(
    'vm_lease_renew',
    {
      title: 'Renew a lease',
      description: 'Push the lease deadline forward (default +1h, capped by the 24h max lifetime).',
      inputSchema: z.object({
        lease_id: z.string(),
        ttl_ms: z.number().int().positive().max(86_400_000).optional().describe('Extension in ms (default 3600000)'),
      }),
      annotations: {},
    },
    async ({ lease_id, ttl_ms }) => {
      const start = Date.now();
      try {
        const lease = await deps.lite.renewLease(lease_id, ttl_ms);
        return okResult('vm_lease_renew', { lease }, start);
      } catch (e) {
        return errorResult('vm_lease_renew', toVmError(e, 'vm_lease_renew'), start);
      }
    },
  );

  server.registerTool(
    'vm_lease_release',
    {
      title: 'Release a lease',
      description: 'Teardown: identity-verified destroy of the VM and cleanup of its lease artifacts. The VM is gone — release only when done.',
      inputSchema: z.object({ lease_id: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ lease_id }) => {
      const start = Date.now();
      try {
        await deps.lite.releaseLease(lease_id);
        return okResult('vm_lease_release', { released: true, lease_id }, start);
      } catch (e) {
        return errorResult('vm_lease_release', toVmError(e, 'vm_lease_release'), start);
      }
    },
  );

  // ── SIGHT ────────────────────────────────────────────────────────────────

  server.registerTool(
    'vm_screenshot',
    {
      title: 'Screenshot the VM screen',
      description:
        'Capture the full VM screen through its adapter. Returns a file path (hand to a vision subagent if you cannot see images), dimensions, and the coordMapping (logical screen coords → image pixels; identity for most adapters).',
      inputSchema: z.object({
        vm_id: z.string().describe('VM uuid from the lease'),
        jpeg: z.boolean().default(false).describe('Request JPEG instead of PNG'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ vm_id, jpeg }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_screenshot');
        const shot = await adapter.screenshot(vm);
        const written = await writeScreenshot(vm.uuid, shot);
        const payload = { ...written, jpeg };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
            { type: 'image' as const, data: shot.image.toString('base64'), mimeType: shot.format === 'jpg' ? ('image/jpeg' as const) : ('image/png' as const) },
          ],
          structuredContent: { ok: true, action: 'vm_screenshot', result: payload, ms: Date.now() - start },
        };
      } catch (e) {
        return errorResult('vm_screenshot', toVmError(e, 'vm_screenshot'), start);
      }
    },
  );

  server.registerTool(
    'vm_inspect',
    {
      title: 'Inspect the semantic element tree',
      description:
        'Semantic inspection of the VM screen (UI Automation / Accessibility / OCR depending on adapter). Returns a tree of elements with roles, names, and geometry — the text-only-model path for understanding what is on screen.',
      inputSchema: z.object({ vm_id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ vm_id }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_inspect');
        const tree = await adapter.inspect(vm);
        return okResult('vm_inspect', { semantic: adapter.capability.semantic, tree }, start);
      } catch (e) {
        return errorResult('vm_inspect', toVmError(e, 'vm_inspect'), start);
      }
    },
  );

  server.registerTool(
    'vm_list_windows',
    {
      title: 'List VM windows',
      description: 'All windows with id/title/class/geometry/focused/visible. Pass filter to narrow by class or title substring.',
      inputSchema: z.object({ vm_id: z.string(), filter: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    async ({ vm_id, filter }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_list_windows');
        const windows = await adapter.listWindows(vm);
        const list = filter ? windows.filter((w) => w.title.toLowerCase().includes(filter.toLowerCase()) || (w.className ?? '').toLowerCase().includes(filter.toLowerCase())) : windows;
        return okResult('vm_list_windows', { count: list.length, windows: list }, start);
      } catch (e) {
        return errorResult('vm_list_windows', toVmError(e, 'vm_list_windows'), start);
      }
    },
  );

  // ── INPUT ────────────────────────────────────────────────────────────────

  server.registerTool(
    'vm_click',
    {
      title: 'Click at coordinates',
      description: 'Move the pointer to logical screen coordinates and click. Coordinates are logical (see vm_screenshot coordMapping).',
      inputSchema: z.object({
        vm_id: z.string(),
        x: z.number().describe('Logical x'),
        y: z.number().describe('Logical y'),
        button: z.enum(['left', 'right', 'middle']).default('left'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, x, y, button }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_click');
        await adapter.input(vm, { kind: 'click', x, y, button });
        return okResult('vm_click', { clicked: true, x, y, button }, start);
      } catch (e) {
        return errorResult('vm_click', toVmError(e, 'vm_click'), start);
      }
    },
  );

  server.registerTool(
    'vm_type',
    {
      title: 'Type text',
      description: 'Type ASCII text into the focused window of the VM (fast path; use vm_paste for Unicode).',
      inputSchema: z.object({ vm_id: z.string(), text: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, text }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_type');
        await adapter.input(vm, { kind: 'type', text });
        return okResult('vm_type', { typed: text.length }, start);
      } catch (e) {
        return errorResult('vm_type', toVmError(e, 'vm_type'), start);
      }
    },
  );

  server.registerTool(
    'vm_key',
    {
      title: 'Send key chord',
      description: 'Send a key chord (e.g. "ctrl+alt+t") to the focused window of the VM.',
      inputSchema: z.object({ vm_id: z.string(), chord: z.string().describe('Key chord, e.g. "ctrl+alt+t"') }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, chord }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_key');
        await adapter.input(vm, { kind: 'key', chord });
        return okResult('vm_key', { chord }, start);
      } catch (e) {
        return errorResult('vm_key', toVmError(e, 'vm_key'), start);
      }
    },
  );

  server.registerTool(
    'vm_paste',
    {
      title: 'Paste text (gated)',
      description:
        'Paste text into the VM through its own clipboard (Unicode-safe). Gated: only VMs whose template lists the "paste" capability. Pasting happens VM-side, never on the host.',
      inputSchema: z.object({ vm_id: z.string(), text: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, text }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_paste');
        if (!adapter.dispatch) {
          throw vmError('CAPABILITY_UNAVAILABLE', `adapter "${adapter.id}" has no dispatch path for paste`);
        }
        const result = await adapter.dispatch(vm, 'paste', { text });
        return okResult('vm_paste', { pasted: true, chars: text.length, detail: result }, start);
      } catch (e) {
        return errorResult('vm_paste', toVmError(e, 'vm_paste'), start);
      }
    },
  );

  server.registerTool(
    'vm_drag',
    {
      title: 'Drag the mouse',
      description: 'Drag from one logical coordinate to another (move + press + move + release).',
      inputSchema: z.object({
        vm_id: z.string(),
        from_x: z.number(),
        from_y: z.number(),
        to_x: z.number(),
        to_y: z.number(),
        button: z.enum(['left', 'right']).default('left'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, from_x, from_y, to_x, to_y, button }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_drag');
        await adapter.input(vm, { kind: 'drag', from: { x: from_x, y: from_y }, to: { x: to_x, y: to_y } });
        return okResult('vm_drag', { dragged: true, from: [from_x, from_y], to: [to_x, to_y] }, start);
      } catch (e) {
        return errorResult('vm_drag', toVmError(e, 'vm_drag'), start);
      }
    },
  );

  // ── WINDOW MANAGEMENT ────────────────────────────────────────────────────

  /** dispatch-based window ops; paste uses the same validated slot. */
  const windowOp = async (tool: VmToolName, vmId: string, verb: string, args: Record<string, unknown>) => {
    const start = Date.now();
    try {
      const vm = await vmOf(deps, vmId);
      const adapter = await adapterFor(deps, vm, tool);
      if (!adapter.dispatch) {
        throw vmError('CAPABILITY_UNAVAILABLE', `adapter "${adapter.id}" does not implement dispatch (needed by ${tool})`);
      }
      const result = await adapter.dispatch(vm, verb, args);
      const { vm_id: _dropped, ...rest } = args;
      return okResult(tool, { ...rest, detail: result }, start);
    } catch (e) {
      return errorResult(tool, toVmError(e, tool), start);
    }
  };

  server.registerTool(
    'vm_launch',
    {
      title: 'Launch an app in the VM',
      description:
        'Launch an app in the VM, optionally on a specific workspace. Prefer a dedicated agent workspace so nothing disturbs the user. wait_for_window matches by class on the VM desktop.',
      inputSchema: z.object({
        vm_id: z.string(),
        command: z.string(),
        args: z.array(z.string()).default([]),
        workspace: z.union([z.number().int(), z.string()]).optional().describe('Workspace id or name:selector'),
        wait_for_window: z.boolean().default(true),
        timeout_ms: z.number().int().default(10_000),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, command, args, workspace, wait_for_window, timeout_ms }) => {
      return windowOp('vm_launch', vm_id, 'launch', { command, args, workspace, wait_for_window, timeout_ms });
    },
  );

  server.registerTool(
    'vm_focus',
    {
      title: 'Focus a VM window',
      description: 'Bring a window to the foreground. Window selector: id/address, class, or title substring (ambiguous matches are rejected).',
      inputSchema: z.object({ vm_id: z.string(), window: z.string().describe('Window id/address, class, or title') }),
      annotations: {},
    },
    async ({ vm_id, window }) => {
      return windowOp('vm_focus', vm_id, 'focus', { window });
    },
  );

  server.registerTool(
    'vm_close',
    {
      title: 'Close a VM window',
      description: 'Gracefully close a window by id/address, class, or title. Destructive.',
      inputSchema: z.object({ vm_id: z.string(), window: z.string() }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, window }) => {
      return windowOp('vm_close', vm_id, 'close', { window });
    },
  );

  server.registerTool(
    'vm_dispatch',
    {
      title: 'Validated escape hatch',
      description:
        'Advanced passthrough: verb + args are forwarded as validated argv (never shell strings) to the VM windowing system (e.g. hyprctl dispatch). Only for the 20% of operations without a dedicated vm_* tool.',
      inputSchema: z.object({
        vm_id: z.string(),
        verb: z.string().describe('Windowing dispatch verb, e.g. "exec", "workspace"'),
        args: z.record(z.string(), z.unknown()).default({}).describe('Keys and values flatten to argv, in insertion order'),
      }),
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ vm_id, verb, args }) => {
      return windowOp('vm_dispatch', vm_id, verb, args);
    },
  );

  // ── FILES ────────────────────────────────────────────────────────────────

  server.registerTool(
    'vm_put_file',
    {
      title: 'Copy a file into the VM',
      description: 'Copy a host file into the VM via the adapter\'s transport (scp/sftp/adb/docker-cp). The destination is registered as a lease artifact.',
      inputSchema: z.object({
        vm_id: z.string(),
        local_path: z.string().describe('Absolute host path'),
        remote_path: z.string().describe('Destination path inside the VM'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, local_path, remote_path }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_put_file');
        if (!adapter.putFile) {
          throw vmError('CAPABILITY_UNAVAILABLE', `adapter "${adapter.id}" has no put_file transport (files: ${adapter.capability.files.join(', ') || 'none'})`);
        }
        await adapter.putFile(vm, local_path, remote_path);
        return okResult('vm_put_file', { transferred: true, remote_path }, start);
      } catch (e) {
        return errorResult('vm_put_file', toVmError(e, 'vm_put_file'), start);
      }
    },
  );

  server.registerTool(
    'vm_get_file',
    {
      title: 'Copy a file out of the VM',
      description: 'Copy a file from the VM to a host path via the adapter\'s transport. The lease reaper keeps the artifact alive while the copy is in flight.',
      inputSchema: z.object({
        vm_id: z.string(),
        remote_path: z.string().describe('Path inside the VM'),
        local_path: z.string().describe('Absolute host destination path'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ vm_id, remote_path, local_path }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_get_file');
        if (!adapter.getFile) {
          throw vmError('CAPABILITY_UNAVAILABLE', `adapter "${adapter.id}" has no get_file transport (files: ${adapter.capability.files.join(', ') || 'none'})`);
        }
        await adapter.getFile(vm, remote_path, local_path);
        return okResult('vm_get_file', { transferred: true, local_path }, start);
      } catch (e) {
        return errorResult('vm_get_file', toVmError(e, 'vm_get_file'), start);
      }
    },
  );

  server.registerTool(
    'vm_clone_repo',
    {
      title: 'Clone a repository inside the VM',
      description: 'Clone a git repository inside the VM to dest_path, using the VM\'s own git + credentials. Only VMs with a file/exec transport support this.',
      inputSchema: z.object({
        vm_id: z.string(),
        repo_url: z.string().describe('git clone URL'),
        dest_path: z.string().describe('Destination directory inside the VM'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ vm_id, repo_url, dest_path }) => {
      const start = Date.now();
      try {
        const vm = await vmOf(deps, vm_id);
        const adapter = await adapterFor(deps, vm, 'vm_clone_repo');
        if (!adapter.cloneRepo) {
          throw vmError('CAPABILITY_UNAVAILABLE', `adapter "${adapter.id}" has no clone_repo path`);
        }
        await adapter.cloneRepo(vm, repo_url, dest_path);
        return okResult('vm_clone_repo', { cloned: true, repo_url, dest_path }, start);
      } catch (e) {
        return errorResult('vm_clone_repo', toVmError(e, 'vm_clone_repo'), start);
      }
    },
  );
}
