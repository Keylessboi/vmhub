/**
 * e2e-lab — exercise the lab tools against a live vmhub (real Proxmox).
 *
 *   VMHUB_LITE_URL=… VMHUB_JUMP_HOST=… [VMHUB_SSH_CONFIG=…] \
 *     bun scripts/e2e-lab.ts [template_id=2030]
 *
 * Leases one VM, then: exec, put/get file, snapshot → change → revert,
 * network isolated vs internet (checked from inside the guest), host-side
 * capture summary. Always releases the lease. Prints one line per check.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const t0 = Date.now();
const created = await call('vm_lease_create', { template_id: template, owner: 'e2e-lab', request_id: `e2e-${Date.now()}`, ttl_ms: 3_600_000, network: 'internet' });
check('lease created', created.ok, created.error);
if (!created.ok) process.exit(1);
const leaseId: string = created.result.lease.vmId;
const vmId: string = created.result.vm.uuid;
try {
  let ready = created.result.ready;
  while (!ready && Date.now() - t0 < 300_000) {
    const st = await call('vm_lease_status', { lease_id: leaseId });
    ready = st.result?.ready;
    if (st.result?.vm?.status === 'error') break;
  }
  check(`lease ready (${Math.round((Date.now() - t0) / 1000)}s)`, !!ready);

  // Boot → sshd: retry exec until the guest answers.
  let ex: R = { ok: false };
  for (let i = 0; i < 40 && !ex.ok; i++) {
    ex = await call('vm_exec', { vm_id: vmId, command: 'uname -a && id -un', timeout_s: 30 });
    if (!ex.ok) await new Promise((r) => setTimeout(r, 5000));
  }
  check('vm_exec runs in the guest', ex.ok && ex.result.exit_code === 0 && /root/.test(ex.result.stdout), ex);
  const rc = await call('vm_exec', { vm_id: vmId, command: 'echo to-stderr >&2; exit 7' });
  check('vm_exec keeps exit code + stderr', rc.result?.exit_code === 7 && rc.result.stderr.includes('to-stderr'), rc);
  const to = await call('vm_exec', { vm_id: vmId, command: 'sleep 30', timeout_s: 2 });
  check('vm_exec enforces timeout', to.result?.timed_out === true, to);

  const dir = mkdtempSync(join(tmpdir(), 'e2e-lab-'));
  writeFileSync(join(dir, 'in.txt'), `sample-${t0}\n`);
  const put = await call('vm_put_file', { vm_id: vmId, local_path: join(dir, 'in.txt'), remote_path: '/root/in.txt' });
  const get = await call('vm_get_file', { vm_id: vmId, remote_path: '/root/in.txt', local_path: join(dir, 'out.txt') });
  check('vm_put_file / vm_get_file round-trip', put.ok && get.ok && readFileSync(join(dir, 'out.txt'), 'utf8') === `sample-${t0}\n`, { put, get });

  const net0 = await call('vm_network', { vm_id: vmId });
  check('lease booted under internet policy (enforced)', net0.result?.mode === 'internet' && net0.result?.enforced === true, net0);
  const inet = await call('vm_exec', { vm_id: vmId, command: 'curl -s -m 8 -o /dev/null -w "%{http_code}" https://example.com || wget -q -T 8 -O /dev/null https://example.com && echo wget-ok', timeout_s: 30 });
  check('internet mode: public HTTPS works', /200|wget-ok/.test(inet.result?.stdout ?? ''), inet);
  const lan = await call('vm_exec', { vm_id: vmId, command: 'timeout 5 bash -c "</dev/tcp/192.168.1.1/80" && echo LAN-OPEN || echo LAN-BLOCKED', timeout_s: 20 });
  check('internet mode: LAN is blocked', (lan.result?.stdout ?? '').includes('LAN-BLOCKED'), lan);

  const cap = await call('vm_capture', { vm_id: vmId, action: 'start' });
  check('vm_capture start', cap.ok, cap);
  await call('vm_exec', { vm_id: vmId, command: 'getent hosts example.org; curl -s -m 8 -o /dev/null https://example.org; curl -s -m 8 -o /dev/null http://neverssl.com/; timeout 4 bash -c "</dev/tcp/192.168.1.1/445"; true', timeout_s: 40 });
  await new Promise((r) => setTimeout(r, 1500));
  const stop = await call('vm_capture', { vm_id: vmId, action: 'stop' });
  const sum = stop.result?.summary;
  check('capture sees the DNS lookup', !!sum?.dnsQueries?.some((q: any) => q.name === 'example.org'), stop);
  check('capture sees the TLS server name', !!sum?.tlsServerNames?.includes('example.org'), sum?.tlsServerNames);
  check('capture sees the HTTP request', !!sum?.httpRequests?.some((h: string) => h.includes('neverssl.com')), sum?.httpRequests);
  check('capture marks the LAN attempt unanswered', !!sum?.flows?.some((f: any) => f.dst === '192.168.1.1' && f.unanswered === true), sum?.flows);

  const iso = await call('vm_network', { vm_id: vmId, mode: 'isolated' });
  check('switch to isolated', iso.result?.mode === 'isolated' && iso.result?.enforced === true, iso);
  const out = await call('vm_exec', { vm_id: vmId, command: 'curl -s -m 6 -o /dev/null -w "%{http_code}" https://1.1.1.1 || echo NET-BLOCKED', timeout_s: 20 });
  check('isolated: no outbound, control path still works', out.ok && (out.result.stdout ?? '').includes('NET-BLOCKED'), out);
  await call('vm_network', { vm_id: vmId, mode: 'internet' });

  const snap = await call('vm_snapshot', { vm_id: vmId, action: 'create', name: 'clean' });
  check('snapshot create', snap.ok, snap);
  await call('vm_exec', { vm_id: vmId, command: 'echo dirty > /root/marker && sync' });
  const rev = await call('vm_snapshot', { vm_id: vmId, action: 'revert', name: 'clean' });
  check('snapshot revert', rev.ok, rev);
  let after: R = { ok: false };
  for (let i = 0; i < 40 && !after.ok; i++) {
    after = await call('vm_exec', { vm_id: vmId, command: 'test -e /root/marker && echo STILL-DIRTY || echo CLEAN', timeout_s: 20 });
    if (!after.ok) await new Promise((r) => setTimeout(r, 5000));
  }
  check('revert restored the clean disk', (after.result?.stdout ?? '').includes('CLEAN'), after);
} finally {
  const rel = await call('vm_lease_release', { lease_id: leaseId });
  check('lease released', rel.ok, rel);
  await client.close();
}
console.log(failures === 0 ? `ALL PASS (${Math.round((Date.now() - t0) / 1000)}s)` : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
