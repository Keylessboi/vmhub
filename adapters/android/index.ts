/**
 * Android mock adapter — E2E demo. Real path is host-side ADB (v1) in Phase 3.
 */
import { MockAdapter } from '../_mock.ts';

export const androidAdapter = new MockAdapter({
  id: 'android',
  os: 'android',
  windowing: [],
  input: ['click', 'type', 'key', 'paste', 'drag', 'gesture', 'touch'],
  semantic: 'uiautomator',
  files: ['adb'],
  exec: true,
  notes: 'Mock: E2E demo only. Real path: host-side ADB.',
  screenshot: { width: 1080, height: 2340, color: [124, 77, 255], orientation: 'portrait' },
  windowCount: 2,
});
