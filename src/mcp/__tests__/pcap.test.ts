/**
 * pcap summary tests — synthetic frames, no tcpdump needed.
 */
import { describe, expect, it } from 'vitest';
import { httpRequestLine, parseDns, summarizePcap, tlsSni } from '../pcap.ts';
import { tcpdumpCommand } from '../capture.ts';

const GUEST = '10.10.10.50';

function ip4(s: string): number[] {
  return s.split('.').map(Number);
}

function frame(src: string, dst: string, proto: 6 | 17, sport: number, dport: number, payload: number[], tcpFlags = 0x18): number[] {
  const l4 =
    proto === 6
      ? [sport >> 8, sport & 255, dport >> 8, dport & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0x50, tcpFlags, 0xff, 0xff, 0, 0, 0, 0, ...payload]
      : [sport >> 8, sport & 255, dport >> 8, dport & 255, (8 + payload.length) >> 8, (8 + payload.length) & 255, 0, 0, ...payload];
  const total = 20 + l4.length;
  const ip = [0x45, 0, total >> 8, total & 255, 0, 0, 0, 0, 64, proto, 0, 0, ...ip4(src), ...ip4(dst)];
  return [...Array(12).fill(0), 0x08, 0x00, ...ip, ...l4];
}

function pcap(frames: number[][]): Uint8Array {
  const out: number[] = [];
  const u32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
  out.push(...u32(0xa1b2c3d4), 2, 0, 4, 0, ...u32(0), ...u32(0), ...u32(65535), ...u32(1));
  frames.forEach((f, i) => out.push(...u32(1000 + i), ...u32(0), ...u32(f.length), ...u32(f.length), ...f));
  return new Uint8Array(out);
}

function qname(name: string): number[] {
  return [...name.split('.').flatMap((l) => [l.length, ...[...l].map((c) => c.charCodeAt(0))]), 0];
}

const dnsQuery = [0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...qname('evil.example'), 0, 1, 0, 1];
const dnsAnswer = [0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, ...qname('evil.example'), 0, 1, 0, 1, 0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 7];

function clientHello(host: string): number[] {
  const name = [...host].map((c) => c.charCodeAt(0));
  const sni = [0, 0, 0, name.length + 5, 0, name.length + 3, 0, 0, name.length, ...name];
  const body = [3, 3, ...Array(32).fill(1), 0, 0, 2, 0x13, 0x01, 1, 0, 0, sni.length, ...sni];
  const hs = [1, 0, body.length >> 8, body.length & 255, ...body];
  return [0x16, 3, 1, hs.length >> 8, hs.length & 255, ...hs];
}

const http = [...'GET /payload.bin HTTP/1.1\r\nHost: dl.example\r\n\r\n'].map((c) => c.charCodeAt(0));

describe('parsers', () => {
  it('parses DNS questions and A answers', () => {
    expect(parseDns(new Uint8Array(dnsQuery))).toMatchObject({ qname: 'evil.example', qtype: 'A', response: false });
    expect(parseDns(new Uint8Array(dnsAnswer))!.answers).toEqual([{ name: 'evil.example', type: 1, value: '203.0.113.7' }]);
  });

  it('extracts TLS SNI and HTTP request lines', () => {
    expect(tlsSni(new Uint8Array(clientHello('c2.example')))).toBe('c2.example');
    expect(tlsSni(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(httpRequestLine(new Uint8Array(http))).toBe('GET dl.example/payload.bin');
  });
});

describe('summarizePcap', () => {
  const buf = pcap([
    frame(GUEST, '10.10.10.1', 17, 40000, 53, dnsQuery),
    frame('10.10.10.1', GUEST, 17, 53, 40000, dnsAnswer),
    frame(GUEST, '203.0.113.7', 6, 50000, 443, [], 0x02),
    frame('203.0.113.7', GUEST, 6, 443, 50000, [], 0x12),
    frame(GUEST, '203.0.113.7', 6, 50000, 443, clientHello('evil.example')),
    frame(GUEST, '192.168.1.10', 6, 50001, 445, [], 0x02), // blocked lateral move
    frame(GUEST, '198.51.100.9', 6, 50002, 80, http),
    frame('10.10.10.1', GUEST, 6, 60000, 22, [1, 2, 3]), // host control path
    frame(GUEST, '10.10.10.1', 6, 22, 60000, [4, 5, 6]),
  ]);
  const s = summarizePcap(buf);

  it('identifies the guest and totals', () => {
    expect(s.guestIp).toBe(GUEST);
    expect(s.packets).toBe(9);
  });

  it('reports DNS, SNI and HTTP', () => {
    expect(s.dnsQueries).toEqual([{ name: 'evil.example', type: 'A', answers: ['203.0.113.7'] }]);
    expect(s.tlsServerNames).toEqual(['evil.example']);
    expect(s.httpRequests).toEqual(['GET dl.example/payload.bin']);
  });

  it('marks answered vs unanswered connections and names destinations', () => {
    const https = s.flows.find((f) => f.dst === '203.0.113.7' && f.dport === 443)!;
    expect(https.unanswered).toBe(false);
    expect(https.names).toEqual(['evil.example']);
    expect(s.flows.find((f) => f.dst === '192.168.1.10')!.unanswered).toBe(true);
  });

  it('leaves out the host control session', () => {
    expect(s.flows.some((f) => f.proto === 'tcp' && f.dst === '10.10.10.1')).toBe(false);
  });

  it('rejects non-pcap input', () => {
    expect(() => summarizePcap(new Uint8Array(40))).toThrow(/not a pcap/);
  });
});

describe('tcpdumpCommand', () => {
  it('targets the VM tap and streams pcap to stdout', () => {
    expect(tcpdumpCommand(2101)).toBe('exec tcpdump -i tap2101i0 -U -s 0 -w -');
    expect(tcpdumpCommand(2101, 'not port 22')).toBe('exec tcpdump -i tap2101i0 -U -s 0 -w - not port 22');
  });

  it('refuses shell metacharacters and bad vmids', () => {
    expect(() => tcpdumpCommand(2101, 'port 1; rm -rf /')).toThrow(/BPF/);
    expect(() => tcpdumpCommand(2101, '$(id)')).toThrow(/BPF/);
    expect(() => tcpdumpCommand(0)).toThrow(/vmid/);
  });
});
