/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // ui/shared lives outside this app's root; Vite's dev server denies
    // filesystem access outside root by default.
    fs: {
      allow: ['.', '../shared'],
    },
  },
  // maplibre-gl loads its tile-processing code in a Web Worker built from
  // a separate entry (maplibre-gl-worker.mjs). Vite's dependency
  // pre-bundler doesn't follow that indirection, so the optimized file
  // periodically goes missing from node_modules/.vite/deps -- symptom:
  // "The file does not exist at .../maplibre-gl-worker.mjs" in the
  // console, and any UI that depends on the map failing silently
  // afterward (Batch/Geocode/Reverse geocode all mount a MapView).
  // Excluding it here means Vite serves it unbundled instead, which
  // sidesteps the broken optimization entirely.
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
  },
});
