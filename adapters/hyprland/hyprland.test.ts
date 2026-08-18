/**
 * hyprland adapter unit tests — pure logic only (no live Hyprland server):
 * binary resolution, launcher path, tool map, capability declaration,
 * availableTools, and error mapping.
 * Live-server behavior is exercised e2e against the golden, not here.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_HYPRLAND_MCP_BIN, hyprlandAdapter, hyprlandMcpBin, HYPRLAND_TOOL_MAP, IN_VM_LAUNCHER } from './index.ts';
import { mapHyprlandError } from './index.ts';

describe('hyprlandMcpBin / launcher', () => {
  it('defaults to the compiled hyprland-mcp binary path', () => {
    expect(hyprlandMcpBin({})).toBe(DEFAULT_HYPRLAND_MCP_BIN);
  });

  it('honors HYPRLAND_MCP_BIN override', () => {
    expect(hyprlandMcpBin({ HYPRLAND_MCP_BIN: '/opt/bin' })).toBe('/opt/bin');
  });

  it('uses the in-VM launcher path from the golden', () => {
    expect(IN_VM_LAUNCHER).toBe('/usr/local/bin/launch-hypr-mcp');
  });
});

describe('HYPRLAND_TOOL_MAP', () => {
  it('maps every vm_* operation to a hyprland tool', () => {
    expect(HYPRLAND_TOOL_MAP.screenshot).toBe('screenshot');
    expect(HYPRLAND_TOOL_MAP.click).toBe('input_click');
    expect(HYPRLAND_TOOL_MAP.type).toBe('input_type');
    expect(HYPRLAND_TOOL_MAP.key).toBe('input_key');
    expect(HYPRLAND_TOOL_MAP.drag).toBe('input_drag');
    expect(HYPRLAND_TOOL_MAP.launch).toBe('launch');
    expect(HYPRLAND_TOOL_MAP.focus).toBe('focus');
    expect(HYPRLAND_TOOL_MAP.close).toBe('close');
    expect(HYPRLAND_TOOL_MAP.dispatch).toBe('dispatch');
  });
});

describe('HyprlandAdapter capability declaration', () => {
  it('declares the hyprland adapter id and os', () => {
    expect(hyprlandAdapter.id).toBe('hyprland');
    expect(hyprlandAdapter.capability.os).toBe('hyprland');
    expect(hyprlandAdapter.capability.windowing).toEqual(['hyprland']);
  });

  it('declares input + no exec (hyprland-mcp has no exec tool)', () => {
    expect(hyprlandAdapter.capability.input).toEqual(['click', 'type', 'key', 'paste', 'drag']);
    expect(hyprlandAdapter.capability.exec).toBe(false);
    expect(hyprlandAdapter.capability.files).toEqual([]);
  });
});

describe('HyprlandAdapter availableTools', () => {
  it('serves the desktop tool surface it can drive', () => {
    const tools = hyprlandAdapter.availableTools();
    for (const t of ['screenshot', 'inspect', 'list_windows', 'click', 'type', 'key', 'paste', 'drag', 'launch', 'focus', 'close', 'dispatch']) {
      expect(tools).toContain(t);
    }
  });

  it('does not advertise exec', () => {
    expect(hyprlandAdapter.availableTools()).not.toContain('exec');
  });
});

describe('mapHyprlandError', () => {
  it('maps WINDOW_NOT_FOUND to NOT_FOUND', () => {
    const e = mapHyprlandError({ code: 'WINDOW_NOT_FOUND', message: 'no such window', hint: 'check id' }, 'focus');
    expect(e.code).toBe('NOT_FOUND');
  });

  it('maps INVALID_ARGUMENTS to INVALID_REQUEST', () => {
    const e = mapHyprlandError({ code: 'INVALID_ARGUMENTS', message: 'bad arg' }, 'click');
    expect(e.code).toBe('INVALID_REQUEST');
  });

  it('maps PERMISSION_DENIED to CAPABILITY_UNAVAILABLE', () => {
    const e = mapHyprlandError({ code: 'PERMISSION_DENIED', message: 'nope' }, 'launch');
    expect(e.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  it('maps MISSING_BINARY to INTERNAL with an install detail', () => {
    const e = mapHyprlandError({ code: 'MISSING_BINARY', message: 'grim missing' }, 'screenshot');
    expect(e.code).toBe('INTERNAL');
    expect(e.detail).toContain('install');
  });

  it('falls back to INTERNAL for unknown codes', () => {
    const e = mapHyprlandError({ code: 'SOMETHING_ELSE', message: 'weird' }, 'type');
    expect(e.code).toBe('INTERNAL');
  });

  it('handles an undefined error object (wrapped INTERNAL)', () => {
    const e = mapHyprlandError(undefined, 'click');
    expect(e.code).toBe('INTERNAL');
    expect(e.message).toContain('click');
  });
});

describe('HyprlandAdapter no-IP guard', () => {
  it('throws typed VmError when VM has no IP', async () => {
    const vmNoIp = {
      uuid: 'test-vm-noip',
      nodeId: 'local',
      templateId: 'hyprland',
      adapter: 'hyprland',
      capabilities: [],
      proxmoxTag: 'vmhub-test-test-vm-noip',
      namePrefix: 'test',
      status: 'ready' as const,
      createdAt: Date.now(),
    };
    await expect(hyprlandAdapter.screenshot(vmNoIp)).rejects.toThrow(/no IP/);
  });
});
