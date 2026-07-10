/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// Single source of truth for the version shown in Settings (plan.md §7 keeps
// package.json, tauri.conf.json and Cargo.toml in agreement).
import { version } from './package.json';

export default defineConfig({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  // Tauri-recommended dev-server settings: fixed port, no screen clearing
  // (Tauri CLI output shares the terminal), ignore src-tauri for HMR.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],

  build: {
    // Windows uses WebView2 (Chromium), macOS/Linux use WebKit.
    target: ['es2022', 'chrome105', 'safari15'],
    sourcemap: false,
  },

  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
