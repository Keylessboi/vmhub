/**
 * IosAdapter unit tests — pure logic + fake transport only (no live macOS
 * guest, no live simctl/idb): tuple availability, derivedFrom resolution,
 * capability ladder (v1 simctl fallback), argv construction, and tool calls
 * through a fake SSH runner. Live behavior is exercised e2e against the
 * sequoia-15.7.9 golden, not here.
 */
import { describe, expect, it } from 'vitest';
import type { Template, Vm } from '../../src/shared/types.ts';
import { fakePng } from '../_mock.ts';
import { IosAdapter, iosAdapter } from './index.ts';
import { IOS_MACOS_TUPLE, iosTupleAvailability, macosGoldenVersion } from './tuple.ts';
import { idbArgv, iosInputArgv, iosLadder, iosToolsForLadder, simctlArgv } from './argv.ts';
import type { SshRunner } from '../transport.ts';

const vm: Vm = {
  uuid: 'u1',
  nodeId: 'vostro',
  templateId: 'macos-sequoia-15.7.9',
  adapter: 'macos',
  capabilities: ['screenshot'],
  proxmoxTag: 'vmhub-mac-u1',
  namePrefix: 'mac',
  status: 'ready',
  ip: '10.10.10.55',
  createdAt: 0,
};

const UDID = '03423413-ED3A-44FD-AD37-E9B456938AAA';

function macosGolden(overrides: Partial<Template> = {}): Template {
  return {
    id: 'macos-sequoia-15.7.9',
    os: 'macos',
    availability: 'available',
    capabilities: ['screenshot'],
    ramMb: 8192,
    vcpus: 4,
    nestedVirt: false,
    notes: 'Golden template macos-sequoia-15.7.9',
    ...overrides,
  };
}

function fakeSsh(script: Array<{ args: string[]; stdout?: string | Buffer; exitCode?: number }>) {
  const log: string[][] = [];
  const runner: SshRunner = {
    async run(bin, args) {
      log.push([bin, ...args]);
      const step = script[log.length - 1];
      return { exitCode: step?.exitCode ?? 0, stdout: step?.stdout ?? 'ok', stderr: '' };
    },
  };
  return { runner, log };
}

describe('macosGoldenVersion extraction', () => {
  it('extracts the version from canned and real template id/notes', () => {
    expect(macosGoldenVersion({ id: 'macos-sequoia-15.7.9', notes: '' })).toBe('15.7.9');
    expect(macosGoldenVersion({ id: '2040', notes: 'Golden template macos-sequoia-15.7.9' })).toBe('15.7.9');
    expect(macosGoldenVersion({ id: 'macos-14.5', notes: '' })).toBe('14.5');
  });

  it('returns undefined when no version is present', () => {
    expect(macosGoldenVersion({ id: '2040', notes: 'Golden template macos' })).toBeUndefined();
  });
});

