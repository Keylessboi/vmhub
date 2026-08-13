/**
 * macOS mock adapter — E2E demo. Real driver connects to the in-VM
 * mac-control-mcp server (pinned) in Phase 3.
 */
import { MockAdapter } from '../_mock.ts';

export const macosAdapter = new MockAdapter({
  id: 'macos',
  os: 'macos',
  windowing: ['macos'],
  input: ['click', 'type', 'key', 'paste', 'drag'],
  semantic: 'ax',
  files: ['scp'],
  exec: true,
  notes: 'Mock: E2E demo only. Real path: in-VM mac-control-mcp server.',
  screenshot: { width: 800, height: 600, color: [128, 128, 132] },
  windowCount: 3,
});
