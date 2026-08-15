/**
 * X11Adapter unit tests — pure logic only (no live computer-use-linux server).
 *
 * No module mocking: bun's test runner applies module mocks worker-wide,
 * which poisons the mcp server tests that share a worker with this file.
 * Instead:
 *  - planned T4a exports (X11_SESSION_ENV, vmhubExecArgs, x11CloseArgs,
 *    mapX11PayloadError) are read via namespace access and asserted as
 *    contracts — they do not exist yet, so those tests are red.
 *  - methods that route through the MCP client (dispatch doctor, error
 *    surfacing in listWindows/inspect) get a fake client by replacing the
 *    adapter's private ensureConnection on the singleton instance; the
 *    prototype method is restored in beforeEach.
 *
 * RED phase for issue #3: the exec/launch/close surface, the session-env
 * transport prefix, and error-field surfacing land in T4a; the pin guard
 * lands with the golden-refresh script change. Tests in this file fail until
 * then. The unknown-verb test is an already-green regression guard.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IN_VM_LAUNCHER, x11Adapter } from '../x11/index.ts';
import * as x11mod from '../x11/index.ts';
import { sshIntoVmArgs, sshJumpTarget, vmSshUser } from '../transport.ts';
import type { Vm } from '../../src/shared/types.ts';

/**
 * Planned T4a exports, absent today. Namespace access keeps the file loading
 * (a static missing-export import would fail the whole file) — each access
 * is undefined until T4a lands, which is the expected red state.
 */
const planned = x11mod as unknown as {
  X11_SESSION_ENV?: Record<string, string>;
  vmhubExecArgs?: (vm: Vm, cmd: string, args?: string[]) => string[];
  x11CloseArgs?: (window: string) => string[];
};

function makeVm(uuid: string): Vm {
  return {
    uuid,
    templateId: 'ubuntu-x11',
    adapter: 'x11',
    capabilities: ['screenshot'],
    proxmoxTag: `vmhub-x11-${uuid}`,
    namePrefix: 'x11',
    status: 'ready',
    ip: '10.10.10.50',
    createdAt: 0,
  };
}

describe('X11Adapter capability declaration', () => {
  it('declares the x11 adapter id and os', () => {
    expect(x11Adapter.id).toBe('x11');
    expect(x11Adapter.capability.os).toBe('x11');
    expect(x11Adapter.capability.windowing).toEqual(['x11']);
  });

  it('declares input + exec (vmhub-exec SSH helper routes exec; T4a)', () => {
    expect(x11Adapter.capability.input).toEqual(['click', 'type', 'key', 'drag']);
    expect(x11Adapter.capability.exec).toBe(true);
    expect(x11Adapter.capability.files).toEqual([]);
  });

  it('notes the transport in the capability', () => {
    expect(x11Adapter.capability.notes).toContain('computer-use-linux');
  });
});

describe('X11Adapter availableTools', () => {
  it('serves the desktop tool surface it can drive', () => {
    const tools = x11Adapter.availableTools();
    for (const t of ['screenshot', 'inspect', 'list_windows', 'click', 'type', 'key', 'drag', 'focus', 'dispatch']) {
      expect(tools).toContain(t);
    }
  });

  it('advertises exec, launch and close (T4a); paste stays off the surface', () => {
    const tools = x11Adapter.availableTools();
    for (const t of ['exec', 'launch', 'close']) {
      expect(tools).toContain(t);
    }
    expect(tools).not.toContain('paste');
  });
});

describe('X11 transport helpers', () => {
  it('uses the in-VM launcher path from the golden', () => {
    expect(IN_VM_LAUNCHER).toBe('/usr/local/bin/launch-x11-mcp');
  });

  it('defaults SSH user to root and jump to the Proxmox host', () => {
    expect(vmSshUser({})).toBe('root');
    expect(sshJumpTarget({})).toBe('root@192.168.1.220');
  });

  it('honors VMHUB_JUMP_HOST override', () => {
    expect(sshJumpTarget({ VMHUB_JUMP_HOST: '10.0.0.5' })).toBe('root@10.0.0.5');
  });

  it('honors VMHUB_SSH_USER override', () => {
    expect(vmSshUser({ VMHUB_SSH_USER: 'vmuser' })).toBe('vmuser');
    expect(sshJumpTarget({ VMHUB_SSH_USER: 'vmuser' })).toBe('vmuser@192.168.1.220');
  });
});

describe('X11 session env (T4a)', () => {
  it('exports the session env the adapter prefixes onto the remote command', () => {
    expect(planned.X11_SESSION_ENV).toEqual({
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      XAUTHORITY: '/home/vmuser/.Xauthority',
      DISPLAY: ':0',
      XDG_RUNTIME_DIR: '/run/user/1000',
      XDG_SESSION_TYPE: 'x11',
    });
  });

  it('composes into the vmSshMcpTransport remote command line', () => {
    // Locks the transport semantics the adapter must wire: the env prefix
    // wraps the launcher, the ssh argv is untouched.
    const prefix = planned.X11_SESSION_ENV ?? {};
    const transport = sshIntoVmArgs(makeVm('env-1'), {});
    expect(transport).toEqual(['-T', '-o', 'StrictHostKeyChecking=no', '-o', 'ProxyJump=root@192.168.1.220', 'root@10.10.10.50']);
    const joined = Object.entries(prefix)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    expect(`${joined} ${IN_VM_LAUNCHER}`).toBe(
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XAUTHORITY=/home/vmuser/.Xauthority DISPLAY=:0 XDG_RUNTIME_DIR=/run/user/1000 XDG_SESSION_TYPE=x11 /usr/local/bin/launch-x11-mcp',
    );
  });
});

