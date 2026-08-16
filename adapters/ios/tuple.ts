/**
 * iOS availability tuple — the version-locked macos↔ios pairing.
 *
 * An iOS Simulator is drivable only inside the macOS golden that was baked
 * WITH the paired runtime. Per the frozen triple (golden-pins.json):
 * macos sequoia-15.7.9 ↔ Xcode 26.3 ↔ iOS 26.3.1 runtime (23D8133). The
 * golden version is read from the template id/notes; the runtime presence is
 * implied by that exact version (the golden factory baked it) unless the
 * template declares a runtime constraint naming the pair.
 */
import type { Template } from '../../src/shared/types.ts';

/** Frozen macOS↔iOS version pair (golden-pins.json: sequoia-15.7.9 / Xcode 26.3 / iOS 26.3.1). */
export const IOS_MACOS_TUPLE = {
  macosVersion: '15.7.9',
  macosGoldenId: 'macos-sequoia-15.7.9',
  iosRuntime: '26.3.1',
  iosRuntimeBuild: '23D8133',
  xcodeBuild: '26.3',
} as const;

/** macOS version from a template id/notes ("macos-sequoia-15.7.9" → "15.7.9"). */
export function macosGoldenVersion(t: Pick<Template, 'id' | 'notes'>): string | undefined {
  const hay = `${t.id} ${t.notes ?? ''}`;
  const sequoia = hay.match(/sequoia-(\d+(?:\.\d+)*)/i)?.[1];
  if (sequoia) return sequoia;
  return hay.match(/(?:macos|mac)-(\d+(?:\.\d+)*)/i)?.[1];
}

export interface IosTupleResult {
  ok: boolean;
  /** Pairing label when ok, reason otherwise. */
  label?: string;
  reason?: string;
}

/**
 * The version-locked availability tuple:
 *   parent macOS golden present ∧ paired runtime present ∧ version match.
 */
export function iosTupleAvailability(parent: Template | undefined): IosTupleResult {
  if (!parent) {
    return { ok: false, reason: 'no active macOS golden — the iOS Simulator runs inside the macOS guest' };
  }
  if (parent.availability !== 'available') {
    return { ok: false, reason: `parent macOS golden "${parent.id}" is not available (${parent.availability})` };
  }
  const version = macosGoldenVersion(parent);
  if (!version) {
    return { ok: false, reason: `cannot determine the macOS version of golden "${parent.id}" — the iOS ${IOS_MACOS_TUPLE.iosRuntime} runtime pairing is unknown` };
  }
  if (version !== IOS_MACOS_TUPLE.macosVersion) {
    return {
      ok: false,
      reason: `macOS golden "${parent.id}" is ${version} — the iOS ${IOS_MACOS_TUPLE.iosRuntime} runtime is paired with macOS ${IOS_MACOS_TUPLE.macosVersion}`,
    };
  }
  if (!parentCarriesRuntime(parent)) {
    return {
      ok: false,
      reason: `macOS golden "${parent.id}" does not declare the version-paired iOS ${IOS_MACOS_TUPLE.iosRuntime} (${IOS_MACOS_TUPLE.iosRuntimeBuild}) runtime`,
    };
  }
  return {
    ok: true,
    label: `macos ${IOS_MACOS_TUPLE.macosVersion} ↔ iOS ${IOS_MACOS_TUPLE.iosRuntime} (${IOS_MACOS_TUPLE.iosRuntimeBuild})`,
  };
}

/** Runtime evidence: a declared constraint must name the pair; absent data = the golden carries it. */
function parentCarriesRuntime(parent: Template): boolean {
  const declared = (parent.constraints ?? []).flatMap((c) => (c.runtime ? [c.runtime] : []));
  if (declared.length === 0) return true;
  return declared.some((r) => r.includes(IOS_MACOS_TUPLE.iosRuntime) || r.includes(IOS_MACOS_TUPLE.iosRuntimeBuild));
}
