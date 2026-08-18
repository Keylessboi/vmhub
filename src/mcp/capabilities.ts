/**
 * vmhub-mcp capability matrix — the single machine-readable contract surface.
 *
 * - TOOL_CAPABILITY maps every vm_* tool to the CapabilityId it requires.
 * - The template catalog is DERIVED from the adapter registry (adapters are
 *   the only component that knows their capabilities), so a new OS adapter
 *   automatically appears in vm_list_templates with honest availability.
 * - Gating is a runtime assertion: tools are NEVER absent from the server;
 *   an unsupported call returns a typed CAPABILITY_UNAVAILABLE VmError.
 */
import type { Capability, CapabilityId, DesktopAdapter, Template, TemplateConstraint, VmError, WindowingSystem } from '../shared/types.ts';
import { CAPABILITIES } from '../shared/types.ts';
import type { AdapterRegistry } from '../../adapters/index.ts';
import { vmError } from './errors.ts';

/** The 22 vm_* tools, in registration order (also the doc order). */
export const VM_TOOLS = [
  'vm_list_templates',
  'vm_capabilities',
  'vm_health',
  'vm_lease_create',
  'vm_lease_status',
  'vm_lease_renew',
  'vm_lease_release',
  'vm_screenshot',
  'vm_inspect',
  'vm_list_windows',
  'vm_click',
  'vm_type',
  'vm_key',
  'vm_paste',
  'vm_drag',
  'vm_launch',
  'vm_focus',
  'vm_close',
  'vm_dispatch',
  'vm_put_file',
  'vm_get_file',
  'vm_clone_repo',
] as const;

export type VmToolName = (typeof VM_TOOLS)[number];

/** Which capability each vm_* tool requires. Infra tools (lease/catalog) are ungated. */
export const TOOL_CAPABILITY: Record<VmToolName, CapabilityId | null> = {
  vm_list_templates: null,
  vm_capabilities: null,
  vm_health: null,
  vm_lease_create: null,
  vm_lease_status: null,
  vm_lease_renew: null,
  vm_lease_release: null,
  vm_screenshot: CAPABILITIES.screenshot,
  vm_inspect: CAPABILITIES.inspect,
  vm_list_windows: CAPABILITIES.listWindows,
  vm_click: CAPABILITIES.click,
  vm_type: CAPABILITIES.type,
  vm_key: CAPABILITIES.key,
  vm_paste: CAPABILITIES.paste,
  vm_drag: CAPABILITIES.drag,
  vm_launch: CAPABILITIES.launch,
  vm_focus: CAPABILITIES.focus,
  vm_close: CAPABILITIES.close,
  vm_dispatch: CAPABILITIES.dispatch,
  vm_put_file: CAPABILITIES.putFile,
  vm_get_file: CAPABILITIES.getFile,
  vm_clone_repo: CAPABILITIES.cloneRepo,
};

/** Capabilities the 22-tool surface can actually serve. */
export const TOOL_SURFACE: ReadonlySet<CapabilityId> = new Set(
  Object.values(TOOL_CAPABILITY).filter((c): c is CapabilityId => c !== null),
);

/** Reverse map: capability → tools that require it. */
export const CAPABILITY_TOOLS: Record<string, VmToolName[]> = Object.entries(TOOL_CAPABILITY).reduce(
  (acc, [tool, cap]) => {
    if (cap !== null) {
      (acc[cap] ??= []).push(tool as VmToolName);
    }
    return acc;
  },
  {} as Record<string, VmToolName[]>,
);

export function toolRequiresCapability(tool: VmToolName): CapabilityId | null {
  return TOOL_CAPABILITY[tool] ?? null;
}

/**
 * Runtime gating — the ONLY place unsupported capability turns into an error.
 * Never removes the tool from the server; the agent always sees the tool and
 * a typed CAPABILITY_UNAVAILABLE reason.
 */
export function assertToolAvailable(tool: VmToolName, adapter: DesktopAdapter): void {
  const required = toolRequiresCapability(tool);
  if (required === null) return;
  const available = adapter.availableTools();
  if (available.includes(required)) return;
  throw vmError(
    'CAPABILITY_UNAVAILABLE',
    `${tool} requires capability "${required}", which adapter "${adapter.id}" does not provide (available: ${available.join(', ') || 'none'})`,
    `Template "${adapter.id}" is not capable of this operation; pick a template from vm_list_templates that lists "${required}"`,
  );
}

// ---------------------------------------------------------------------------
// Template catalog (pre-create capability query)
// ---------------------------------------------------------------------------

interface TemplateMeta {
  ramMb: number;
  vcpus: number;
  nestedVirt: boolean;
  notes?: string;
}

/** Resource hints per adapter. Matrix metadata, not part of the machine contract. */
const TEMPLATE_META: Record<string, TemplateMeta> = {
  hyprland: { ramMb: 4096, vcpus: 2, nestedVirt: false, notes: 'Hyprland desktop VM (golden hyprland-2404).' },
  x11: { ramMb: 4096, vcpus: 2, nestedVirt: false, notes: 'X11 desktop VM (golden x11-2404) via computer-use-linux.' },
  headless: { ramMb: 4096, vcpus: 2, nestedVirt: false, notes: 'Headless Linux golden (debian-13-golden): exec/SSH only, no display tools.' },
  windows: { ramMb: 8192, vcpus: 4, nestedVirt: true, notes: 'Windows desktop VM via in-VM CursorTouch (golden windows-11-24h2).' },
  android: { ramMb: 4096, vcpus: 2, nestedVirt: true, notes: 'Android via host-side ADB (golden android-9-golden).' },
};

