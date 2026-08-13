/**
 * X11 mock adapter — E2E demo. Real X11 driver lands in Phase 3.
 */
import { MockAdapter } from '../_mock.ts';

export const x11Adapter = new MockAdapter({
  id: 'x11',
  os: 'x11',
  windowing: ['x11'],
  input: ['click', 'type', 'key', 'paste', 'drag'],
  semantic: 'uia',
  files: ['scp'],
  exec: true,
  notes: 'Mock: E2E demo only.',
  screenshot: { width: 800, height: 600, color: [52, 101, 164] },
  windowCount: 3,
});
