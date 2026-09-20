/**
 * Minimal pcap reader + behavior summary for vm_capture.
 *
 * An agent watching a program (or a malware sample) needs "what did it try
 * to talk to", not a packet dump: DNS lookups, TLS server names, HTTP
 * requests, and outbound connections — including the ones the lease's
 * network policy blocked (a SYN that never got an answer). This parses
 * classic pcap (Ethernet, IPv4/IPv6, TCP/UDP) with no external tools.
 */

export interface FlowSummary {
  proto: 'tcp' | 'udp' | 'icmp' | 'other';
  dst: string;
  dport?: number;
  /** Name learned from DNS answers / SNI / Host header for this address. */
  names?: string[];
  packets: number;
  bytesOut: number;
  bytesIn: number;
  /** TCP only: a SYN went out but no SYN-ACK came back (blocked or dead). */
  unanswered?: boolean;
  firstSeenMs: number;
}

export interface CaptureSummary {
  packets: number;
  bytes: number;
  durationMs: number;
  guestIp?: string;
  dnsQueries: { name: string; type: string; answers: string[] }[];
  tlsServerNames: string[];
  httpRequests: string[];
  flows: FlowSummary[];
  truncatedFlows?: number;
}

interface Pkt {
  tsMs: number;
  len: number;
  src: string;
  dst: string;
  proto: FlowSummary['proto'];
  sport?: number;
  dport?: number;
  tcpFlags?: number;
  payload?: Uint8Array;
}

/** Guest-side listening ports the vmhub control plane itself uses. */
const CONTROL_PORTS = new Set([22, 5555, 8000]);

const DNS_TYPES: Record<number, string> = { 1: 'A', 2: 'NS', 5: 'CNAME', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 65: 'HTTPS' };

function ipv4(b: Uint8Array, o: number): string {
  return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
}

function ipv6(b: Uint8Array, o: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(((b[o + i]! << 8) | b[o + i + 1]!).toString(16));
  return parts.join(':').replace(/(^|:)0(:0)+(:|$)/, '::');
}

/** Decode one Ethernet frame into the fields we summarize (null = not IP). */
function decodeFrame(b: Uint8Array, tsMs: number, len: number): Pkt | null {
  let o = 12;
  if (b.length < 14) return null;
  let ethType = (b[o]! << 8) | b[o + 1]!;
  o += 2;
  while (ethType === 0x8100 && b.length >= o + 4) {
    ethType = (b[o + 2]! << 8) | b[o + 3]!;
    o += 4;
  }
  let src: string, dst: string, proto: number, l4: number;
  if (ethType === 0x0800) {
    if (b.length < o + 20) return null;
    const ihl = (b[o]! & 0x0f) * 4;
    proto = b[o + 9]!;
    src = ipv4(b, o + 12);
    dst = ipv4(b, o + 16);
    l4 = o + ihl;
  } else if (ethType === 0x86dd) {
    if (b.length < o + 40) return null;
    proto = b[o + 6]!;
    src = ipv6(b, o + 8);
    dst = ipv6(b, o + 24);
    l4 = o + 40;
  } else {
    return null;
  }
  if (proto === 6 && b.length >= l4 + 20) {
    const off = (b[l4 + 12]! >> 4) * 4;
    return { tsMs, len, src, dst, proto: 'tcp', sport: (b[l4]! << 8) | b[l4 + 1]!, dport: (b[l4 + 2]! << 8) | b[l4 + 3]!, tcpFlags: b[l4 + 13]!, payload: b.subarray(l4 + off) };
  }
  if (proto === 17 && b.length >= l4 + 8) {
    return { tsMs, len, src, dst, proto: 'udp', sport: (b[l4]! << 8) | b[l4 + 1]!, dport: (b[l4 + 2]! << 8) | b[l4 + 3]!, payload: b.subarray(l4 + 8) };
  }
  return { tsMs, len, src, dst, proto: proto === 1 || proto === 58 ? 'icmp' : 'other' };
}

