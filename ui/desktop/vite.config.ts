/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The Road Alerts site (alerts.meridiangeocoding.com -- see
// src/siteConfig.ts) is the same app built with VITE_APP=road-alerts; its
// page title, Add-to-Home-Screen identity and link-preview URLs are static
// HTML, so they're swapped here rather than at runtime.
function roadAlertsSiteHtml(): Plugin {
  return {
    name: 'road-alerts-site-html',
    transformIndexHtml(html) {
      return html
        .replace(/<title>[^<]*<\/title>/, '<title>Meridian Road Alerts — live traffic hazards ahead of you</title>')
        .replace('href="/manifest.webmanifest"', 'href="/road-alerts.webmanifest"')
        .replace('name="apple-mobile-web-app-title" content="Meridian"', 'name="apple-mobile-web-app-title" content="Road Alerts"')
        .replaceAll('https://www.meridiangeocoding.com/', 'https://alerts.meridiangeocoding.com/');
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(loadEnv(mode, process.cwd(), 'VITE_').VITE_APP === 'road-alerts' ? [roadAlertsSiteHtml()] : [])],
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
}));
