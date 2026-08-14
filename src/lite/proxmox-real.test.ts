/**
 * proxmox-real.ts helper tests — pure logic that needs no live Proxmox:
 * osFromTemplateName (golden name → adapter OS family mapping).
 */
import { describe, expect, it } from 'vitest';
import { osFromTemplateName } from './proxmox-real.ts';

describe('osFromTemplateName', () => {
  it('maps golden names to their OS family', () => {
    expect(osFromTemplateName('hyprland-2404')).toBe('hyprland');
    expect(osFromTemplateName('x11-2404')).toBe('x11');
    expect(osFromTemplateName('ubuntu-x11')).toBe('x11');
    expect(osFromTemplateName('windows-11-24h2')).toBe('windows');
    expect(osFromTemplateName('win11-builder')).toBe('windows');
    expect(osFromTemplateName('android-9-golden')).toBe('android');
    expect(osFromTemplateName('debian-13-golden')).toBe('headless');
  });

  it('is case-insensitive', () => {
    expect(osFromTemplateName('Hyprland-2404')).toBe('hyprland');
    expect(osFromTemplateName('WINDOWS-11')).toBe('windows');
  });

  it('maps macos/ios names to their families', () => {
    expect(osFromTemplateName('macos-14')).toBe('macos');
    expect(osFromTemplateName('mac-ventura')).toBe('macos');
    expect(osFromTemplateName('ios-sim')).toBe('ios');
  });

  it('falls back to headless for unknown names', () => {
    expect(osFromTemplateName('unknown-box')).toBe('headless');
    expect(osFromTemplateName(undefined)).toBe('headless');
    expect(osFromTemplateName('')).toBe('headless');
  });
});
