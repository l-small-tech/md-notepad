/**
 * The ONLY place `@tauri-apps/plugin-store` is touched (same layering rule as
 * commands.ts owning `invoke`): settings persist to `settings.json` in the app
 * data dir via the store plugin. Session data deliberately does NOT use this —
 * it needs the explicit write ordering (I4) the store plugin can't promise
 * (plan.md §9 decision log); this is for user preferences only.
 *
 * Reads return raw `unknown`; `normalizeSettings` (core) is the single choke
 * point that turns anything — missing file, hand-edited garbage, older schema —
 * into a valid `Settings`. A load failure (no file yet, unreadable) surfaces as
 * `null` so the caller falls back to defaults rather than crashing at boot.
 */

import { load, type Store } from '@tauri-apps/plugin-store';

const STORE_FILE = 'settings.json';
const SETTINGS_KEY = 'settings';

let storePromise: Promise<Store> | null = null;

/** Lazily open (and cache) the plugin store. autoSave off — we save explicitly. */
function getStore(): Promise<Store> {
  if (!storePromise) {
    // Don't cache a rejected promise: a transient open failure must not poison
    // every later save for the whole session — clear it so the next call retries.
    storePromise = load(STORE_FILE, { autoSave: false, defaults: {} }).catch((error) => {
      storePromise = null;
      throw error;
    });
  }
  return storePromise;
}

/** The persisted settings blob, or `null` if none exists / the store won't open. */
export async function loadPersistedSettings(): Promise<unknown> {
  try {
    const store = await getStore();
    return (await store.get(SETTINGS_KEY)) ?? null;
  } catch {
    // First launch (no file) or a corrupt store: defaults apply upstream.
    return null;
  }
}

/** Persist the settings blob (already normalized by the caller). */
export async function savePersistedSettings(settings: unknown): Promise<void> {
  const store = await getStore();
  await store.set(SETTINGS_KEY, settings);
  await store.save();
}
