/**
 * files.ts unit tests — screenshot artifact writing.
 * Uses a temp dir so no real filesystem state is touched.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { screenshotDir, writeScreenshot } from '../files.ts';

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vmhub-files-test-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('screenshotDir', () => {
  it('defaults to ~/Pictures/vmhub', () => {
    const dir = screenshotDir({});
    expect(dir).toContain('Pictures');
    expect(dir.endsWith('vmhub')).toBe(true);
  });

  it('honors VMHUB_SCREENSHOT_DIR', () => {
    expect(screenshotDir({ VMHUB_SCREENSHOT_DIR: '/tmp/screens' })).toBe('/tmp/screens');
  });
});

describe('writeScreenshot', () => {
  it('persists a PNG and returns metadata', async () => {
    const shot = {
      image: Buffer.from('fake-png-bytes'),
      format: 'png' as const,
      width: 800,
      height: 600,
      coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 },
    };
    const written = await writeScreenshot('uuid-1234', shot, { VMHUB_SCREENSHOT_DIR: tmp });

    expect(written.file).toContain(`vm-uuid-123`);
    expect(written.file).toMatch(/\.png$/);
    expect(written.width).toBe(800);
    expect(written.height).toBe(600);

    const bytes = await readFile(written.file);
    expect(bytes.toString()).toBe('fake-png-bytes');
  });

  it('creates the directory if missing', async () => {
    const nested = join(tmp, 'deep', 'nested');
    const written = await writeScreenshot(
      'u2',
      { image: Buffer.from('x'), format: 'jpg' as const, width: 0, height: 0, coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 } },
      { VMHUB_SCREENSHOT_DIR: nested },
    );
    expect(written.file).toMatch(/\.jpg$/);
    expect(written.file).toContain(nested);
  });

  it('passes through orientation when the adapter provides it', async () => {
    const written = await writeScreenshot(
      'u3',
      { image: Buffer.from('y'), format: 'png' as const, width: 10, height: 20, coordMapping: { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 }, orientation: 'portrait' },
      { VMHUB_SCREENSHOT_DIR: tmp },
    );
    expect(written.orientation).toBe('portrait');
  });
});
