/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// Single source of truth for the version shown in Settings (releasing keeps
// package.json, tauri.conf.json and Cargo.toml in agreement — README §Releasing).
import { version } from './package.json';

// `tauri android dev` (and iOS) exports TAURI_DEV_HOST with the LAN IP the
// device must reach the dev server on; desktop `tauri dev` never sets it. We
// use its presence to distinguish the two so BOTH can run at once:
//   - desktop  → localhost:1420 (default HMR on the same port)
//   - mobile   → bind the LAN host on 1430, HMR websocket on 1431
// The matching devUrl ports live in tauri.conf.json (desktop, 1420) and
// tauri.android.conf.json (mobile, 1430). Different ports = no collision when
// tauri:dev and android:dev run side by side.
const host = process.env.TAURI_DEV_HOST;
const port = host ? 1430 : 1420;

export default defineConfig({
  plugins: [react()],

  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  // Tauri-recommended dev-server settings: fixed port, no screen clearing
  // (Tauri CLI output shares the terminal), ignore src-tauri for HMR.
  clearScreen: false,
  server: {
    host: host || false,
    port,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: port + 1 } : undefined,
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
