/**
 * index.ts unit tests — buildMcpServer wires the full tool surface.
 * Uses InMemoryTransport (SDK-provided) so no stdio/host is needed.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from '../index.ts';

async function connect() {
  const server = buildMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return { client, server };
}

describe('SERVER_NAME / SERVER_VERSION', () => {
  it('identifies the server', () => {
    expect(SERVER_NAME).toBe('vmhub-mcp');
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('buildMcpServer', () => {
  it('serves the full 23-tool surface', async () => {
    const { client } = await connect();
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(23);
    const names = tools.tools.map((t) => t.name);
    for (const tool of ['vm_list_templates', 'vm_list_vms', 'vm_lease_create', 'vm_screenshot', 'vm_click', 'vm_lease_release']) {
      expect(names).toContain(tool);
    }
  });

  it('reports its identity in initialize', async () => {
    const { client } = await connect();
    const info = client.getServerVersion();
    expect(info?.name).toBe(SERVER_NAME);
  });
});
