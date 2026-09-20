/**
 * mcp-smoke — drive any stdio MCP server from the shell.
 *
 *   bun scripts/mcp-smoke.ts [--env K=V ...] :: <command> [args...] <<'EOF'
 *   {"tool":"vm_health","args":{}}
 *   {"tool":"vm_list_templates"}
 *   EOF
 *
 * Reads one JSON call per stdin line, prints each result's structuredContent
 * (or text content) as JSON. With no stdin calls it just lists the tools.
 * Image content is summarized, never dumped.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const argv = process.argv.slice(2);
const sep = argv.indexOf('::');
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: mcp-smoke.ts [--env K=V ...] :: <command> [args...]');
  process.exit(2);
}
const env: Record<string, string> = { ...(process.env as Record<string, string>) };
for (let i = 0; i < sep; i++) {
  if (argv[i] === '--env') {
    const [k, ...v] = (argv[++i] ?? '').split('=');
    env[k!] = v.join('=');
  }
}
const [command, ...args] = argv.slice(sep + 1);

const transport = new StdioClientTransport({ command: command!, args, env, stderr: 'inherit' });
const client = new Client({ name: 'mcp-smoke', version: '0.1.0' });
await client.connect(transport);

const input = process.stdin.isTTY ? '' : await new Response(Bun.stdin.stream()).text();
const calls = input
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => JSON.parse(l) as { tool: string; args?: Record<string, unknown> });

if (calls.length === 0) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name}\t${(t.description ?? '').split('\n')[0]}`);
}

for (const call of calls) {
  const t0 = Date.now();
  const res = await client.callTool({ name: call.tool, arguments: call.args ?? {} }, { timeout: 600_000 });
  const content = (res.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>) ?? [];
  const summary = content.map((c) =>
    c.type === 'image' ? `[image ${c.mimeType} ${Math.round(((c.data?.length ?? 0) * 3) / 4 / 1024)}KiB]` : c.type === 'text' ? undefined : `[${c.type}]`,
  ).filter(Boolean);
  const body = res.structuredContent ?? content.find((c) => c.type === 'text')?.text;
  console.log(JSON.stringify({ tool: call.tool, ms: Date.now() - t0, isError: res.isError ?? false, media: summary, result: body }, null, 2));
}

await client.close();
