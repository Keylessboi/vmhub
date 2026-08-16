/**
 * Adapter registry — the set of DesktopAdapters vmhub-mcp can drive.
 *
 * Lazy singletons: importing the registry (or the server) never touches
 * Hyprland or any other transport. The hyprland adapter connects on first use.
 * Tests can register stub adapters via createRegistry() to exercise gating.
 */
import type { DesktopAdapter } from '../src/shared/types.ts';
import { hyprlandAdapter } from './hyprland/index.ts';
import { x11Adapter } from './x11/index.ts';
import { windowsAdapter } from './windows/index.ts';
import { macosAdapter } from './macos/index.ts';
import { androidAdapter } from './android/index.ts';
import { iosAdapter } from './ios/index.ts';
import { headlessAdapter } from './headless/index.ts';
import { MacosLocalAdapter } from './macos-local/index.ts';

export interface AdapterRegistry {
  /** All registered adapter ids, sorted (stable catalog order). */
  ids(): string[];
  has(id: string): boolean;
  get(id: string): DesktopAdapter;
}

export class Registry implements AdapterRegistry {
  private readonly adapters = new Map<string, DesktopAdapter>();

  constructor(initial?: Record<string, DesktopAdapter>) {
    if (initial) {
      for (const [id, adapter] of Object.entries(initial)) {
        this.register(id, adapter);
      }
    }
  }

  register(id: string, adapter: DesktopAdapter): void {
    this.adapters.set(id, adapter);
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  get(id: string): DesktopAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`unknown adapter "${id}" (known: ${this.ids().join(', ')})`);
    }
    return adapter;
  }
}

/** The production registry: one adapter per OS family, per the plan. */
export function defaultRegistry(): AdapterRegistry {
  return new Registry({
    hyprland: hyprlandAdapter,
    x11: x11Adapter,
    windows: windowsAdapter,
    macos: macosAdapter,
    "macos-local": new MacosLocalAdapter(),
    android: androidAdapter,
    ios: iosAdapter,
    headless: headlessAdapter,
  });
}

let singleton: AdapterRegistry | null = null;

/** Lazy shared registry for the stdio server. */
export function getDefaultRegistry(): AdapterRegistry {
  singleton ??= defaultRegistry();
  return singleton;
}
