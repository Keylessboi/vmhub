/**
 * MacosAdapter unit tests — pure logic + fake transport only (no live
 * mac-control-mcp server, no live SSH): capability declaration, command
 * construction, MCP tool dispatch through a fake client, SSH exec/scp/git
 * argv through a fake runner, and error mapping. Live behavior is exercised
 * e2e against the sequoia-15.7.9 golden, not here.
 */
import { describe, expect, it } from 'vitest';
import type { Vm } from '../../src/shared/types.ts';
import { fakePng } from '../_mock.ts';
import { MacosAdapter, MACOS_TOOL_MAP } from './index.ts';
import { IN_VM_LAUNCHER } from './mcp.ts';
import { macosSshArgs, macosSshUser, scpIntoMacosArgs, gitCloneIntoMacosArgs } from './ssh.ts';
import { firstMacosText, mapMacosError, parseMacosPayload, parseMacosScreenshot, parseMacosWindows, parseMacosTree, type MacosMcpClient } from './mcp.ts';
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

function fakeClient(respond: (name: string, args: Record<string, unknown>) => { isError?: boolean; content?: unknown[]; structuredContent?: unknown }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: MacosMcpClient = {
    async callTool(input) {
      calls.push({ name: input.name, args: input.arguments });
      const r = respond(input.name, input.arguments);
      return { isError: r.isError ?? false, content: r.content ?? [], structuredContent: r.structuredContent };
    },
  };
  return { client, calls };
}

