/**
 * AndroidAdapter unit tests — pure logic only (no live adbd server):
 * capability declaration, availableTools, keycode mapping.
 * Live ADB behavior is exercised e2e against the android-9-golden, not here.
 */
import { describe, expect, it } from 'vitest';
import { ADB_PORT, AndroidAdapter, androidAdapter } from './index.ts';
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

describe('adb invocation (bug sweep regressions)', () => {
  const vm = { uuid: 'a1', ip: '10.10.10.70' } as any;
  function recording() {
    const a = new AndroidAdapter();
    const calls: string[][] = [];
    (a as any).run = async (_file: string, args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    };
    return { a, calls };
  }

  it('targets the leased device with -s on every call (two Android VMs leased at once)', async () => {
    const { a, calls } = recording();
    await a.input(vm, { kind: 'click', x: 1, y: 2 });
    const shell = calls.find((c) => c.includes('shell'))!;
    expect(shell.slice(0, 2)).toEqual(['-s', '10.10.10.70:5555']);
  });

  it('typed text survives the device shell: quotes, spaces, $() are literal', async () => {
    const { a, calls } = recording();
    const text = `it's a $(reboot) test`;
    await a.input(vm, { kind: 'type', text });
    const shell = calls.find((c) => c.includes('shell'))!;
    const arg = shell[shell.length - 1]!;
    // adb joins shell args with spaces and runs them through sh; round-trip it.
    const { execFileSync } = await import('node:child_process');
    const seen = execFileSync('sh', ['-c', `printf %s ${arg}`], { encoding: 'utf8' });
    expect(seen).toBe(text.replace(/ /g, '%s')); // `input text` reads %s as a space
  });
});

describe('keycode mapping for names Android does not know lower-cased', () => {
  it('maps backspace/space/esc and upper-cases unknown symbolic names', () => {
    expect(keycode('backspace')).toBe('67');
    expect(keycode('space')).toBe('62');
    expect(keycode('esc')).toBe('111');
    expect(keycode('del')).toBe('KEYCODE_DEL');
    expect(keycode('KEYCODE_CAMERA')).toBe('KEYCODE_CAMERA');
  });
});
