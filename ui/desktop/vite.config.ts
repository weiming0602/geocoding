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
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
  },
});
