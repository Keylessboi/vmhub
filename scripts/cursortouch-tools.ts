/**
 * Print the in-VM CursorTouch server's tool surface (names + input schemas).
 *
 *   VMHUB_SSH_CONFIG=… VMHUB_JUMP_HOST=… CURSORTOUCH_AUTH_KEY=… \
 *     bun scripts/cursortouch-tools.ts <vm-ip> [tool]
 *
 * The Windows adapter maps vm_* calls onto these tools; when CursorTouch
 * renames or re-shapes one, this is how to see it. The auth key is read from
 * the environment and never printed.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { vmTunnel } from '../adapters/transport.ts';
import { cursorTouchAuthKey, CURSORTOUCH_PORT } from '../adapters/windows/index.ts';

const ip = process.argv[2];
const only = process.argv[3];
if (!ip) {
  console.error('usage: bun scripts/cursortouch-tools.ts <vm-ip> [tool]');
  process.exit(2);
}
const ep = await vmTunnel({ uuid: 'probe', ip, status: 'ready' } as never, Number(process.env.CURSORTOUCH_PORT ?? CURSORTOUCH_PORT));
const client = new Client({ name: 'cursortouch-probe', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://${ep.host}:${ep.port}/mcp/`), {
  requestInit: { headers: { Authorization: `Bearer ${cursorTouchAuthKey()}` } },
}));
const { tools } = await client.listTools();
for (const t of tools) {
  if (only && t.name.toLowerCase() !== only.toLowerCase()) continue;
  const props = (t.inputSchema as { properties?: Record<string, { type?: string; enum?: string[]; description?: string }>; required?: string[] });
  const args = Object.entries(props.properties ?? {})
    .map(([k, v]) => `${k}${(props.required ?? []).includes(k) ? '' : '?'}:${v.enum ? v.enum.join('|') : v.type ?? '?'}`)
    .join(' ');
  console.log(`${t.name}(${args})${only ? `\n  ${(t.description ?? '').slice(0, 400)}` : ''}`);
}
await client.close();
process.exit(0);
