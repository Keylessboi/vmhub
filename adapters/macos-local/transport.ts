/**
 * QEMU process lifecycle manager for local macOS VMs.
 *
 * Handles spawning, stopping, and querying a QEMU process, plus reading
 * the serial console log and issuing commands over the QMP monitor socket.
 *
 * This is a single-tenant transport — no reaper, no leases, no Proxmox.
 * The caller is responsible for cleanup (call stop() when done).
 *
 * Dependencies: node:child_process (spawn), node:fs (readFile), node:net
 * (unix socket for QMP). No external npm packages.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  QemuArgs,
  QemuStatus,
  SpawnFn,
  ReadFileFn,
} from './types.ts';

// ---------------------------------------------------------------------------
// QMP helpers — minimal QEMU Machine Protocol client over unix socket
// ---------------------------------------------------------------------------

/** Send a QMP command and return the parsed response. */
function qmpExec(socket: Socket, command: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = args
      ? { execute: command, arguments: args }
      : { execute: command };
    const data = JSON.stringify(payload) + '\n';
    const timeout = setTimeout(() => reject(new Error(`QMP command "${command}" timed out`)), 10_000);

    const handler = (raw: Buffer): void => {
      clearTimeout(timeout);
      socket.removeListener('data', handler);
      socket.removeListener('error', onError);
      const lines = raw.toString('utf8').split('\n').filter(Boolean);
      // Find the response line (skip QMP greeting and return lines).
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if ('return' in parsed || 'error' in parsed) {
            if (parsed.error) {
              reject(new Error(`QMP error: ${JSON.stringify(parsed.error)}`));
            } else {
              resolve(parsed);
            }
            return;
          }
        } catch { /* not JSON — skip */ }
      }
      reject(new Error(`QMP command "${command}" returned no parseable response`));
    };

    const onError = (err: Error): void => {
      clearTimeout(timeout);
      socket.removeListener('data', handler);
      reject(err);
    };

    socket.on('data', handler);
    socket.on('error', onError);
    socket.write(data);
  });
}

/** Connect to QMP monitor socket, negotiate capabilities, and return the socket. */
async function qmpConnect(monitorPath: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(monitorPath, () => {
      // Read the QMP greeting, then send capabilities negotiation.
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('QMP greeting timed out'));
      }, 5_000);

      const handler = (raw: Buffer): void => {
        clearTimeout(timeout);
        socket.removeListener('data', handler);
        socket.removeListener('error', onError);
        // Send qmp_capabilities to finish negotiation.
        socket.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n');
        // Wait for the return response.
        const capHandler = (capRaw: Buffer): void => {
          socket.removeListener('data', capHandler);
          resolve(socket);
        };
        socket.on('data', capHandler);
      };

      const onError = (err: Error): void => {
        clearTimeout(timeout);
        socket.removeListener('data', handler);
        reject(err);
      };

      socket.on('data', handler);
      socket.on('error', onError);
    });

    socket.on('error', (err: Error) => reject(err));
  });
}

// ---------------------------------------------------------------------------
// QemuProcess
// ---------------------------------------------------------------------------

function defaultSpawn(command: string, args: string[], options?: Record<string, unknown>): ReturnType<SpawnFn> {
  const child = spawn(command, args, options as Parameters<typeof spawn>[2]);
  return child as unknown as ReturnType<SpawnFn>;
}

/** Maximum time (ms) to wait for SIGTERM→SIGKILL escalation in stop(). */
const STOP_TIMEOUT_MS = 5_000;

/** Default temp directory prefix for screendump files. */
const SCREENSHOT_PREFIX = 'vmhub-qemu-screendump';

export interface QemuProcessOptions {
  /** Injectable spawn function (default: child_process.spawn). */
  spawn?: SpawnFn;
  /** Injectable readFile function (default: fs/promises.readFile). */
  readFileFn?: ReadFileFn;
  /** Max ms to wait for SIGTERM before escalating to SIGKILL (default 5000). */
  stopTimeoutMs?: number;
}

export class QemuProcess {
  private readonly args: QemuArgs;
  private readonly spawnFn: SpawnFn;
  private readonly readFileFn: ReadFileFn;
  private readonly stopTimeoutMs: number;
  private proc: { pid?: number; kill: (signal?: string | number) => boolean; on: (event: string, cb: (...args: unknown[]) => void) => void } | null = null;
  private serialBuffer = '';
  private exitCode: number | null = null;

