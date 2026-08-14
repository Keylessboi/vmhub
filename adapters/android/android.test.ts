/**
 * AndroidAdapter unit tests — pure logic only (no live adbd server):
 * capability declaration, availableTools, keycode mapping.
 * Live ADB behavior is exercised e2e against the android-9-golden, not here.
 */
import { describe, expect, it } from 'vitest';
import { ADB_PORT, androidAdapter } from './index.ts';
import { keycode } from './index.ts';

describe('AndroidAdapter capability declaration', () => {
  it('declares the android adapter id and os', () => {
    expect(androidAdapter.id).toBe('android');
    expect(androidAdapter.capability.os).toBe('android');
    expect(androidAdapter.capability.windowing).toEqual([]);
  });

  it('declares exec + adb file transport', () => {
    expect(androidAdapter.capability.exec).toBe(true);
    expect(androidAdapter.capability.files).toEqual(['adb']);
  });

  it('notes the ADB transport', () => {
    expect(androidAdapter.capability.notes).toContain('ADB');
  });
});

describe('AndroidAdapter availableTools', () => {
  it('serves the tool surface ADB can drive', () => {
    const tools = androidAdapter.availableTools();
    for (const t of ['screenshot', 'inspect', 'click', 'type', 'key', 'paste', 'drag', 'launch', 'exec']) {
      expect(tools).toContain(t);
    }
  });
});

describe('AndroidAdapter constants', () => {
  it('defaults to the ADB port 5555', () => {
    expect(ADB_PORT).toBe(5555);
  });
});

describe('keycode mapping', () => {
  it('maps common chords to Android keyevent codes', () => {
    expect(keycode('home')).toBe('3');
    expect(keycode('back')).toBe('4');
    expect(keycode('enter')).toBe('66');
    expect(keycode('tab')).toBe('61');
    expect(keycode('up')).toBe('19');
    expect(keycode('down')).toBe('20');
  });

  it('is case-insensitive', () => {
    expect(keycode('HOME')).toBe('3');
  });

  it('passes through numeric codes and unknown text', () => {
    expect(keycode('66')).toBe('66');
    expect(keycode('volume_up')).toBe('24');
  });
});
