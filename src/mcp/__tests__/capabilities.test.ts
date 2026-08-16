/**
 * capabilities.ts unit tests — the adapter→template catalog mapping.
 * Pure logic: templateFromAdapter, templateCatalog, getTemplate,
 * capabilityReport, assertToolAvailable. No host needed.
 */
import { describe, expect, it } from 'vitest';
import type { Template } from '../../shared/types.ts';
import { Registry } from '../../../adapters/index.ts';
import { x11Adapter } from '../../../adapters/x11/index.ts';
import { windowsAdapter } from '../../../adapters/windows/index.ts';
import { macosAdapter } from '../../../adapters/macos/index.ts';
import { iosAdapter } from '../../../adapters/ios/index.ts';
import {
  assertToolAvailable,
  capabilityReport,
  getTemplate,
  mergeDerivedTemplate,
  templateCatalog,
  templateFromAdapter,
} from '../capabilities.ts';

function registry() {
  return new Registry({ x11: x11Adapter, windows: windowsAdapter, ios: iosAdapter, macos: macosAdapter });
}

describe('templateFromAdapter', () => {
  it('derives a Template from an available adapter', () => {
    const t = templateFromAdapter(x11Adapter);
    expect(t.id).toBe('x11');
    expect(t.os).toBe('x11');
    expect(t.availability).toBe('available');
    expect(t.capabilities.length).toBeGreaterThan(0);
  });

  it('marks conditional adapters unavailable with a reason (never hidden)', () => {
    const t = templateFromAdapter(iosAdapter);
    expect(t.availability).toBe('unavailable');
    expect(t.reason).toBeTruthy();
    expect(t.derivedFrom).toBe('macos');
  });

  it('surfaces derivedFrom + constraints declared by the adapter', () => {
    const ios = templateFromAdapter(iosAdapter);
    expect(ios.derivedFrom).toBe('macos');
    expect(ios.constraints?.[0]?.os).toBe('macos');
    expect(ios.constraints?.[0]?.minRamMb).toBe(10_240);
    expect(ios.constraints?.[0]?.runtime).toBe('ios-simctl@26.3.1');

    const macos = templateFromAdapter(macosAdapter);
    expect(macos.availability).toBe('available');
    expect(macos.constraints?.[0]?.cpu?.avx2).toBe(true);
    expect(macos.nestedVirt).toBe(false);
  });
});

describe('templateCatalog', () => {
  it('returns one template per registered adapter', () => {
    const catalog = templateCatalog(registry());
    const ids = catalog.map((t) => t.id).sort();
    expect(ids).toEqual(['ios', 'macos', 'windows', 'x11']);
  });
});

describe('mergeDerivedTemplate', () => {
  const macosGolden = (overrides: Partial<Template> = {}) =>
    ({
      id: 'macos-sequoia-15.7.9',
      os: 'macos',
      availability: 'available',
      capabilities: ['screenshot'],
      ramMb: 8192,
      vcpus: 4,
      nestedVirt: false,
      notes: 'Golden template macos-sequoia-15.7.9',
      ...overrides,
    }) as Template;

  it('resolves ios through an available version-matched macos golden', () => {
    const merged = mergeDerivedTemplate(templateFromAdapter(iosAdapter), [macosGolden()]);
    expect(merged.availability).toBe('available');
    expect(merged.derivedFrom).toBe('macos');
    expect(merged.notes).toContain('macos 15.7.9');
    expect(merged.reason).toBeUndefined();
  });

  it('stays unavailable when the parent macos golden is missing', () => {
    const merged = mergeDerivedTemplate(templateFromAdapter(iosAdapter), []);
    expect(merged.availability).toBe('unavailable');
    expect(merged.reason).toContain('macos');
  });

  it('stays unavailable when the parent is the wrong macOS version', () => {
    const merged = mergeDerivedTemplate(templateFromAdapter(iosAdapter), [macosGolden({ id: 'macos-14.5', notes: 'Golden template macos-14.5' })]);
    expect(merged.availability).toBe('unavailable');
    expect(merged.reason).toContain('14.5');
  });

  it('stays unavailable when the parent macos golden is not available', () => {
    const merged = mergeDerivedTemplate(templateFromAdapter(iosAdapter), [macosGolden({ availability: 'unavailable' as const })]);
    expect(merged.availability).toBe('unavailable');
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
