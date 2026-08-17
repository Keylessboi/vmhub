/**
 * WindowsAdapter unit tests — pure logic only (no live CursorTouch server):
 * capability declaration, availableTools, the content helpers, and
 * screenshot dimension validation.
 * Live-server behavior is exercised e2e against the golden, not here.
 */
import { describe, expect, it, vi } from 'vitest';
import { CURSORTOUCH_PORT, WindowsAdapter, textContent, pngDimensions } from '../windows/index.ts';
import type { Vm } from '../../src/shared/types.ts';

const adapter = new WindowsAdapter();

const vm: Vm = {
  uuid: 'u1',
  nodeId: 'dl360p',
  templateId: 'tpl',
  adapter: 'windows',
  capabilities: ['screenshot'],
  proxmoxTag: 'vmhub-w-u1',
  namePrefix: 'w',
  status: 'ready',
  ip: '10.10.10.60',
  createdAt: 0,
};

describe('WindowsAdapter capability declaration', () => {
  it('declares the windows adapter id and os', () => {
    expect(adapter.id).toBe('windows');
    expect(adapter.capability.os).toBe('windows');
    expect(adapter.capability.windowing).toEqual(['windows']);
  });

  it('declares input + no exec (exec goes through PowerShell tool)', () => {
    expect(adapter.capability.input).toEqual(['click', 'type', 'key', 'paste', 'drag']);
    expect(adapter.capability.exec).toBe(false);
    expect(adapter.capability.files).toEqual([]);
  });

  it('notes the transport in the capability', () => {
    expect(adapter.capability.notes).toContain('CursorTouch');
  });
});

describe('WindowsAdapter availableTools', () => {
  it('serves the full desktop tool surface', () => {
    const tools = adapter.availableTools();
    for (const t of ['screenshot', 'inspect', 'list_windows', 'click', 'type', 'key', 'paste', 'drag', 'launch', 'focus', 'close']) {
      expect(tools).toContain(t);
    }
  });

  it('does not advertise exec (not served)', () => {
    expect(adapter.availableTools()).not.toContain('exec');
  });
});

describe('WindowsAdapter constants', () => {
  it('defaults to the CursorTouch port 8000', () => {
    expect(CURSORTOUCH_PORT).toBe(8000);
  });
});

describe('textContent helper', () => {
  it('returns the text from an MCP text block', () => {
    const content = [{ type: 'text' as const, text: 'hello' }];
    expect(textContent(content)).toBe('hello');
  });

  it('returns undefined when no text block present', () => {
    const content = [{ type: 'image' as const, data: 'abc', mimeType: 'image/png' }];
    expect(textContent(content)).toBeUndefined();
  });

  it('returns undefined on empty content', () => {
    expect(textContent([])).toBeUndefined();
  });
});

describe('pngDimensions helper', () => {
  it('returns correct dimensions from PNG IHDR chunk', () => {
    const buf = Buffer.alloc(24);
    buf.writeUInt32BE(0x89504e47, 0);
    buf.writeUInt32BE(1920, 16);
    buf.writeUInt32BE(1080, 20);
    const { width, height } = pngDimensions(buf);
    expect(width).toBe(1920);
    expect(height).toBe(1080);
  });

  it('returns 0 for non-PNG buffer', () => {
    const buf = Buffer.alloc(32);
    buf.writeUInt32BE(0x00000000, 0);
    const { width, height } = pngDimensions(buf);
    expect(width).toBe(0);
    expect(height).toBe(0);
  });

  it('returns 0 for buffer too small for IHDR', () => {
    const buf = Buffer.alloc(10);
    const { width, height } = pngDimensions(buf);
    expect(width).toBe(0);
    expect(height).toBe(0);
  });
});

describe('screenshot dimension validation', () => {
  function makeFakeConnection(imageBuf: Buffer) {
    return {
      client: {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'image', data: imageBuf.toString('base64'), mimeType: 'image/png' }],
        }),
      },
      transport: {},
    };
  }

  it('throws INTERNAL when screenshot returns zero dimensions', async () => {
    const adapter = new WindowsAdapter();
    const zeroBuf = Buffer.alloc(24);
    zeroBuf.writeUInt32BE(0x89504e47, 0);
    (adapter as any).conns.set('test-vm', makeFakeConnection(zeroBuf));

    await expect(
      adapter.screenshot({ uuid: 'test-vm', ip: '127.0.0.1' } as any),
    ).rejects.toThrow('windows screenshot returned no dimensions');
  });

  it('returns actual dimensions from valid PNG', async () => {
    const adapter = new WindowsAdapter();
    const pngBuf = Buffer.alloc(24);
    pngBuf.writeUInt32BE(0x89504e47, 0);
    pngBuf.writeUInt32BE(800, 16);
    pngBuf.writeUInt32BE(600, 20);
    (adapter as any).conns.set('test-vm', makeFakeConnection(pngBuf));

    const result = await adapter.screenshot({ uuid: 'test-vm', ip: '127.0.0.1' } as any);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });
});

describe('VM existence check', () => {
  it('throws PROVISION_FAILED when VM status is error', async () => {
    const adapter = new WindowsAdapter();
    await expect(
      adapter.screenshot({ ...vm, status: 'error', ip: undefined }),
    ).rejects.toThrow(/does not exist on Proxmox/);
  });

  it('throws PROVISION_FAILED when VM status is destroyed', async () => {
    const adapter = new WindowsAdapter();
    await expect(
      adapter.screenshot({ ...vm, status: 'destroyed', ip: undefined }),
    ).rejects.toThrow(/does not exist on Proxmox/);
  });
});
