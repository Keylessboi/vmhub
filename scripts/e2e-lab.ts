/**
 * e2e-lab — exercise the lab tools against a live vmhub (real Proxmox).
 *
 *   VMHUB_LITE_URL=… VMHUB_JUMP_HOST=… [VMHUB_SSH_CONFIG=…] [CURSORTOUCH_AUTH_KEY=…] \
 *     bun scripts/e2e-lab.ts [template_id=2030]
 *
 * Leases one VM of the given template and runs the same checks on every OS:
 * exec (exit code, stderr, timeout), file round-trip, network policy seen
 * from inside the guest (internet reaches HTTPS but not the LAN; isolated
 * reaches nothing), host capture summary, snapshot → change → revert. Desktop
 * templates also get screenshot / list_windows / launch / type checks.
 * Always releases the lease. Prints one PASS/FAIL line per check.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Profile {
  whoami: string;
  whoamiExpect: RegExp;
  failWithStderr: string;
  sleep: string;
  remoteFile: string;
  httpsProbe: (url: string) => string; // prints the status code or BLOCKED
  lanProbe: string; // prints LAN-OPEN / LAN-BLOCKED
  traffic: string; // DNS + HTTPS example.org + HTTP example.com + LAN 445 attempt
  markDirty: string;
  checkDirty: string; // prints STILL-DIRTY / CLEAN
  launch?: { command: string; args?: string[] };
}

const LINUX: Profile = {
  whoami: 'uname -a && id -un',
  whoamiExpect: /root/,
  failWithStderr: 'echo to-stderr >&2; exit 7',
  sleep: 'sleep 30',
  remoteFile: '/root/in.txt',
  httpsProbe: (u) => `curl -s -m 8 -o /dev/null -w "%{http_code}" ${u} || echo BLOCKED`,
  lanProbe: 'timeout 5 bash -c "</dev/tcp/192.168.1.1/80" && echo LAN-OPEN || echo LAN-BLOCKED',
  traffic: 'getent hosts example.org; curl -s -m 8 -o /dev/null https://example.org; curl -s -m 8 -o /dev/null http://example.com/; timeout 4 bash -c "</dev/tcp/192.168.1.1/445"; true',
  markDirty: 'echo dirty > /root/marker && sync',
  checkDirty: 'test -e /root/marker && echo STILL-DIRTY || echo CLEAN',
};

// A scriptblock invocation: try/catch/finally is a statement, so it cannot be
// used directly inside if(...) or piped — both are PowerShell parse errors.
const PS_TCP = (host: string, port: number, ms: number) =>
  `(& { $c = New-Object Net.Sockets.TcpClient; try { $c.ConnectAsync('${host}',${port}).Wait(${ms}) } catch { $false } finally { $c.Close() } })`;

const WINDOWS: Profile = {
  whoami: '[Environment]::OSVersion.VersionString; whoami',
  whoamiExpect: /Windows|Microsoft/i,
  failWithStderr: 'Write-Error to-stderr; cmd /c exit 7',
  sleep: 'Start-Sleep -Seconds 30',
  remoteFile: 'C:\\Users\\Public\\in.txt',
  httpsProbe: (u) => `try { (Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 8 ${u} -ErrorAction Stop).StatusCode } catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'BLOCKED' } }`,
  lanProbe: `if (${PS_TCP('192.168.1.1', 80, 5000)}) { 'LAN-OPEN' } else { 'LAN-BLOCKED' }`,
  traffic: `Resolve-DnsName example.org -ErrorAction SilentlyContinue | Out-Null; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 https://example.org | Out-Null } catch {}; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 http://example.com/ | Out-Null } catch {}; ${PS_TCP('192.168.1.1', 445, 4000)} | Out-Null`,
  markDirty: "Set-Content -Path C:\\Users\\Public\\marker.txt -Value dirty",
  checkDirty: "if (Test-Path C:\\Users\\Public\\marker.txt) { 'STILL-DIRTY' } else { 'CLEAN' }",
  // Win11 Enterprise Eval has no Notepad entry in the Start menu, so launch
  // it by path (the adapter routes that to App's launch_executable mode).
  launch: { command: 'C:\\Windows\\System32\\notepad.exe' },
};

/** Android: toybox shell over adb, root via `adb root`; no bash, no curl. */
const ANDROID: Profile = {
  whoami: 'id -u; getprop ro.build.version.release',
  whoamiExpect: /^0/,
  failWithStderr: 'echo to-stderr >&2; exit 7',
  sleep: 'sleep 30',
  remoteFile: '/data/local/tmp/in.txt',
  httpsProbe: (u) => `ping -c 1 -W 4 ${u.replace(/^https?:\/\//, '')} >/dev/null 2>&1 && echo 200 || echo BLOCKED`,
  lanProbe: 'ping -c 1 -W 4 192.168.1.1 >/dev/null 2>&1 && echo LAN-OPEN || echo LAN-BLOCKED',
  // A name the internet check did not already resolve: Android's netd caches,
  // so re-using example.org would emit no DNS query during the capture.
  traffic: 'ping -c 2 -W 4 example.net >/dev/null 2>&1; ping -c 1 -W 3 192.168.1.1 >/dev/null 2>&1; true',
  markDirty: 'echo dirty > /data/local/tmp/marker',
  checkDirty: 'test -e /data/local/tmp/marker && echo STILL-DIRTY || echo CLEAN',
  launch: { command: 'com.android.settings' },
};

