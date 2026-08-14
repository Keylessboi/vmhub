/**
 * WindowsAdapter unit tests — pure logic only (no live CursorTouch server):
 * capability declaration, availableTools, and the content helpers.
 * Live-server behavior is exercised e2e against the golden, not here.
 */
import { describe, expect, it } from 'vitest';
import { CURSORTOUCH_PORT, WindowsAdapter, textContent } from '../windows/index.ts';

const adapter = new WindowsAdapter();

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