function fakeSsh(log: Array<{ bin: string; args: string[] }>): SshRunner {
  return {
    async run(bin, args) {
      log.push({ bin, args });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  };
}

const okResult = { ok: true, result: {} };

describe('MacosAdapter capability declaration', () => {
  const adapter = new MacosAdapter();

  it('declares the macos adapter id and os', () => {
    expect(adapter.id).toBe('macos');
    expect(adapter.capability.os).toBe('macos');
    expect(adapter.capability.windowing).toEqual(['macos']);
  });

  it('declares full input + AX semantic + scp files + exec', () => {
    expect(adapter.capability.input).toEqual(['click', 'type', 'key', 'paste', 'drag']);
    expect(adapter.capability.semantic).toBe('ax');
    expect(adapter.capability.files).toEqual(['scp']);
    expect(adapter.capability.exec).toBe(true);
  });

  it('notes the mac-control-mcp transport', () => {
    expect(adapter.capability.notes).toContain('mac-control-mcp');
  });
});

describe('MacosAdapter availableTools', () => {
  it('serves the full desktop + ssh file surface', () => {
    const tools = new MacosAdapter().availableTools();
    for (const t of ['screenshot', 'inspect', 'list_windows', 'click', 'type', 'key', 'paste', 'drag', 'launch', 'focus', 'close', 'dispatch', 'exec', 'put_file', 'get_file', 'clone_repo']) {
      expect(tools).toContain(t);
    }
  });
});

describe('MacosAdapter constants', () => {
  it('uses the in-VM launcher path from the golden', () => {
    expect(IN_VM_LAUNCHER).toBe('/usr/local/bin/launch-macos-mcp');
  });

  it('maps vm_* ops to mac-control-mcp tools', () => {
    expect(MACOS_TOOL_MAP.screenshot).toBe('screenshot');
    expect(MACOS_TOOL_MAP.inspect).toBe('inspect');
    expect(MACOS_TOOL_MAP.click).toBe('click');
    expect(MACOS_TOOL_MAP.paste).toBe('paste');
    expect(MACOS_TOOL_MAP.launch).toBe('launch');
  });
});

describe('macos SSH channel construction', () => {
  it('defaults the guest user to vmhub (probe evidence)', () => {
    expect(macosSshUser({})).toBe('vmhub');
  });

  it('honors VMHUB_MACOS_SSH_USER and VMHUB_SSH_USER', () => {
    expect(macosSshUser({ VMHUB_MACOS_SSH_USER: 'ops' })).toBe('ops');
    expect(macosSshUser({ VMHUB_SSH_USER: 'root' })).toBe('root');
  });

  it('builds ssh argv with the macos user and ProxyJump', () => {
    const args = macosSshArgs(vm, {});
    expect(args).toEqual(['-T', '-o', 'StrictHostKeyChecking=no', '-o', 'ProxyJump=root@192.168.1.220', 'vmhub@10.10.10.55']);
  });

  it('builds scp argv for put and get', () => {
    const put = scpIntoMacosArgs(vm, '/local/a.txt', '/Users/vmhub/a.txt', 'put', {});
    expect(put).toEqual(['-o', 'StrictHostKeyChecking=no', '-o', 'ProxyJump=root@192.168.1.220', '/local/a.txt', 'vmhub@10.10.10.55:/Users/vmhub/a.txt']);
    const get = scpIntoMacosArgs(vm, '/local/b.txt', '/Users/vmhub/b.txt', 'get', {});
    expect(get).toEqual(['-o', 'StrictHostKeyChecking=no', '-o', 'ProxyJump=root@192.168.1.220', 'vmhub@10.10.10.55:/Users/vmhub/b.txt', '/local/b.txt']);
  });

  it('builds ssh git clone argv', () => {
    const args = gitCloneIntoMacosArgs(vm, 'https://github.com/a/b.git', '/Users/vmhub/repo', {});
    expect(args.slice(-6)).toEqual(['vmhub@10.10.10.55', 'git', 'clone', '--', 'https://github.com/a/b.git', '/Users/vmhub/repo']);
  });
});

describe('MacosAdapter tool dispatch (fake client)', () => {
  it('screenshot calls the agent screenshot tool and returns the image', async () => {
    const png = fakePng(64, 48, [1, 2, 3]);
    const { client } = fakeClient((name, args) => {
      expect(name).toBe('screenshot');
      return { structuredContent: okResult, content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
    });
    const adapter = new MacosAdapter({ clientFactory: () => client });
    const shot = await adapter.screenshot(vm);
    expect(shot.format).toBe('png');
    expect(shot.width).toBe(64);
    expect(shot.height).toBe(48);
    expect(shot.image.length).toBeGreaterThan(0);
  });

  it('maps each input action onto the agent tool', async () => {
    const { client, calls } = fakeClient(() => ({ structuredContent: okResult }));
    const adapter = new MacosAdapter({ clientFactory: () => client });
    await adapter.input(vm, { kind: 'click', x: 10, y: 20 });
    await adapter.input(vm, { kind: 'type', text: 'hi' });
    await adapter.input(vm, { kind: 'key', chord: 'cmd+shift+4' });
    await adapter.input(vm, { kind: 'paste', text: 'héllo' });
    await adapter.input(vm, { kind: 'drag', from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
    expect(calls.map((c) => c.name)).toEqual(['click', 'type', 'key', 'paste', 'drag']);
    expect(calls[0]?.args).toMatchObject({ x: 10, y: 20, button: 'left' });
    expect(calls[2]?.args).toEqual({ chord: 'cmd+shift+4' });
    expect(calls[3]?.args).toEqual({ text: 'héllo' });
  });

  it('listWindows parses the agent payload and applies the filter', async () => {
    const { client } = fakeClient(() => ({
      structuredContent: {
        ok: true,
        result: {
          windows: [
            { id: '1', title: 'Finder', frame: { x: 0, y: 0, width: 800, height: 600 }, focused: true },
            { id: '2', title: 'Terminal', frame: { x: 10, y: 10, width: 640, height: 400 } },
          ],
        },
      },
    }));
    const adapter = new MacosAdapter({ clientFactory: () => client });
    const all = await adapter.listWindows(vm);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ id: '1', title: 'Finder', focused: true });
    const filtered = await adapter.listWindows(vm, 'term');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.title).toBe('Terminal');
  });

  it('inspect returns a semantic tree from the agent payload', async () => {
    const { client } = fakeClient(() => ({
      structuredContent: {
        ok: true,
        result: {
          tree: { role: 'window', title: 'Safari', frame: { x: 0, y: 0, width: 800, height: 600 }, children: [{ role: 'button', label: 'OK' }] },
        },
      },
    }));
    const adapter = new MacosAdapter({ clientFactory: () => client });
    const tree = await adapter.inspect(vm);
    expect(tree.role).toBe('window');
    expect(tree.name).toBe('Safari');
    expect(tree.children[0]).toMatchObject({ role: 'button', name: 'OK' });
  });

  it('dispatch health reports the two channels independently', async () => {
    const { client } = fakeClient((name) => {
      if (name === 'screenshot') return { isError: true, content: [{ type: 'text', text: 'boom' }] };
      return { structuredContent: okResult };
    });
    const adapter = new MacosAdapter({ clientFactory: () => client });
    const health = await adapter.dispatch(vm, 'health', {});
    expect(health).toEqual({ screenshot: 'degraded', inspect: 'ok', transport: 'ok' });
  });

  it('maps isError responses to a typed INTERNAL VmError', async () => {
    const { client } = fakeClient(() => ({ isError: true, content: [{ type: 'text', text: 'agent exploded' }] }));
    const adapter = new MacosAdapter({ clientFactory: () => client });
    try {
      await adapter.screenshot(vm);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'INTERNAL' });
      expect(String((e as { message?: string }).message)).toContain('agent exploded');
    }
  });
});

