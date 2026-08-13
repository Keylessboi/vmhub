#!/usr/bin/env node
// vmhub iso-server — robust static server with full HTTP Range support.
// The iLO 4 virtual media fetch needs Range requests for the 1.6GB ISO;
// python's SimpleHTTPRequestHandler breaks the pipe on large transfers.
// Usage: node iso-server.mjs <dir> <port>
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const dir = process.argv[2] || '/home/travis/Projects/vmhub/bootstrap';
const port = Number(process.argv[3] || 8010);

const MIME = {
  '.iso': 'application/octet-stream',
  '.img': 'application/octet-stream',
  '.toml': 'text/plain',
  '.dat': 'text/plain',
  '.sh': 'text/plain',
  '.log': 'text/plain',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const filePath = normalize(join(dir, decodeURIComponent(url.pathname)));
    if (!filePath.startsWith(normalize(dir))) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const stat = statSync(filePath);
    const total = stat.size;
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', MIME[extname(filePath)] || 'application/octet-stream');

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end)) end = total - 1;
      if (end >= total) end = total - 1;
      if (start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return;
      }
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      createReadStream(filePath, { start, end }).pipe(res);
      console.log(`[${new Date().toISOString()}] ${req.socket.remoteAddress} RANGE ${start}-${end}/${total} ${url.pathname}`);
    } else {
      res.writeHead(200, { 'Content-Length': total });
      createReadStream(filePath).pipe(res);
      console.log(`[${new Date().toISOString()}] ${req.socket.remoteAddress} GET ${total} ${url.pathname}`);
    }
  } catch (e) {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`iso-server on :${port} serving ${dir} (Range-aware)`);
});
