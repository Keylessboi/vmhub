/**
 * instructions.ts unit tests — the server instructions constant.
 * Asserts the hard rules every model following this server must see.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_INSTRUCTIONS } from '../instructions.ts';

describe('SERVER_INSTRUCTIONS', () => {
  it('identifies itself as the only sanctioned VM-driving path', () => {
    expect(SERVER_INSTRUCTIONS).toContain('vmhub-mcp');
    expect(SERVER_INSTRUCTIONS).toContain('ONLY sanctioned way');
  });

  it('names every OS family it can drive', () => {
    for (const os of ['hyprland', 'X11', 'Windows', 'macOS', 'Android']) {
      expect(SERVER_INSTRUCTIONS).toContain(os);
    }
  });

  it('forbids shelling out to control the desktop/VM', () => {
    for (const tool of ['grim', 'hyprctl', 'ydotool', 'swaymsg', 'adb', 'scp']) {
      expect(SERVER_INSTRUCTIONS).toContain(tool);
    }
  });

  it('describes the lease workflow (idempotent create, bounded wait, release)', () => {
    expect(SERVER_INSTRUCTIONS).toContain('request_id');
    expect(SERVER_INSTRUCTIONS).toContain('20s');
    expect(SERVER_INSTRUCTIONS).toContain('vm_lease_release');
  });

  it('explains stub adapters and CAPABILITY_UNAVAILABLE semantics', () => {
    expect(SERVER_INSTRUCTIONS).toContain('stub');
    expect(SERVER_INSTRUCTIONS).toContain('CAPABILITY_UNAVAILABLE');
  });
});