const template = process.argv[2] ?? '2030';
const client = new Client({ name: 'e2e-lab', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: 'bun', args: [join(import.meta.dir, '../src/mcp/index.ts')], env: process.env as Record<string, string>, stderr: 'inherit' }));

type R = { ok: boolean; result?: any; error?: any };
async function call(tool: string, args: Record<string, unknown>): Promise<R> {
  const res = await client.callTool({ name: tool, arguments: args }, { timeout: 900_000 });
  return res.structuredContent as R;
}
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || detail === undefined ? '' : `  ${JSON.stringify(detail).slice(0, 600)}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Retry a tool call until it succeeds (guest still booting / session reconnecting). */
async function until(tool: string, args: Record<string, unknown>, tries = 60, gapMs = 5000): Promise<R> {
  let r: R = { ok: false };
  for (let i = 0; i < tries; i++) {
    r = await call(tool, args);
    if (r.ok && !(tool === 'vm_exec' && r.result?.exit_code === 255)) return r;
    await sleep(gapMs);
  }
  return r;
}

const t0 = Date.now();
const created = await call('vm_lease_create', { template_id: template, owner: 'e2e-lab', request_id: `e2e-${template}-${Date.now()}`, ttl_ms: 3_600_000, network: 'internet' });
check(`lease created (template ${template})`, created.ok, created.error);
if (!created.ok) process.exit(1);
const leaseId: string = created.result.lease.vmId;
const vmId: string = created.result.vm.uuid;
const os: string = created.result.vm.adapter;
const P = os === 'windows' ? WINDOWS : os === 'android' ? ANDROID : LINUX;
const desktop = os === 'hyprland' || os === 'x11' || os === 'windows' || os === 'android';
console.log(`INFO  os=${os} vmid=${created.result.vm.vmid} ip=${created.result.vm.ip}`);
try {
  let ready = created.result.ready;
  while (!ready && Date.now() - t0 < 900_000) {
    const st = await call('vm_lease_status', { lease_id: leaseId });
    ready = st.result?.ready;
    if (st.result?.vm?.status === 'error') break;
  }
  check(`lease ready (${Math.round((Date.now() - t0) / 1000)}s)`, !!ready);

  // ── shell ──────────────────────────────────────────────────────────────
  const ex = await until('vm_exec', { vm_id: vmId, command: P.whoami, timeout_s: 30 }, os === 'windows' ? 90 : 40);
  check(`vm_exec runs in the guest (${Math.round((Date.now() - t0) / 1000)}s)`, ex.ok && ex.result.exit_code === 0 && P.whoamiExpect.test(ex.result.stdout), ex);
  const rc = await call('vm_exec', { vm_id: vmId, command: P.failWithStderr });
  check('vm_exec keeps exit code + stderr', rc.result?.exit_code === 7 && /to-stderr/.test(`${rc.result.stderr}${rc.result.stdout}`), rc);
  const tStart = Date.now();
  const to = await call('vm_exec', { vm_id: vmId, command: P.sleep, timeout_s: 3 });
  // Android's first call may re-establish adb (connect + adb root) around the
  // command itself, so allow more wall time there; the kill is what matters.
  const timeoutBound = os === 'android' ? 90_000 : 25_000;
  check('vm_exec enforces timeout', (to.result?.timed_out === true || !to.ok) && Date.now() - tStart < timeoutBound, { to, ms: Date.now() - tStart });

  // ── files ──────────────────────────────────────────────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'e2e-lab-'));
  writeFileSync(join(dir, 'in.txt'), `sample-${t0}\n`);
  const put = await call('vm_put_file', { vm_id: vmId, local_path: join(dir, 'in.txt'), remote_path: P.remoteFile });
  const get = await call('vm_get_file', { vm_id: vmId, remote_path: P.remoteFile, local_path: join(dir, 'out.txt') });
  let round = '';
  try { round = readFileSync(join(dir, 'out.txt'), 'utf8'); } catch {}
  check('vm_put_file / vm_get_file round-trip', put.ok && get.ok && round === `sample-${t0}\n`, { put, get });

  // ── desktop ────────────────────────────────────────────────────────────
  if (desktop) {
    const shot = await until('vm_screenshot', { vm_id: vmId }, 30);
    check('vm_screenshot returns an image', shot.ok && shot.result?.width > 0 && shot.result?.height > 0, shot.error ?? shot.result);
    const wins = await call('vm_list_windows', { vm_id: vmId });
    check('vm_list_windows answers', wins.ok, wins.error);
    const launchSpec = P.launch ?? (os === 'hyprland' ? await pickLinuxTerminal() : undefined);
    if (os === 'android' && launchSpec) {
      const la = await call('vm_launch', { vm_id: vmId, ...launchSpec });
      check(`vm_launch ${launchSpec.command}`, la.ok, la.error);
    } else
    if (launchSpec) {
      const la = await call('vm_launch', { vm_id: vmId, ...launchSpec });
      check(`vm_launch ${launchSpec.command}`, la.ok, la.error);
      await sleep(3000);
      const wins2 = await call('vm_list_windows', { vm_id: vmId });
      check('launched window is listed', wins2.ok && JSON.stringify(wins2.result).toLowerCase().includes(launchSpec.command.toLowerCase().split(/[\\/]/).pop()!.replace(/\.exe$/, '')), wins2.result ?? wins2.error);
    }
    const ty = await call('vm_type', { vm_id: vmId, text: 'vmhub e2e' });
    check('vm_type', ty.ok, ty.error);
    const key = await call('vm_key', { vm_id: vmId, chord: 'Escape' });
    check('vm_key', key.ok, key.error);
  }

  // ── network policy ─────────────────────────────────────────────────────
  const net0 = await call('vm_network', { vm_id: vmId });
  check('lease booted under internet policy (enforced)', net0.result?.mode === 'internet' && net0.result?.enforced === true, net0);
  const inet = await call('vm_exec', { vm_id: vmId, command: P.httpsProbe('https://example.com'), timeout_s: 40 });
  check('internet mode: public HTTPS works', /\b(200|30\d)\b/.test(inet.result?.stdout ?? ''), inet);
  const lan = await call('vm_exec', { vm_id: vmId, command: P.lanProbe, timeout_s: 30 });
  check('internet mode: LAN is blocked', (lan.result?.stdout ?? '').includes('LAN-BLOCKED'), lan);

  const cap = await call('vm_capture', { vm_id: vmId, action: 'start' });
  check('vm_capture start', cap.ok, cap);
  await call('vm_exec', { vm_id: vmId, command: P.traffic, timeout_s: 60 });
  await sleep(1500);
  const stop = await call('vm_capture', { vm_id: vmId, action: 'stop' });
  const sum = stop.result?.summary;
  if (os === 'android') {
    // toybox has no curl and ping is the honest probe here: check the capture
    // saw the guest's own traffic at all, including the blocked LAN attempt.
    check('capture sees the DNS lookup', !!sum?.dnsQueries?.some((q: any) => q.name === 'example.net'), sum?.dnsQueries ?? stop);
    check('capture sees the guest reaching the internet', !!sum?.flows?.some((f: any) => (f.names ?? []).includes('example.net') || f.proto === 'icmp'), sum?.flows);
  } else {
    check('capture sees the DNS lookup', !!sum?.dnsQueries?.some((q: any) => q.name === 'example.org'), sum?.dnsQueries ?? stop);
    check('capture sees the TLS server name', !!sum?.tlsServerNames?.includes('example.org'), sum?.tlsServerNames);
    check('capture sees the HTTP request', !!sum?.httpRequests?.some((h: string) => h.includes('example.com')), sum?.httpRequests);
    check('capture marks the LAN attempt unanswered', !!sum?.flows?.some((f: any) => f.dst === '192.168.1.1' && f.unanswered === true), sum?.flows);
  }

  const iso = await call('vm_network', { vm_id: vmId, mode: 'isolated' });
  check('switch to isolated', iso.result?.mode === 'isolated' && iso.result?.enforced === true, iso);
  const out = await call('vm_exec', { vm_id: vmId, command: P.httpsProbe('https://1.1.1.1'), timeout_s: 40 });
  check('isolated: no outbound, control path still works', out.ok && (out.result.stdout ?? '').includes('BLOCKED'), out);
  await call('vm_network', { vm_id: vmId, mode: 'internet' });

  // ── snapshots ──────────────────────────────────────────────────────────
  const snap = await call('vm_snapshot', { vm_id: vmId, action: 'create', name: 'clean' });
  check('snapshot create', snap.ok, snap);
  await call('vm_exec', { vm_id: vmId, command: P.markDirty });
  const rev = await call('vm_snapshot', { vm_id: vmId, action: 'revert', name: 'clean' });
  check('snapshot revert', rev.ok, rev);
  const after = await until('vm_exec', { vm_id: vmId, command: P.checkDirty, timeout_s: 20 }, os === 'windows' || os === 'android' ? 180 : 40);
  check('revert restored the clean disk', (after.result?.stdout ?? '').includes('CLEAN'), after);
  if (desktop) {
    const shot2 = await until('vm_screenshot', { vm_id: vmId }, 40);
    check('desktop is back after revert', shot2.ok, shot2.error);
  }
} finally {
  const rel = await call('vm_lease_release', { lease_id: leaseId });
  check('lease released', rel.ok, rel);
  await client.close();
}
console.log(failures === 0 ? `ALL PASS (${Math.round((Date.now() - t0) / 1000)}s)` : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

async function pickLinuxTerminal(): Promise<{ command: string } | undefined> {
  const r = await call('vm_exec', { vm_id: vmId, command: 'for t in foot kitty alacritty xterm weston-terminal; do command -v $t >/dev/null && { echo $t; break; }; done' });
  const t = (r.result?.stdout ?? '').trim();
  return t ? { command: t } : undefined;
}