/** Iterate packets of a classic pcap file (either byte order, µs or ns). */
export function* readPcap(buf: Uint8Array): Generator<Pkt> {
  if (buf.length < 24) return;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  let le: boolean, nano: boolean;
  if (magic === 0xa1b2c3d4) { le = true; nano = false; }
  else if (magic === 0xa1b23c4d) { le = true; nano = true; }
  else if (magic === 0xd4c3b2a1) { le = false; nano = false; }
  else if (magic === 0x4d3cb2a1) { le = false; nano = true; }
  else throw new Error('not a pcap file (pcapng is not supported; tcpdump -w writes pcap)');
  const link = dv.getUint32(20, le);
  if (link !== 1) throw new Error(`unsupported pcap link type ${link} (want Ethernet)`);
  let o = 24;
  while (o + 16 <= buf.length) {
    const sec = dv.getUint32(o, le);
    const frac = dv.getUint32(o + 4, le);
    const incl = dv.getUint32(o + 8, le);
    const orig = dv.getUint32(o + 12, le);
    o += 16;
    if (o + incl > buf.length) break; // capture stopped mid-packet
    const pkt = decodeFrame(buf.subarray(o, o + incl), sec * 1000 + (nano ? frac / 1e6 : frac / 1e3), orig);
    o += incl;
    if (pkt) yield pkt;
  }
}

function readName(b: Uint8Array, off: number, depth = 0): { name: string; next: number } {
  const labels: string[] = [];
  let o = off;
  let next = -1;
  while (o < b.length && depth < 16) {
    const l = b[o]!;
    if (l === 0) { o += 1; break; }
    if ((l & 0xc0) === 0xc0) {
      if (next < 0) next = o + 2;
      o = ((l & 0x3f) << 8) | b[o + 1]!;
      depth++;
      continue;
    }
    labels.push(new TextDecoder().decode(b.subarray(o + 1, o + 1 + l)));
    o += 1 + l;
  }
  return { name: labels.join('.'), next: next >= 0 ? next : o };
}

interface DnsMsg { id: number; response: boolean; qname: string; qtype: string; answers: { name: string; type: number; value: string }[] }

export function parseDns(b: Uint8Array): DnsMsg | null {
  if (b.length < 12) return null;
  const id = (b[0]! << 8) | b[1]!;
  const response = (b[2]! & 0x80) !== 0;
  const qd = (b[4]! << 8) | b[5]!;
  const an = (b[6]! << 8) | b[7]!;
  if (qd < 1) return null;
  const q = readName(b, 12);
  let o = q.next;
  const qtype = DNS_TYPES[(b[o]! << 8) | b[o + 1]!] ?? String((b[o]! << 8) | b[o + 1]!);
  o += 4;
  for (let i = 1; i < qd; i++) o = readName(b, o).next + 4;
  const answers: DnsMsg['answers'] = [];
  for (let i = 0; i < an && o + 10 <= b.length; i++) {
    const n = readName(b, o);
    o = n.next;
    const type = (b[o]! << 8) | b[o + 1]!;
    const rdlen = (b[o + 8]! << 8) | b[o + 9]!;
    o += 10;
    let value = '';
    if (type === 1 && rdlen === 4) value = ipv4(b, o);
    else if (type === 28 && rdlen === 16) value = ipv6(b, o);
    else if (type === 5) value = readName(b, o).name;
    if (value) answers.push({ name: n.name, type, value });
    o += rdlen;
  }
  return { id, response, qname: q.name, qtype, answers };
}

/** Server name from a TLS ClientHello, if this TCP payload starts one. */
export function tlsSni(p: Uint8Array): string | null {
  if (p.length < 43 || p[0] !== 0x16 || p[1] !== 0x03 || p[5] !== 0x01) return null;
  let o = 9 + 2 + 32; // record hdr(5) + hs hdr(4) + version(2) + random(32)
  o += 1 + p[o]!; // session id
  if (o + 2 > p.length) return null;
  o += 2 + ((p[o]! << 8) | p[o + 1]!); // cipher suites
  if (o + 1 > p.length) return null;
  o += 1 + p[o]!; // compression
  if (o + 2 > p.length) return null;
  const extEnd = Math.min(p.length, o + 2 + ((p[o]! << 8) | p[o + 1]!));
  o += 2;
  while (o + 4 <= extEnd) {
    const type = (p[o]! << 8) | p[o + 1]!;
    const len = (p[o + 2]! << 8) | p[o + 3]!;
    if (type === 0 && o + 9 <= extEnd) {
      const nameLen = (p[o + 7]! << 8) | p[o + 8]!;
      return new TextDecoder().decode(p.subarray(o + 9, o + 9 + nameLen));
    }
    o += 4 + len;
  }
  return null;
}

/** "GET example.com/path" from a plaintext HTTP request payload. */
export function httpRequestLine(p: Uint8Array): string | null {
  const head = Buffer.from(p.subarray(0, Math.min(p.length, 2048))).toString('latin1');
  const m = /^(GET|POST|PUT|HEAD|DELETE|OPTIONS|PATCH|CONNECT) (\S+) HTTP\/1\.[01]\r\n/.exec(head);
  if (!m) return null;
  const host = /\r\nHost: *([^\r\n]+)/i.exec(head)?.[1] ?? '';
  return `${m[1]} ${host}${m[2]!.startsWith('/') ? m[2] : ` ${m[2]}`}`;
}