/** Production-real adapters: the live goldens. */
const AVAILABLE_ADAPTERS: ReadonlySet<string> = new Set(['hyprland', 'x11', 'headless', 'windows', 'android']);

/** availability reason text for stub adapters — never hidden from agents. */
function stubReason(adapterId: string, os: WindowingSystem): string {
  return `"${adapterId}" adapter is a mock for the E2E demo; the real ${os} driver lands in Phase 3. VM operations succeed against fake state — do not trust results.`;
}

/** Adapter-declared template metadata beyond the capability (optional). */
interface AdapterTemplateExtras {
  derivedFrom?: string;
  templateConstraints?: TemplateConstraint[];
  /** Local-matrix availability override (conditional adapters). */
  localAvailability?: Template['availability'];
  availabilityReason?: string;
}

function adapterExtras(adapter: DesktopAdapter): AdapterTemplateExtras {
  const a = adapter as DesktopAdapter & AdapterTemplateExtras;
  return {
    derivedFrom: a.derivedFrom,
    templateConstraints: a.templateConstraints,
    localAvailability: a.localAvailability,
    availabilityReason: a.availabilityReason,
  };
}

/**
 * Derive a Template from an adapter. capabilities = what the 22-tool surface
 * can serve on this adapter (the honest full declaration stays on the
 * adapter's Capability, visible via vm_capabilities). derivedFrom/constraints
 * declared by the adapter are surfaced so derived templates and node affinity
 * are visible before creation.
 */
export function templateFromAdapter(adapter: DesktopAdapter): Template {
  const meta = TEMPLATE_META[adapter.id] ?? { ramMb: 2048, vcpus: 2, nestedVirt: false };
  const extras = adapterExtras(adapter);
  const capabilities = adapter
    .availableTools()
    .filter((c) => TOOL_SURFACE.has(c))
    .sort();
  const availability = extras.localAvailability ?? (AVAILABLE_ADAPTERS.has(adapter.id) ? 'available' : 'stub');
  return {
    id: adapter.id,
    os: adapter.capability.os,
    availability,
    ...(availability !== 'available' ? { reason: extras.availabilityReason ?? stubReason(adapter.id, adapter.capability.os) } : {}),
    capabilities,
    ramMb: meta.ramMb,
    vcpus: meta.vcpus,
    nestedVirt: meta.nestedVirt,
    ...(extras.derivedFrom ? { derivedFrom: extras.derivedFrom } : {}),
    ...(extras.templateConstraints && extras.templateConstraints.length > 0 ? { constraints: extras.templateConstraints } : {}),
    ...(meta.notes ? { notes: meta.notes } : {}),
  };
}

/**
 * Merge a derived template against the live catalog: it resolves through
 * its PARENT golden.
 */
export function mergeDerivedTemplate(local: Template, real: Template[]): Template {
  const parent = real.find((r) => r.os === local.derivedFrom);
  if (!parent) {
    return {
      ...local,
      availability: 'unavailable',
      reason: `no "${local.derivedFrom}" golden on Proxmox — "${local.id}" runs inside a ${local.derivedFrom} guest`,
    };
  }
  if (parent.availability !== 'available') {
    return {
      ...local,
      availability: 'unavailable',
      reason: `parent ${local.derivedFrom} golden "${parent.id}" is not available (${parent.availability})`,
    };
  }
  const { reason: _dropped, ...rest } = local;
  return { ...rest, availability: 'available', notes: `${local.notes ?? ''} Runs inside ${local.derivedFrom} golden ${parent.id}` };
}

/** Full catalog for vm_list_templates. */
export function templateCatalog(registry: AdapterRegistry): Template[] {
  return registry.ids().map((id) => templateFromAdapter(registry.get(id)));
}

export function getTemplate(registry: AdapterRegistry, templateId: string): Template {
  if (!registry.has(templateId)) {
    throw vmError('NOT_FOUND', `unknown template "${templateId}"`, `known templates: ${registry.ids().join(', ')}`);
  }
  return templateFromAdapter(registry.get(templateId));
}

/** Runtime capability query for vm_capabilities {id}. */
export function capabilityReport(adapter: DesktopAdapter): {
  adapter: string;
  os: WindowingSystem;
  capability: Capability;
  availableTools: CapabilityId[];
} {
  return {
    adapter: adapter.id,
    os: adapter.capability.os,
    capability: adapter.capability,
    availableTools: adapter.availableTools(),
  };
}

/** Typed guard used by handlers that resolve a VM to its adapter. */
export function capabilityError(required: CapabilityId, adapterId: string): VmError {
  return vmError(
    'CAPABILITY_UNAVAILABLE',
    `adapter "${adapterId}" does not provide capability "${required}"`,
  );
}
