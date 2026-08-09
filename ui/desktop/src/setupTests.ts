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
