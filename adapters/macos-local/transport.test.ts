/**
 * QemuProcess unit tests — mocked subprocess and filesystem only.
 * No live QEMU required. Tests command construction, process lifecycle,
 * serial log reading, and error handling.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QemuProcess } from './transport.ts';
import type { QemuArgs, SpawnFn, ReadFileFn } from './types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ARGS: QemuArgs = {
  qemuPath: '/usr/bin/qemu-system-x86_64',
  memory: '8192',
  cpu: 'Skylake-Client,-hle,-rtm',
  drives: [
    { file: 'golden.qcow2', format: 'qcow2', if: 'virtio' },
    { file: 'OpenCore.qcow2', format: 'qcow2', if: 'virtio' },
  ],
  netdev: {
    id: 'net0',
    options: 'hostfwd=tcp::2222-:22',
    device: 'virtio-net-pci',
  },
  serial: { type: 'file', path: 'serial.log' },
  monitor: '/tmp/qemu-monitor.sock',
  display: 'none',
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockProcess {
  pid: number;
  kill: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  stderr: { on: ReturnType<typeof vi.fn>; _listeners: Map<string, Array<(d: Buffer) => void>> };
  _emitClose: (code: number | null) => void;
  _emitError: () => void;
  _listeners: Map<string, Array<(...args: unknown[]) => void>>;
}

function createMockProc(pid = 12345): MockProcess {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const stderrListeners = new Map<string, Array<(d: Buffer) => void>>();
  const mock: MockProcess = {
    pid,
    kill: vi.fn().mockReturnValue(true),
    on: vi.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(cb);
      return mock;
    }),
    stderr: {
      on: vi.fn().mockImplementation((event: string, cb: (d: Buffer) => void) => {
        if (!stderrListeners.has(event)) stderrListeners.set(event, []);
        stderrListeners.get(event)!.push(cb);
        return mock.stderr;
      }),
      _listeners: stderrListeners,
    },
    _emitClose: (code: number | null) => {
      for (const cb of listeners.get('close') ?? []) cb(code);
    },
    _emitError: () => {
      for (const cb of listeners.get('error') ?? []) cb(new Error('spawn failed'));
    },
    _listeners: listeners,
  };
  return mock;
}

function makeSpawn(mock: MockProcess): SpawnFn {
  return vi.fn().mockReturnValue(mock) as unknown as SpawnFn;
}

function makeReadFile(data: string | Buffer): ReadFileFn {
  return vi.fn().mockResolvedValue(data) as unknown as ReadFileFn;
}

function makeReadFileThrows(): ReadFileFn {
  return vi.fn().mockRejectedValue(new Error('ENOENT')) as unknown as ReadFileFn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QemuProcess buildArgs', () => {
  it('constructs the full QEMU argv from QemuArgs', () => {
    const qemu = new QemuProcess(BASE_ARGS);
    const argv = qemu.buildArgs();
    expect(argv).toEqual([
      '-drive', 'file=golden.qcow2,format=qcow2,if=virtio',
      '-drive', 'file=OpenCore.qcow2,format=qcow2,if=virtio',
      '-netdev', 'user,id=net0,hostfwd=tcp::2222-:22',
      '-device', 'virtio-net-pci,netdev=net0',
      '-serial', 'file:serial.log',
      '-monitor', 'unix:/tmp/qemu-monitor.sock,server,nowait',
      '-display', 'none',
      '-m', '8192',
      '-cpu', 'Skylake-Client,-hle,-rtm',
    ]);
  });

  it('uses -serial stdio when serial type is stdio', () => {
    const args: QemuArgs = { ...BASE_ARGS, serial: { type: 'stdio' } };
    const qemu = new QemuProcess(args);
    const argv = qemu.buildArgs();
    expect(argv).toContain('-serial');
    expect(argv[argv.indexOf('-serial') + 1]).toBe('stdio');
  });

  it('handles a single drive', () => {
    const args: QemuArgs = {
      ...BASE_ARGS,
      drives: [{ file: 'disk.qcow2', format: 'qcow2', if: 'virtio' }],
    };
    const qemu = new QemuProcess(args);
    const argv = qemu.buildArgs();
    const driveCount = argv.filter((a) => a === '-drive').length;
    expect(driveCount).toBe(1);
  });
});

describe('QemuProcess start', () => {
  it('spawns QEMU with the correct binary and argv', async () => {
    const mock = createMockProc();
    const spawn = makeSpawn(mock);
    const qemu = new QemuProcess(BASE_ARGS, { spawn });
    await qemu.start();
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/qemu-system-x86_64',
      expect.arrayContaining(['-m', '8192', '-cpu', 'Skylake-Client,-hle,-rtm']),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('throws if already running', async () => {
    const mock = createMockProc();
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock) });
    await qemu.start();
    await expect(qemu.start()).rejects.toThrow('already running');
  });

  it('clears state on spawn error', async () => {
    const mock = createMockProc();
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock) });
    await qemu.start();
    mock._emitError();
    const status = await qemu.status();
    expect(status.running).toBe(false);
  });
});

describe('QemuProcess stop', () => {
  it('sends SIGTERM to the process', async () => {
    const mock = createMockProc();
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock) });
    await qemu.start();
    // Call stop() first — it registers its own 'close' listener on the proc
    // and sends SIGTERM. Then we emit close to resolve the stop promise.
    const stopPromise = qemu.stop();
    // stop() has called kill('SIGTERM') synchronously before waiting for close.
    expect(mock.kill).toHaveBeenCalledWith('SIGTERM');
    // Now emit close so stop() resolves.
    mock._emitClose(0);
    await stopPromise;
  });

  it('resolves immediately if not running', async () => {
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(createMockProc()) });
    await qemu.stop(); // no throw, no hang
  });

  it('clears proc reference after stop', async () => {
    const mock = createMockProc();
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock) });
    await qemu.start();
    mock._emitClose(0);
    await qemu.stop();
    const status = await qemu.status();
    expect(status.running).toBe(false);
    expect(status.pid).toBe(0);
  });
});

describe('QemuProcess status', () => {
  it('reports running=true when process is alive', async () => {
    const mock = createMockProc(99999);
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock) });
    await qemu.start();
    const status = await qemu.status();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(99999);
  });

  it('reports running=false when process exited', async () => {
    const mock = createMockProc();
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock) });
    await qemu.start();
    mock._emitClose(1);
    // Give the close handler a tick to fire.
    await new Promise((r) => setTimeout(r, 0));
    const status = await qemu.status();
    expect(status.running).toBe(false);
  });

  it('reads serial log from file when configured', async () => {
    const mock = createMockProc();
    const readFile = makeReadFile('boot log line 1\nboot log line 2\n');
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock), readFileFn: readFile });
    await qemu.start();
    const status = await qemu.status();
    expect(status.serialLog).toBe('boot log line 1\nboot log line 2\n');
    expect(readFile).toHaveBeenCalledWith('serial.log', 'utf8');
  });

  it('falls back to in-memory buffer when serial file is missing', async () => {
    const mock = createMockProc();
    const qemu = new QemuProcess(
      BASE_ARGS,
      { spawn: makeSpawn(mock), readFileFn: makeReadFileThrows() },
    );
    await qemu.start();
    const stderrHandler = mock.stderr._listeners.get('data')?.[0];
    if (stderrHandler) stderrHandler(Buffer.from('console output'));
    const status = await qemu.status();
    expect(status.serialLog).toBeDefined();
  });
});

describe('QemuProcess serialRead', () => {
  it('returns the serial log file contents', async () => {
    const readFile = makeReadFile('serial line 1\nserial line 2\n');
    const qemu = new QemuProcess(BASE_ARGS, { readFileFn: readFile });
    const log = await qemu.serialRead();
    expect(log).toBe('serial line 1\nserial line 2\n');
    expect(readFile).toHaveBeenCalledWith('serial.log', 'utf8');
  });

  it('returns in-memory buffer when serial type is stdio', async () => {
    const args: QemuArgs = { ...BASE_ARGS, serial: { type: 'stdio' } };
    const mock = createMockProc();
    const qemu = new QemuProcess(args, { spawn: makeSpawn(mock), readFileFn: makeReadFile('') });
    await qemu.start();
    const dataHandler = mock.stderr._listeners.get('data')?.[0];
    if (dataHandler) dataHandler(Buffer.from('hello from guest'));
    const log = await qemu.serialRead();
    expect(log).toBe('hello from guest');
  });

  it('returns empty string when no output captured and file read fails', async () => {
    const qemu = new QemuProcess(BASE_ARGS, { readFileFn: makeReadFileThrows() });
    const log = await qemu.serialRead();
    expect(log).toBe('');
  });
});

describe('QemuProcess lifecycle integration', () => {
  it('full start → status → stop lifecycle', async () => {
    const mock = createMockProc(42);
    const readFile = makeReadFile('boot...');
    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock), readFileFn: readFile });

    await qemu.start();
    const s1 = await qemu.status();
    expect(s1.running).toBe(true);
    expect(s1.pid).toBe(42);
    expect(s1.serialLog).toBe('boot...');

    mock._emitClose(0);
    await qemu.stop();
    const s2 = await qemu.status();
    expect(s2.running).toBe(false);
  });

  it('stop kills with SIGKILL after timeout if SIGTERM ignored', { timeout: 10_000 }, async () => {
    const mock = createMockProc();
    mock.kill.mockImplementation((signal?: string | number) => {
      if (signal === 'SIGKILL') {
        setTimeout(() => mock._emitClose(9), 0);
      }
      return true;
    });

    const qemu = new QemuProcess(BASE_ARGS, { spawn: makeSpawn(mock), stopTimeoutMs: 50 });
    await qemu.start();

    const stopPromise = qemu.stop();
    await stopPromise;
    expect(mock.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mock.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('QemuProcess error handling', () => {
  it('screenshot throws when process not running', async () => {
    const qemu = new QemuProcess(BASE_ARGS);
    await expect(qemu.screenshot()).rejects.toThrow('not running');
  });

  it('exec throws when process not running', async () => {
    const qemu = new QemuProcess(BASE_ARGS);
    await expect(qemu.exec('ls')).rejects.toThrow('not running');
  });

  it('start after exit resets state for restart', async () => {
    const mock1 = createMockProc(1);
    const mock2 = createMockProc(2);
    let callCount = 0;
    const spawn = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount === 1 ? mock1 : mock2;
    }) as unknown as SpawnFn;

    const qemu = new QemuProcess(BASE_ARGS, { spawn });
    await qemu.start();
    mock1._emitClose(0);
    await new Promise((r) => setTimeout(r, 0));
    expect((await qemu.status()).running).toBe(false);

    // After exit, proc is null — start should work again.
    await qemu.start();
    const s = await qemu.status();
    expect(s.running).toBe(true);
    expect(s.pid).toBe(2);
  });
});
