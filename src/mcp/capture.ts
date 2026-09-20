/**
 * Host-side packet capture for a lease VM.
 *
 * tcpdump runs on the Proxmox host against the VM's tap interface
 * (tap<vmid>i0), so it sees every frame the guest sends — including ones the
 * lease firewall drops — and nothing inside the guest can hide from or
 * tamper with it. The pcap streams back over the same SSH jump the adapters
 * use and lands in a local file; stop() parses it into a behavior summary.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Vm } from '../shared/types.ts';
import { sshHostArgs } from '../../adapters/transport.ts';
import { vmError } from './errors.ts';
import { summarizePcap, type CaptureSummary } from './pcap.ts';

export const DEFAULT_CAPTURE_MAX_BYTES = 512 * 1024 * 1024;
export const DEFAULT_CAPTURE_MAX_MS = 60 * 60 * 1000;

interface ActiveCapture {
  vmUuid: string;
  file: string;
  startedAt: number;
  child: ChildProcess;
  out: WriteStream;
  bytes: number;
  stopReason?: string;
  stderr: string;
  guestIp?: string;
  done: Promise<void>;
}

export interface CaptureStatus {
  active: boolean;
  file: string;
  bytes: number;
  runningMs: number;
  stopReason?: string;
}

/** BPF expressions are passed to tcpdump as argv; keep them to BPF's alphabet. */
const SAFE_FILTER = /^[A-Za-z0-9 .:/()!&|<>=\-]*$/;

export function captureDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_CAPTURE_DIR ?? join(homedir(), '.local', 'share', 'vmhub', 'captures');
}

/** Remote tcpdump command for a VM's first NIC. Packet-buffered so stop loses nothing. */
export function tcpdumpCommand(vmid: number, filter = ''): string {
  if (!Number.isInteger(vmid) || vmid <= 0) throw vmError('INVALID_REQUEST', `bad vmid ${vmid}`);
  if (!SAFE_FILTER.test(filter)) throw vmError('INVALID_REQUEST', `capture filter has characters outside BPF syntax: ${filter}`);
  return `exec tcpdump -i tap${vmid}i0 -U -s 0 -w - ${filter}`.trim();
}

export class CaptureManager {
  private active = new Map<string, ActiveCapture>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async start(vm: Vm, opts: { filter?: string; maxBytes?: number; maxMs?: number } = {}): Promise<CaptureStatus> {
    if (!vm.vmid) throw vmError('INVALID_REQUEST', `VM ${vm.uuid} has no Proxmox vmid yet — wait until vm_lease_status says ready`);
    const existing = this.active.get(vm.uuid);
    if (existing && existing.child.exitCode === null) return this.statusOf(existing);

    const dir = captureDir(this.env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${vm.uuid}-${new Date().toISOString().replace(/[:.]/g, '-')}.pcap`);
    const out = createWriteStream(file, { mode: 0o600 });
    const child = spawn('ssh', [...sshHostArgs(this.env), tcpdumpCommand(vm.vmid, opts.filter)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const maxBytes = opts.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES;
    const cap: ActiveCapture = {
      vmUuid: vm.uuid, file, startedAt: Date.now(), child, out, bytes: 0, stderr: '', guestIp: vm.ip,
      done: new Promise((resolve) => child.on('close', () => out.end(() => resolve()))),
    };
    child.stdout!.on('data', (d: Buffer) => {
      if (cap.bytes + d.length > maxBytes) {
        cap.stopReason ??= `size cap ${maxBytes} bytes reached`;
        child.kill('SIGTERM');
        return;
      }
      cap.bytes += d.length;
      out.write(d);
    });
    child.stderr!.on('data', (d: Buffer) => { cap.stderr = (cap.stderr + d.toString()).slice(-4000); });
    const timer = setTimeout(() => {
      cap.stopReason ??= `time cap ${opts.maxMs ?? DEFAULT_CAPTURE_MAX_MS}ms reached`;
      child.kill('SIGTERM');
    }, opts.maxMs ?? DEFAULT_CAPTURE_MAX_MS);
    timer.unref();
    child.on('close', () => clearTimeout(timer));
    this.active.set(vm.uuid, cap);

    // tcpdump prints "listening on tapNNNi0" once the interface is open; fail fast otherwise.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (/listening on/.test(cap.stderr)) return this.statusOf(cap);
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    child.kill('SIGTERM');
    this.active.delete(vm.uuid);
    throw vmError('INTERNAL', `capture did not start on the host: ${cap.stderr.trim() || 'no output from tcpdump'}`,
      'The host needs tcpdump installed (apt install tcpdump) and SSH access as root via VMHUB_JUMP_HOST.');
  }

  status(vmUuid: string): CaptureStatus | null {
    const cap = this.active.get(vmUuid);
    return cap ? this.statusOf(cap) : null;
  }

  /** Stop (if running), then parse. Safe to call after an auto-stop at a cap. */
  async stop(vmUuid: string, opts: { maxFlows?: number } = {}): Promise<CaptureStatus & { summary?: CaptureSummary; summaryError?: string }> {
    const cap = this.active.get(vmUuid);
    if (!cap) throw vmError('NOT_FOUND', `no capture for VM ${vmUuid}`, 'Start one with vm_capture action "start".');
    if (cap.child.exitCode === null) cap.child.kill('SIGTERM');
    await Promise.race([cap.done, new Promise((r) => setTimeout(r, 10_000))]);
    this.active.delete(vmUuid);
    const status = { ...this.statusOf(cap), active: false };
    try {
      return { ...status, summary: summarizePcap(readFileSync(cap.file), { guestIp: cap.guestIp, maxFlows: opts.maxFlows }) };
    } catch (e) {
      return { ...status, summaryError: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Kill any capture for a VM being released. */
  abandon(vmUuid: string): void {
    this.active.get(vmUuid)?.child.kill('SIGTERM');
    this.active.delete(vmUuid);
  }

  private statusOf(cap: ActiveCapture): CaptureStatus {
    return {
      active: cap.child.exitCode === null,
      file: cap.file,
      bytes: cap.bytes,
      runningMs: Date.now() - cap.startedAt,
      ...(cap.stopReason ? { stopReason: cap.stopReason } : {}),
    };
  }
}