describe('MacosAdapter ssh channel (fake runner)', () => {
  it('exec runs ssh with the macos argv', async () => {
    const log: Array<{ bin: string; args: string[] }> = [];
    const adapter = new MacosAdapter({ ssh: fakeSsh(log) });
    const res = await adapter.exec(vm, 'sw_vers', ['-productVersion']);
    expect(res.exitCode).toBe(0);
    expect(log).toHaveLength(1);
    expect(log[0]?.bin).toBe('ssh');
    expect(log[0]?.args.slice(-2)).toEqual(['sw_vers', '-productVersion']);
  });

  it('putFile / getFile run scp with the right direction', async () => {
    const log: Array<{ bin: string; args: string[] }> = [];
    const adapter = new MacosAdapter({ ssh: fakeSsh(log) });
    await adapter.putFile(vm, '/local/a', '/Users/vmhub/a');
    await adapter.getFile(vm, '/Users/vmhub/b', '/local/b');
    expect(log.map((l) => l.bin)).toEqual(['scp', 'scp']);
    expect(log[0]?.args.indexOf('/local/a')).toBeGreaterThanOrEqual(0);
    expect(log[1]?.args.indexOf('/local/b')).toBeGreaterThanOrEqual(0);
  });

  it('cloneRepo runs ssh git clone', async () => {
    const log: Array<{ bin: string; args: string[] }> = [];
    const adapter = new MacosAdapter({ ssh: fakeSsh(log) });
    await adapter.cloneRepo(vm, 'https://github.com/a/b.git', '/Users/vmhub/repo');
    expect(log[0]?.args.slice(-6)).toEqual(['vmhub@10.10.10.55', 'git', 'clone', '--', 'https://github.com/a/b.git', '/Users/vmhub/repo']);
  });
});

describe('macos MCP helpers', () => {
  it('firstMacosText returns the text block', () => {
    expect(firstMacosText([{ type: 'text', text: 'hello' }])).toBe('hello');
    expect(firstMacosText([{ type: 'image', data: 'x' }])).toBeUndefined();
  });

  it('parseMacosPayload prefers structuredContent, falls back to JSON text', () => {
    expect(parseMacosPayload({ ok: true }, [])).toEqual({ ok: true });
    expect(parseMacosPayload(null, [{ type: 'text', text: '{"ok":false}' }])).toEqual({ ok: false });
    expect(parseMacosPayload(null, [{ type: 'text', text: 'not json' }])).toBeNull();
  });

  it('parseMacosScreenshot derives dims from the payload and the PNG header', () => {
    const png = fakePng(80, 40, [9, 9, 9]);
    const shot = parseMacosScreenshot({ result: { width: 80, height: 40 } }, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    expect(shot.width).toBe(80);
    expect(shot.height).toBe(40);
    const fromHeader = parseMacosScreenshot(null, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    expect(fromHeader.width).toBe(80);
    expect(fromHeader.height).toBe(40);
  });

  it('parseMacosWindows maps the agent window shape', () => {
    const windows = parseMacosWindows(
      { result: { windows: [{ id: '1', title: 'Finder', frame: { x: 5, y: 6, width: 7, height: 8 }, focused: true }] } },
      undefined,
    );
    expect(windows[0]).toMatchObject({ id: '1', title: 'Finder', x: 5, y: 6, width: 7, height: 8, focused: true, visible: true });
  });

  it('parseMacosTree degrades to a raw fallback when the payload has no tree', () => {
    const tree = parseMacosTree({ ok: true }, 'raw-bytes');
    expect(tree.role).toBe('screen');
    expect(tree.properties?.raw).toBe('raw-bytes');
  });

  it('mapMacosError maps not-found to NOT_FOUND and unknown to INTERNAL', () => {
    expect(mapMacosError({ ok: false, message: 'no window found' }, 'focus').code).toBe('NOT_FOUND');
    expect(mapMacosError({ ok: false, message: 'weird' }, 'click').code).toBe('INTERNAL');
    expect(mapMacosError({ ok: false, message: 'denied', hint: 'grant access' }, 'inspect').code).toBe('CAPABILITY_UNAVAILABLE');
  });
});