describe('iosTupleAvailability — the version-locked tuple', () => {
  it('is available only with an available, version-matched macos golden', () => {
    expect(iosTupleAvailability(macosGolden()).ok).toBe(true);
    expect(iosTupleAvailability(macosGolden())?.label).toContain('iOS 26.3.1');
  });

  it('requires the parent golden (not an ios golden)', () => {
    const noParent = iosTupleAvailability(undefined);
    expect(noParent.ok).toBe(false);
    expect(noParent.reason).toContain('macOS golden');
  });

  it('requires the parent to be available', () => {
    const r = iosTupleAvailability(macosGolden({ availability: 'unavailable' as const }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('unavailable');
  });

  it('requires the macos version to match the pinned 15.7.9', () => {
    const r = iosTupleAvailability(macosGolden({ id: 'macos-14.5', notes: 'Golden template macos-14.5' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('14.5');
  });

  it('rejects a parent whose runtime constraint names a different runtime', () => {
    const r = iosTupleAvailability(
      macosGolden({ constraints: [{ os: 'macos', runtime: 'ios-simctl@14.0' }] }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('runtime');
  });

  it('accepts a parent whose runtime constraint names the paired runtime', () => {
    const r = iosTupleAvailability(
      macosGolden({ constraints: [{ os: 'macos', runtime: 'ios-simctl@26.3.1' }] }),
    );
    expect(r.ok).toBe(true);
  });

  it('fails honestly when the golden version cannot be determined', () => {
    const r = iosTupleAvailability(macosGolden({ id: '2040', notes: 'Golden template macos' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cannot determine');
  });
});

describe('IosAdapter declaration', () => {
  it('is derived from macos with conditional local availability', () => {
    expect(iosAdapter.id).toBe('ios');
    expect(iosAdapter.derivedFrom).toBe('macos');
    expect(iosAdapter.localAvailability).toBe('unavailable');
    expect(iosAdapter.templateConstraints[0]).toMatchObject({ os: 'macos', minRamMb: 10_240, runtime: 'ios-simctl@26.3.1' });
  });

  it('declares the capability ladder honestly at v1', () => {
    const adapter = new IosAdapter({ env: { VMHUB_IOS_LADDER: 'v1' } });
    expect(adapter.capability.input).toEqual([]);
    expect(adapter.capability.semantic).toBe('none');
    expect(adapter.capability.exec).toBe(true);
  });

  it('upgrades the ladder at v2 (idb present)', () => {
    const adapter = new IosAdapter({ env: { VMHUB_IOS_LADDER: 'v2' } });
    expect(adapter.capability.input).toEqual(['click', 'type', 'key', 'paste', 'drag']);
    expect(adapter.capability.semantic).toBe('ax');
  });
});

describe('ios capability ladder', () => {
  it('defaults to v1 (simctl-only) without idb evidence', () => {
    expect(iosLadder({})).toBe('v1');
  });

  it('v2 when idb is present or forced', () => {
    expect(iosLadder({ VMHUB_IOS_IDB: '1' })).toBe('v2');
    expect(iosLadder({ VMHUB_IOS_LADDER: 'v2' })).toBe('v2');
  });

  it('v1 tools are simctl-only (screenshot/launch/exec)', () => {
    const tools = iosToolsForLadder('v1');
    expect(tools).toContain('screenshot');
    expect(tools).not.toContain('inspect');
    expect(tools).not.toContain('click');
  });

  it('v2 adds idb HID input and AX inspection', () => {
    const tools = iosToolsForLadder('v2');
    for (const t of ['screenshot', 'inspect', 'list_windows', 'click', 'type', 'key', 'paste', 'drag']) {
      expect(tools).toContain(t);
    }
  });
});

describe('simctl/idb argv construction', () => {
  it('builds simctl argv with the udid (io screenshot -)', () => {
    expect(simctlArgv(UDID, 'io', ['screenshot', '-'])).toEqual(['xcrun', 'simctl', 'io', UDID, 'screenshot', '-']);
    expect(simctlArgv(UDID, 'launch', ['com.apple.Safari'])).toEqual(['xcrun', 'simctl', 'launch', UDID, 'com.apple.Safari']);
  });

  it('omits the udid for list', () => {
    expect(simctlArgv('', 'list', ['devices', 'booted'])).toEqual(['xcrun', 'simctl', 'list', 'devices', 'booted']);
  });

  it('builds idb ui argv', () => {
    expect(idbArgv(UDID, 'tap', ['10', '20'])).toEqual(['idb', '--udid', UDID, 'ui', 'tap', '10', '20']);
    expect(idbArgv(UDID, 'describe-all', [])).toEqual(['idb', '--udid', UDID, 'ui', 'describe-all']);
  });

  it('maps input actions onto idb at v2 and null at v1', () => {
    expect(iosInputArgv('v2', UDID, { kind: 'click', x: 1, y: 2 })).toEqual(['idb', '--udid', UDID, 'ui', 'tap', '1', '2']);
    expect(iosInputArgv('v2', UDID, { kind: 'type', text: 'hi' })).toEqual(['idb', '--udid', UDID, 'ui', 'text', 'hi']);
    expect(iosInputArgv('v2', UDID, { kind: 'paste', text: 'héllo' })).toEqual(['idb', '--udid', UDID, 'ui', 'text', 'héllo']);
    expect(iosInputArgv('v2', UDID, { kind: 'key', chord: 'home' })).toEqual(['idb', '--udid', UDID, 'ui', 'key', 'home']);
    expect(iosInputArgv('v2', UDID, { kind: 'drag', from: { x: 0, y: 0 }, to: { x: 5, y: 5 } })).toEqual(['idb', '--udid', UDID, 'ui', 'swipe', '0', '0', '5', '5']);
    expect(iosInputArgv('v1', UDID, { kind: 'click', x: 1, y: 2 })).toBeNull();
    expect(iosInputArgv('v2', UDID, { kind: 'gesture', type: 'tap', x: 0, y: 0 })).toBeNull();
  });
});

describe('IosAdapter tool calls (fake ssh runner)', () => {
  it('screenshot runs simctl io screenshot - and returns the PNG buffer', async () => {
    const png = fakePng(64, 48, [5, 5, 5]);
    const { runner, log } = fakeSsh([{ args: [], stdout: png }]);
    const adapter = new IosAdapter({ ssh: runner, env: { VMHUB_IOS_UDID: UDID } });
    const shot = await adapter.screenshot(vm);
    expect(shot.format).toBe('png');
    expect(log[0]?.slice(-6)).toEqual(['xcrun', 'simctl', 'io', UDID, 'screenshot', '-']);
    expect(shot.image).toEqual(png);
  });

  it('discovers the booted device when the udid is not pinned', async () => {
    const { runner, log } = fakeSsh([{ args: [], stdout: `Probe iPhone (${UDID}) (Booted)` }, { args: [], stdout: 'png' }]);
    const adapter = new IosAdapter({ ssh: runner });
    await adapter.screenshot(vm);
    expect(log[0]).toEqual(['ssh', '-T', '-o', 'StrictHostKeyChecking=no', '-o', 'ProxyJump=root@192.168.1.220', 'vmhub@10.10.10.55', 'xcrun', 'simctl', 'list', 'devices', 'booted']);
    expect(log[1]?.slice(-6)).toEqual(['xcrun', 'simctl', 'io', UDID, 'screenshot', '-']);
  });

  it('input at v1 throws CAPABILITY_UNAVAILABLE (simctl has no HID)', async () => {
    const { runner } = fakeSsh([]);
    const adapter = new IosAdapter({ ssh: runner, env: { VMHUB_IOS_LADDER: 'v1', VMHUB_IOS_UDID: UDID } });
    try {
      await adapter.input(vm, { kind: 'click', x: 1, y: 2 });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    }
  });

  it('input at v2 runs idb tap', async () => {
    const { runner, log } = fakeSsh([{ args: [] }]);
    const adapter = new IosAdapter({ ssh: runner, env: { VMHUB_IOS_LADDER: 'v2', VMHUB_IOS_UDID: UDID } });
    await adapter.input(vm, { kind: 'click', x: 10, y: 20 });
    expect(log[0]?.slice(-7)).toEqual(['idb', '--udid', UDID, 'ui', 'tap', '10', '20']);
  });

  it('inspect at v1 is unavailable, at v2 parses the AX tree', async () => {
    const v1 = new IosAdapter({ ssh: fakeSsh([]).runner, env: { VMHUB_IOS_LADDER: 'v1', VMHUB_IOS_UDID: UDID } });
    await expect(v1.inspect(vm)).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });

    const ax = { role: 'window', label: 'Settings', frame: { x: 0, y: 0, width: 390, height: 844 }, children: [{ role: 'button', label: 'Done' }] };
    const { runner, log } = fakeSsh([{ args: [], stdout: JSON.stringify(ax) }]);
    const v2 = new IosAdapter({ ssh: runner, env: { VMHUB_IOS_LADDER: 'v2', VMHUB_IOS_UDID: UDID } });
    const tree = await v2.inspect(vm);
    expect(log[0]?.slice(-5)).toEqual(['idb', '--udid', UDID, 'ui', 'describe-all']);
    expect(tree.role).toBe('window');
    expect(tree.name).toBe('Settings');
    expect(tree.children[0]).toMatchObject({ role: 'button', name: 'Done' });
  });

  it('listWindows at v2 maps describe-all top-level elements', async () => {
    const payload = { windows: [{ id: '1', title: 'SpringBoard', frame: { x: 0, y: 0, width: 390, height: 844 }, focused: true }] };
    const { runner } = fakeSsh([{ args: [], stdout: JSON.stringify(payload) }]);
    const adapter = new IosAdapter({ ssh: runner, env: { VMHUB_IOS_LADDER: 'v2', VMHUB_IOS_UDID: UDID } });
    const windows = await adapter.listWindows(vm, 'board');
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ id: '1', title: 'SpringBoard', focused: true });
  });

  it('exec runs through the parent macos ssh transport', async () => {
    const { runner, log } = fakeSsh([{ args: [], stdout: '26.3.1' }]);
    const adapter = new IosAdapter({ ssh: runner });
    const res = await adapter.exec(vm, 'xcrun', ['simctl', 'list', 'runtimes']);
    expect(res.stdout).toBe('26.3.1');
    expect(log[0]?.slice(1, 6)).toEqual(['-T', '-o', 'StrictHostKeyChecking=no', '-o', 'ProxyJump=root@192.168.1.220']);
    expect(log[0]?.slice(6)).toEqual(['vmhub@10.10.10.55', 'xcrun', 'simctl', 'list', 'runtimes']);
  });

  it('dispatch launch/install run simctl with the resolved udid', async () => {
    const { runner, log } = fakeSsh([{ args: [] }, { args: [] }]);
    const adapter = new IosAdapter({ ssh: runner, env: { VMHUB_IOS_UDID: UDID } });
    await adapter.dispatch(vm, 'install', { path: '/tmp/app.app' });
    await adapter.dispatch(vm, 'launch', { bundle: 'com.apple.Safari' });
    expect(log[0]?.slice(-5)).toEqual(['xcrun', 'simctl', 'install', UDID, '/tmp/app.app']);
    expect(log[1]?.slice(-5)).toEqual(['xcrun', 'simctl', 'launch', UDID, 'com.apple.Safari']);
  });

  it('health reports the two channels independently', async () => {
    const { runner } = fakeSsh([{ args: [], stdout: `(${UDID}) (Booted)` }, { args: [], stdout: 'boom', exitCode: 1 }]);
    const adapter = new IosAdapter({ ssh: runner, env: { VMHUB_IOS_LADDER: 'v2' } });
    const health = await adapter.health(vm);
    expect(health.simctlScreenshot).toBe('ok');
    expect(health.idbAx).toBe('degraded');
  });

  it('exposes the frozen tuple version pairing', () => {
    expect(IOS_MACOS_TUPLE.macosVersion).toBe('15.7.9');
    expect(IOS_MACOS_TUPLE.iosRuntime).toBe('26.3.1');
    expect(IOS_MACOS_TUPLE.iosRuntimeBuild).toBe('23D8133');
  });
});
