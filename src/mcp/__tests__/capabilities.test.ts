/**
 * capabilities.ts unit tests — the adapter→template catalog mapping.
 * Pure logic: templateFromAdapter, templateCatalog, getTemplate,
 * capabilityReport, assertToolAvailable. No host needed.
 */
import { describe, expect, it } from 'vitest';
import { Registry } from '../../../adapters/index.ts';
import { x11Adapter } from '../../../adapters/x11/index.ts';
import { hyprlandAdapter } from '../../../adapters/hyprland/index.ts';
import { headlessAdapter } from '../../../adapters/headless/index.ts';
import { windowsAdapter } from '../../../adapters/windows/index.ts';
import { iosAdapter } from '../../../adapters/ios/index.ts';
import type { DesktopAdapter } from '../../../src/shared/types.ts';
import {
  assertToolAvailable,
  capabilityReport,
  getTemplate,
  templateCatalog,
  templateFromAdapter,
} from '../capabilities.ts';

function registry() {
  return new Registry({ x11: x11Adapter, windows: windowsAdapter, ios: iosAdapter });
}

describe('templateFromAdapter', () => {
  it('derives a Template from an available adapter', () => {
    const t = templateFromAdapter(x11Adapter);
    expect(t.id).toBe('x11');
    expect(t.os).toBe('x11');
    expect(t.availability).toBe('available');
    expect(t.capabilities.length).toBeGreaterThan(0);
  });

  it('marks stub adapters as stub with a reason (never hidden)', () => {
    const t = templateFromAdapter(iosAdapter);
    expect(t.availability).toBe('stub');
    expect(t.reason).toBeTruthy();
  });
});

describe('templateCatalog', () => {
  it('returns one template per registered adapter', () => {
    const catalog = templateCatalog(registry());
    const ids = catalog.map((t) => t.id).sort();
    expect(ids).toEqual(['ios', 'windows', 'x11']);
  });
});

describe('getTemplate', () => {
  it('returns the template for a known id', () => {
    expect(getTemplate(registry(), 'windows').id).toBe('windows');
  });

  it('throws a typed NOT_FOUND VmError for unknown ids', () => {
    try {
      getTemplate(registry(), 'nope');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});

describe('capabilityReport', () => {
  it('reports the adapter capability + available tools', () => {
    const report = capabilityReport(windowsAdapter);
    expect(report.adapter).toBe('windows');
    expect(report.os).toBe('windows');
    expect(report.availableTools).toContain('screenshot');
  });
});

describe('assertToolAvailable', () => {
  it('does not throw when the adapter serves the tool', () => {
    expect(() => assertToolAvailable('vm_screenshot', windowsAdapter)).not.toThrow();
  });

  it('throws CAPABILITY_UNAVAILABLE when the tool is not on the surface', () => {
    // put_file is not in WindowsAdapter.availableTools() (no sftp on CursorTouch).
    try {
      assertToolAvailable('vm_put_file', windowsAdapter);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    }
  });
});

describe('shared per-OS capability map mirrors adapter surfaces (drift guard, T4b)', () => {
  // src/shared/os-capabilities.ts lands in T4b; the non-literal specifier
  // keeps tsc green while these tests are red ("Cannot find module").
  async function osCapabilities(os: string): Promise<string[]> {
    const mod = await import('../../shared/os-capabilities.ts' + '');
    return (mod as { osCapabilities(os: string): string[] }).osCapabilities(os);
  }

  const adapterCases: Array<[string, DesktopAdapter]> = [
    ['x11', x11Adapter],
    ['hyprland', hyprlandAdapter],
    ['headless', headlessAdapter],
    ['windows', windowsAdapter],
  ];

  for (const [os, adapter] of adapterCases) {
    it(`osCapabilities('${os}') equals ${adapter.id}.availableTools()`, async () => {
      const map = await osCapabilities(os);
      expect([...map].sort()).toEqual([...adapter.availableTools()].sort());
    });
  }
});