describe('X11 SSH exec argv (T4a)', () => {
  it('builds ssh argv + vmhub-exec + command for exec', () => {
    const vm = makeVm('exec-1');
    expect(planned.vmhubExecArgs?.(vm, 'ls', ['-la'])).toEqual([
      ...sshIntoVmArgs(vm, {}),
      '/usr/local/bin/vmhub-exec',
      'ls',
      '-la',
    ]);
  });

  it('builds wmctrl -ic args for a numeric/0x window id', () => {
    expect(planned.x11CloseArgs?.('0x04000007')).toEqual(['wmctrl', '-ic', '0x04000007']);
    expect(planned.x11CloseArgs?.('123')).toEqual(['wmctrl', '-ic', '123']);
  });

  it('builds wmctrl -c args for a window title', () => {
    expect(planned.x11CloseArgs?.('Firefox')).toEqual(['wmctrl', '-c', 'Firefox']);
  });
});

describe('X11 dispatch via the MCP client (T4a)', () => {
  // The adapter builds its own Client; tests inject a fake by replacing the
  // private ensureConnection on the singleton (prototype method restored in
  // beforeEach). No real ssh process is ever spawned.
  const fakeClient = {
    connect: async () => undefined,
    callTool: vi.fn(),
    close: async () => undefined,
  };
  type FakeConn = { client: typeof fakeClient; transport: unknown };
  const patched = x11Adapter as unknown as { ensureConnection?(vm: Vm): Promise<FakeConn> };

  beforeEach(() => {
    fakeClient.callTool.mockReset();
    delete patched.ensureConnection;
  });

  function injectFakeClient(): void {
    patched.ensureConnection = async () => ({ client: fakeClient, transport: {} });
  }

  it('routes dispatch doctor to the computer-use-linux doctor MCP tool', async () => {
    injectFakeClient();
    fakeClient.callTool.mockResolvedValue({ structuredContent: { ok: true, result: { healthy: true } }, content: [], isError: false });
    const vm = makeVm('doctor-1');
    const result = await x11Adapter.dispatch(vm, 'doctor', {});
    expect(fakeClient.callTool).toHaveBeenCalledWith({ name: 'doctor', arguments: {} });
    expect(result).toMatchObject({ healthy: true });
  });

  it('unknown dispatch verb → typed CAPABILITY_UNAVAILABLE VmError', async () => {
    injectFakeClient();
    const vm = makeVm('unknown-1');
    await expect(x11Adapter.dispatch(vm, 'frobnicate', {})).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
    });
  });
});

describe('X11 error surfacing (T4a)', () => {
  const fakeClient = {
    connect: async () => undefined,
    callTool: vi.fn(),
    close: async () => undefined,
  };
  type FakeConn = { client: typeof fakeClient; transport: unknown };
  const patched = x11Adapter as unknown as { ensureConnection?(vm: Vm): Promise<FakeConn> };

  beforeEach(() => {
    fakeClient.callTool.mockReset();
    delete patched.ensureConnection;
  });

  function injectFakeClient(): void {
    patched.ensureConnection = async () => ({ client: fakeClient, transport: {} });
  }

  it('surfaces an `error` field from the list_windows payload instead of dropping it', async () => {
    injectFakeClient();
    fakeClient.callTool.mockResolvedValue({ structuredContent: { ok: true, error: { message: 'X11 DISPLAY not reachable' } }, content: [], isError: false });
    const vm = makeVm('err-1');
    await expect(x11Adapter.listWindows(vm)).rejects.toMatchObject({
      message: expect.stringContaining('X11 DISPLAY not reachable'),
    });
  });

  it('propagates permissions_hint as the typed VmError hint when present', async () => {
    injectFakeClient();
    fakeClient.callTool.mockResolvedValue({
      structuredContent: {
        ok: true,
        windows: [],
        error: 'no permission to read the window tree',
        permissions_hint: 'run the session as the vmuser account',
      },
      content: [],
      isError: false,
    });
    const vm = makeVm('err-2');
    await expect(x11Adapter.listWindows(vm)).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      hint: 'run the session as the vmuser account',
    });
  });

  it('surfaces accessibility_error from the inspect payload as a typed VmError', async () => {
    injectFakeClient();
    fakeClient.callTool.mockResolvedValue({
      structuredContent: {
        ok: true,
        screenshot: { coordinate_width: 10, coordinate_height: 10 },
        accessibility_tree: [],
        accessibility_error: 'AT-SPI bus not reachable',
      },
      content: [],
      isError: false,
    });
    const vm = makeVm('err-3');
    await expect(x11Adapter.inspect(vm)).rejects.toMatchObject({
      message: expect.stringContaining('AT-SPI bus not reachable'),
    });
  });
});

describe('golden refresh pin (issue #3)', () => {
  const script = readFileSync(new URL('../../scripts/vmhub-golden-refresh.sh', import.meta.url), 'utf8');

  it('pins @agent-sh/computer-use-linux@0.4.9 in the refresh script', () => {
    expect(script).toContain('@agent-sh/computer-use-linux@0.4.9');
  });

  it('never installs an unpinned computer-use-linux', () => {
    expect(script).not.toMatch(/npm (update|install) -g @agent-sh\/computer-use-linux(?!@)/);
  });
});
