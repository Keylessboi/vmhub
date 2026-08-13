/**
 * iOS adapter — honest stub. There is no remote-control path for iOS yet
 * (no in-VM agent, no host-side transport). capabilities: [] — the template
 * catalog exposes it with an empty capability list and a reason; every vm_*
 * call returns typed CAPABILITY_UNAVAILABLE.
 */
import type { CapabilityId, DesktopAdapter, InputAction, SemanticElement, Vm, WindowInfo } from '../../src/shared/types.ts';
import { vmError } from '../../src/mcp/errors.ts';

const UNAVAILABLE = () => {
  throw vmError(
    'CAPABILITY_UNAVAILABLE',
    'adapter "ios": no remote-control path exists — iOS VMs cannot be driven',
    'The iOS adapter is a stub with capabilities: []. Pick a template from vm_list_templates that lists the capability you need.',
  );
};

export const iosAdapter: DesktopAdapter = {
  id: 'ios',
  capability: {
    adapter: 'ios',
    os: 'ios',
    windowing: [],
    input: [],
    semantic: 'none',
    files: [],
    exec: false,
    notes: 'Stub: no remote-control path for iOS yet.',
  },
  availableTools(): CapabilityId[] {
    return [];
  },
  screenshot: UNAVAILABLE,
  input(_vm: Vm, _action: InputAction): Promise<void> {
    return UNAVAILABLE();
  },
  listWindows(_vm: Vm): Promise<WindowInfo[]> {
    return UNAVAILABLE();
  },
  inspect(_vm: Vm): Promise<SemanticElement> {
    return UNAVAILABLE();
  },
  exec: UNAVAILABLE,
};
