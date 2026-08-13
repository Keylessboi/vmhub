/**
 * Screenshot artifact writing. All adapters hand back bytes; vmhub-mcp owns
 * where they land on the host: VMHUB_SCREENSHOT_DIR (default ~/Pictures/vmhub).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ScreenshotResult } from '../shared/types.ts';

export function screenshotDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.VMHUB_SCREENSHOT_DIR ?? join(homedir(), 'Pictures', 'vmhub');
}

export interface WrittenScreenshot {
  file: string;
  width: number;
  height: number;
  format: ScreenshotResult['format'];
  coordMapping: ScreenshotResult['coordMapping'];
  orientation?: 'portrait' | 'landscape';
}

/** Persist a capture; returns the absolute path plus capture metadata. */
export async function writeScreenshot(vmUuid: string, shot: ScreenshotResult, env: NodeJS.ProcessEnv = process.env): Promise<WrittenScreenshot> {
  const dir = screenshotDir(env);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `vm-${vmUuid.slice(0, 8)}-${stamp}.${shot.format}`);
  await writeFile(file, shot.image);
  return {
    file,
    width: shot.width,
    height: shot.height,
    format: shot.format,
    coordMapping: shot.coordMapping,
    ...(shot.orientation ? { orientation: shot.orientation } : {}),
  };
}