/**
 * Summarize a capture from the guest's point of view. The guest address is
 * the most frequent source among packets with a private (RFC1918) source,
 * unless given.
 */
export function summarizePcap(buf: Uint8Array, opts: { guestIp?: string; maxFlows?: number } = {}): CaptureSummary {
  const pkts = [...readPcap(buf)];
  let guest = opts.guestIp;
  if (!guest) {
    const counts = new Map<string, number>();
    for (const p of pkts) if (/^10\./.test(p.src)) counts.set(p.src, (counts.get(p.src) ?? 0) + 1);
    guest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }
  const t0 = pkts[0]?.tsMs ?? 0;
  const names = new Map<string, Set<string>>();
  const addName = (ip: string, n: string): void => {
    const s = names.get(ip) ?? new Set<string>();
    s.add(n);
    names.set(ip, s);
  };
  const dns = new Map<string, { name: string; type: string; answers: Set<string> }>();
  const sni = new Set<string>();
  const http: string[] = [];
  const flows = new Map<string, FlowSummary & { synAcked?: boolean; sawSyn?: boolean }>();
  const inboundInitiated = new Set<string>();
  let bytes = 0;

  for (const p of pkts) {
    bytes += p.len;
    const outbound = p.src === guest;
    const remote = outbound ? p.dst : p.src;
    const rport = outbound ? p.dport : p.sport;
    if (p.proto === 'udp' && p.payload && (p.dport === 53 || p.sport === 53)) {
      const m = parseDns(p.payload);
      if (m) {
        const key = `${m.qname}/${m.qtype}`;
        const e = dns.get(key) ?? { name: m.qname, type: m.qtype, answers: new Set<string>() };
        for (const a of m.answers) {
          e.answers.add(a.value);
          if (a.type === 1 || a.type === 28) addName(a.value, m.qname);
        }
        dns.set(key, e);
      }
    }
    if (p.proto === 'tcp' && p.payload && p.payload.length > 0 && outbound) {
      const s = tlsSni(p.payload);
      if (s) { sni.add(s); addName(p.dst, s); }
      const h = httpRequestLine(p.payload);
      if (h && http.length < 200) http.push(h);
    }
    if (!guest || (p.src !== guest && p.dst !== guest)) continue;
    const key = `${p.proto}|${remote}|${rport ?? ''}`;
    // The host's control sessions (SSH, CursorTouch, adb) and anything else
    // initiated from outside are not guest behavior.
    const guestPort = outbound ? p.sport : p.dport;
    if (p.proto === 'tcp' && guestPort !== undefined && CONTROL_PORTS.has(guestPort)) continue;
    if (p.proto === 'tcp' && !outbound && (p.tcpFlags! & 0x12) === 0x02) inboundInitiated.add(key);
    if (inboundInitiated.has(key)) continue;
    const f = flows.get(key) ?? { proto: p.proto, dst: remote, dport: rport, packets: 0, bytesOut: 0, bytesIn: 0, firstSeenMs: p.tsMs - t0 };
    f.packets++;
    if (outbound) f.bytesOut += p.len; else f.bytesIn += p.len;
    if (p.proto === 'tcp') {
      if (outbound && (p.tcpFlags! & 0x12) === 0x02) f.sawSyn = true;
      if (!outbound && (p.tcpFlags! & 0x12) === 0x12) f.synAcked = true;
    }
    flows.set(key, f);
  }

  const all = [...flows.values()]
    .map(({ synAcked, sawSyn, ...f }) => ({
      ...f,
      ...(f.proto === 'tcp' && sawSyn ? { unanswered: !synAcked } : {}),
      ...(names.has(f.dst) ? { names: [...names.get(f.dst)!] } : {}),
    }))
    .sort((a, b) => a.firstSeenMs - b.firstSeenMs);
  const max = opts.maxFlows ?? 100;
  return {
    packets: pkts.length,
    bytes,
    durationMs: pkts.length ? pkts[pkts.length - 1]!.tsMs - t0 : 0,
    guestIp: guest,
    dnsQueries: [...dns.values()].map((d) => ({ name: d.name, type: d.type, answers: [...d.answers] })),
    tlsServerNames: [...sni],
    httpRequests: http,
    flows: all.slice(0, max),
    ...(all.length > max ? { truncatedFlows: all.length - max } : {}),
  };
}
