/**
 * Per-OS template capability map — the lite catalog's single source of truth.
 *
 * The adapter registry already knows exactly what tools each OS family can
 * serve (adapter.availableTools()); hardcoding a parallel table here would
 * silently drift. Instead we DERIVE from the adapters at module load: the map
 * below is structurally identical to the adapters by construction, so the
 * drift guard (capabilities.test.ts / proxmox-real.test.ts) can never catch a
 * mismatch that did not already exist in the adapters themselves.
 *
 * Key = adapter id, which equals the OS family for every adapter in the
 * default registry (x11/hyprland/headless/windows/android/macos/ios — verified
 * against osFromTemplateName's outputs). Unknown OS → [] (honest: no adapter,
 * no capabilities).
 */
import type { CapabilityId } from './types.ts';
import { defaultRegistry } from '../../adapters/index.ts';

const registry = defaultRegistry();

/** CapabilityId[] per adapter id, snapshotted at module load. */
const OS_CAPABILITIES: Map<string, CapabilityId[]> = new Map(
  registry.ids().map((id) => [id, [...registry.get(id).availableTools()]]),
);

/**
 * The template capability surface for an OS family — exactly what its adapter
 * serves. Unknown OS families advertise nothing.
 */
export function osCapabilities(os: string): CapabilityId[] {
  return [...(OS_CAPABILITIES.get(os) ?? [])];
}
