/**
 * Windows mock adapter — E2E demo. Real driver connects to the in-VM
 * CursorTouch server (pinned) in Phase 3.
 */
import { MockAdapter } from '../_mock.ts';

export const windowsAdapter = new MockAdapter({
  id: 'windows',
  os: 'windows',
  windowing: ['windows'],
  input: ['click', 'type', 'key', 'paste', 'drag'],
  semantic: 'uia',
  files: ['sftp'],
  exec: true,
  notes: 'Mock: E2E demo only. Real path: in-VM CursorTouch server.',
  screenshot: { width: 800, height: 600, color: [0, 121, 107] },
  windowCount: 3,
});
