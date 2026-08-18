import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vite.config.ts doesn't set test.globals, so testing-library can't
// auto-detect afterEach to register its own cleanup -- without this,
// each render() in a test file with more than one leaves its DOM behind
// for the next test, silently producing "multiple elements found"
// failures in any later test that renders the same component again.
afterEach(() => {
  cleanup();
});

// jsdom (vitest's default test environment, see vite.config.ts) doesn't
// implement matchMedia -- deviceDetection.ts's isStandalone() calls it
// unconditionally (InstallAppBanner renders on every App mount), so
// without a stub every test that renders <App /> throws
// "window.matchMedia is not a function" before it gets anywhere near
// the behavior actually under test. `matches: false` is enough for
// tests: none of them assert standalone-mode-specific UI.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}
