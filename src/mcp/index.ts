/**
 * vmhub-mcp — the unified MCP server.
 *
 * One stdio server exposing the 22 vm_* tools (zod 4 schemas) across every
 * OS family through its DesktopAdapter. All lease/provisioning state lives in
 * vmhub-lite (thin REST client); adapters are the only components that know
 * their transport. Capability gating is runtime-only: tools are never absent,
 * unsupported = typed CAPABILITY_UNAVAILABLE.
 *
 * Run:  bun run src/mcp/index.ts        (dev)
 * Build: bun build src/mcp/index.ts --compile --outfile dist/vmhub-mcp
 */
import { McpServer, type McpServerFactory } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { getDefaultRegistry, type AdapterRegistry } from '../../adapters/index.ts';
import { HttpLiteClient, liteBaseUrl, type LiteClient } from './lite-client.ts';
import { registerTools, type McpDeps } from './tools.ts';
import { SERVER_INSTRUCTIONS } from './instructions.ts';

export const SERVER_NAME = 'vmhub-mcp';
export const SERVER_VERSION = '0.1.0';

export interface McpServerOptions {
  lite?: LiteClient;
  registry?: AdapterRegistry;
  liteUrl?: string;
}

/** Build the fully-registered server. Testable via InMemoryTransport. */
export function buildMcpServer(options: McpServerOptions = {}): McpServer {
  const deps: McpDeps = {
    lite: options.lite ?? new HttpLiteClient(),
    registry: options.registry ?? getDefaultRegistry(),
    liteUrl: options.liteUrl ?? liteBaseUrl(),
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, deps);
  return server;
}

export async function main(): Promise<void> {
  const server = buildMcpServer();
  const factory: McpServerFactory = () => server;
  await serveStdio(factory);
}

// Entry point when run directly (bun run src/mcp/index.ts).
if (import.meta.main) {
  main().catch((e) => {
    console.error('vmhub-mcp fatal:', e);
    process.exit(1);
  });
}