  constructor(args: QemuArgs, opts: QemuProcessOptions = {}) {
    this.args = args;
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.readFileFn = opts.readFileFn ?? readFile;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Build the full QEMU argv from the configuration.
   * Exposed for testing — start() calls this internally.
   */
  buildArgs(): string[] {
    const a = this.args;
    const argv: string[] = [];

    // Drives
    for (const d of a.drives) {
      argv.push('-drive', `file=${d.file},format=${d.format},if=${d.if}`);
    }

    // Network
    argv.push(
      '-netdev', `user,id=${a.netdev.id},${a.netdev.options}`,
      '-device', `${a.netdev.device},netdev=${a.netdev.id}`,
    );

    // Serial
    if (a.serial.type === 'file' && a.serial.path) {
      argv.push('-serial', `file:${a.serial.path}`);
    } else {
      argv.push('-serial', 'stdio');
    }

    // Monitor
    argv.push('-monitor', `unix:${a.monitor},server,nowait`);

    // Display
    argv.push('-display', a.display);

    // CPU + memory
    argv.push('-m', a.memory);
    argv.push('-cpu', a.cpu);

    return argv;
  }

  /**
   * Spawn the QEMU process. Throws if already running.
   * Installs exit/stdio handlers to track lifecycle.
   */
  async start(): Promise<void> {
    if (this.proc) {
      throw new Error('QEMU process already running');
    }

    const argv = this.buildArgs();
    const child = this.spawnFn(this.args.qemuPath, argv, {
      stdio: ['ignore', 'pipe', 'pipe'] as unknown[],
      detached: false,
    });

    this.proc = child;
    this.exitCode = null;
    this.serialBuffer = '';

    // Capture stderr (serial console output when using -serial stdio or -serial file fallback).
    if (child.pid) {
      const stderrStream = (child as unknown as { stderr?: { on: (e: string, cb: (d: Buffer) => void) => void } }).stderr;
      stderrStream?.on('data', (chunk: Buffer) => {
        this.serialBuffer += chunk.toString('utf8');
      });
    }

    // Track process exit.
    child.on('close', (code: unknown) => {
      this.exitCode = typeof code === 'number' ? code : 1;
      this.proc = null;
    });

    child.on('error', () => {
      this.exitCode = 1;
      this.proc = null;
    });
  }

  /**
   * Stop the QEMU process. Sends SIGTERM, escalates to SIGKILL after timeout.
   * Always resolves — even if the process is already dead.
   */
  async stop(): Promise<void> {
    if (!this.proc) return;

    const proc = this.proc;
    this.proc = null;

    return new Promise<void>((resolve) => {
      const killTimeout = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, this.stopTimeoutMs);

      proc.on('close', () => {
        clearTimeout(killTimeout);
        resolve();
      });

      try { proc.kill('SIGTERM'); } catch {
        clearTimeout(killTimeout);
        resolve();
      }
    });
  }

  /**
   * Query the current process status.
   * Reads the serial log file (if configured) to populate serialLog.
   */
  async status(): Promise<QemuStatus> {
    const running = this.proc !== null && this.proc.pid !== undefined && this.exitCode === null;
    const pid = this.proc?.pid ?? 0;

    let serialLog = this.serialBuffer;
    if (this.args.serial.type === 'file' && this.args.serial.path) {
      try {
        const data = await this.readFileFn(this.args.serial.path, 'utf8');
        serialLog = typeof data === 'string' ? data : data.toString('utf8');
      } catch {
        // File may not exist yet — use buffer fallback.
      }
    }

    return { running, pid, serialLog };
  }

  /**
   * Read the serial console output.
   * For file-based serial: reads from the log file.
   * For stdio serial: returns the in-memory buffer.
   */
  async serialRead(): Promise<string> {
    if (this.args.serial.type === 'file' && this.args.serial.path) {
      try {
        const data = await this.readFileFn(this.args.serial.path, 'utf8');
        return typeof data === 'string' ? data : data.toString('utf8');
      } catch {
        return this.serialBuffer;
      }
    }
    return this.serialBuffer;
  }

  /**
   * Capture a screenshot via the QMP monitor socket.
   * Issues `screendump` to save a PNG to a temp file, then reads and returns it.
   */
  async screenshot(): Promise<Buffer> {
    if (!this.proc || this.exitCode !== null) {
      throw new Error('QEMU process is not running');
    }

    const tmpFile = join(tmpdir(), `${SCREENSHOT_PREFIX}-${this.proc.pid ?? 'unknown'}.ppm`);
    let socket: Socket | null = null;
    try {
      socket = await qmpConnect(this.args.monitor);
      await qmpExec(socket, 'screendump', { filename: tmpFile, format: 'png' });
      // screendump writes the file asynchronously — small delay for flush.
      await new Promise((r) => setTimeout(r, 100));
      const pngFile = tmpFile.replace(/\.ppm$/, '.png');
      const actualFile = existsSync(pngFile) ? pngFile : tmpFile;
      const buf = await this.readFileFn(actualFile, 'binary');
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'binary');
    } finally {
      socket?.destroy();
    }
  }

  /**
   * Execute a command inside the guest via QMP guest-exec.
   * Requires the qemu-guest-agent to be running in the VM.
   * Returns the combined stdout of the command.
   */
  async exec(cmd: string): Promise<string> {
    if (!this.proc || this.exitCode !== null) {
      throw new Error('QEMU process is not running');
    }

    let socket: Socket | null = null;
    try {
      socket = await qmpConnect(this.args.monitor);

      // Start the guest-exec command.
      const startRes = await qmpExec(socket, 'guest-exec', {
        path: '/bin/sh',
        arg: ['-c', cmd],
        capture: true,
      });
      const pid = (startRes.return as Record<string, unknown>)?.pid;
      if (typeof pid !== 'number') {
        throw new Error('guest-exec returned no pid');
      }

      // Poll until the command completes.
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const statusRes = await qmpExec(socket, 'guest-exec-status', { pid });
        const status = statusRes.return as Record<string, unknown>;
        if (status.exited === true) {
          const stdoutB64 = typeof status['out-data'] === 'string' ? status['out-data'] : '';
          return Buffer.from(stdoutB64, 'base64').toString('utf8');
        }
      }
      throw new Error('guest-exec timed out after 10s');
    } finally {
      socket?.destroy();
    }
  }
}
