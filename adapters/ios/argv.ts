/**
 * iOS driver argv — the simctl (v1) / idb (v2) capability ladder.
 *
 * v1 simctl-only: install/launch/screenshot via `xcrun simctl` — no HID
 * input, no AX tree. v2 adds idb: HID tap/type/key/swipe and `idb ui
 * describe-all` for AX. The ladder is env-determined (idb presence in the
 * golden), and every command is argv-only so the whole driver is
 * mock-testable without a live guest.
 */
import type { CapabilityId, InputAction, SemanticElement, WindowInfo } from '../../src/shared/types.ts';
import { CAPABILITIES } from '../../src/shared/types.ts';

export type IosLadder = 'v1' | 'v2';

/** Ladder from env: VMHUB_IOS_LADDER forces it; VMHUB_IOS_IDB=1 implies idb. */
export function iosLadder(env: NodeJS.ProcessEnv = process.env): IosLadder {
  const forced = env.VMHUB_IOS_LADDER;
  if (forced === 'v2' || forced === 'v1') return forced;
  return env.VMHUB_IOS_IDB === '1' ? 'v2' : 'v1';
}

/** Tool surface per ladder: v2 = v1 + idb's HID input and AX tree. */
export function iosToolsForLadder(ladder: IosLadder): CapabilityId[] {
  const v1: CapabilityId[] = [CAPABILITIES.screenshot, CAPABILITIES.launch, CAPABILITIES.exec];
  if (ladder === 'v1') return v1;
  return [
    ...v1,
    CAPABILITIES.inspect,
    CAPABILITIES.listWindows,
    CAPABILITIES.click,
    CAPABILITIES.type,
    CAPABILITIES.key,
    CAPABILITIES.paste,
    CAPABILITIES.drag,
  ];
}

/** Simulator UDID — VMHUB_IOS_UDID pins it; '' means discover at runtime. */
export function iosDeviceUdid(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_IOS_UDID ?? '';
}

/** simctl argv: `xcrun simctl <op> <udid?> <args…>` (no udid for list/runtime). */
export function simctlArgv(udid: string, op: string, rest: string[]): string[] {
  const needsUdid = !['list', 'runtime', 'create', 'delete', 'help'].includes(op);
  return ['xcrun', 'simctl', op, ...(needsUdid ? [udid, ...rest] : rest)];
}

/** idb argv: `idb --udid <udid> ui <sub> <args…>`. */
export function idbArgv(udid: string, sub: string, rest: string[]): string[] {
  return ['idb', '--udid', udid, 'ui', sub, ...rest];
}

/** Input action → argv, or null when the ladder cannot serve it. */
export function iosInputArgv(ladder: IosLadder, udid: string, action: InputAction): string[] | null {
  if (ladder !== 'v2') return null;
  switch (action.kind) {
    case 'click':
      return idbArgv(udid, 'tap', [String(action.x), String(action.y)]);
    case 'type':
    case 'paste':
      return idbArgv(udid, 'text', [action.text]);
    case 'key':
      return idbArgv(udid, 'key', [action.chord]);
    case 'drag':
      return idbArgv(udid, 'swipe', [String(action.from.x), String(action.from.y), String(action.to.x), String(action.to.y)]);
    case 'gesture':
      return null;
  }
}

// ---------------------------------------------------------------------------
// `idb ui describe-all` parsing — top-level AX windows and the semantic tree
// ---------------------------------------------------------------------------

function toNum(v: unknown): number | undefined {
  return typeof v === 'number' ? v : typeof v === 'string' ? (Number(v) || undefined) : undefined;
}

/** Top-level AX elements from describe-all → WindowInfo list. */
export function idbWindows(json: unknown, filter?: string): WindowInfo[] {
  const root = (json ?? {}) as Record<string, unknown>;
  const windows = Array.isArray(root.windows) ? root.windows : Array.isArray(root.accessibility_elements) ? root.accessibility_elements : [];
  const q = filter?.toLowerCase();
  return windows.flatMap((w): WindowInfo[] => {
    if (typeof w !== 'object' || w === null) return [];
    const n = w as Record<string, unknown>;
    const title = typeof n.label === 'string' ? n.label : typeof n.title === 'string' ? n.title : '';
    if (q && !title.toLowerCase().includes(q)) return [];
    const frame = (typeof n.frame === 'object' && n.frame !== null ? n.frame : {}) as Record<string, unknown>;
    return [
      {
        id: typeof n.id === 'string' ? n.id : typeof n.ax_id === 'string' ? n.ax_id : '',
        title,
        x: toNum(frame.x) ?? 0,
        y: toNum(frame.y) ?? 0,
        width: toNum(frame.width) ?? 0,
        height: toNum(frame.height) ?? 0,
        focused: n.focused === true,
        visible: n.visible !== false,
      },
    ];
  });
}

/** Tolerant describe-all → SemanticElement tree (role/frame/children). */
export function idbTree(node: unknown): SemanticElement | null {
  if (typeof node !== 'object' || node === null) return null;
  const n = node as Record<string, unknown>;
  const role = typeof n.role === 'string' ? n.role : typeof n.type === 'string' ? n.type : 'element';
  const name = typeof n.label === 'string' ? n.label : typeof n.title === 'string' ? n.title : '';
  const frame = (typeof n.frame === 'object' && n.frame !== null ? n.frame : {}) as Record<string, unknown>;
  const childList = Array.isArray(n.children) ? n.children : Array.isArray(n.accessibility_elements) ? n.accessibility_elements : [];
  const children = childList.map(idbTree).filter((c): c is SemanticElement => c !== null);
  const props: Record<string, string> = {};
  if (n.focused === true) props.focused = 'true';
  if (typeof n.value === 'string' && n.value !== '') props.value = n.value;
  return {
    role,
    ...(name !== '' ? { name } : {}),
    x: toNum(frame.x) ?? 0,
    y: toNum(frame.y) ?? 0,
    width: toNum(frame.width) ?? 0,
    height: toNum(frame.height) ?? 0,
    children,
    ...(Object.keys(props).length > 0 ? { properties: props } : {}),
  };
}
