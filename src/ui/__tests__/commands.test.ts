/**
 * Sanity coverage for the palette command table. The commands' behavior lives
 * in the session controller / stores (tested elsewhere); here we only assert
 * the table itself is well-formed.
 */
import { describe, expect, test, vi } from 'vitest';

// commands.ts imports the session facade (whose module graph reaches Tauri
// plugins) and the fullscreen controller (@tauri-apps/api/window) — neither is
// exercised here. Stub both so importing the table stays side-effect free.
vi.mock('../session', () => ({
  addWorkspace: vi.fn(),
  closeAllTabs: vi.fn(),
  closeTab: vi.fn(),
  openDocs: vi.fn(),
  openExportPreview: vi.fn(),
  openFile: vi.fn(),
  saveActiveTab: vi.fn(),
  saveActiveTabAs: vi.fn(),
}));
vi.mock('../fullscreen', () => ({
  cycleFullscreen: vi.fn(),
}));

import { buildCommands } from '../commands';

describe('buildCommands', () => {
  test('ids are unique and kebab-case', () => {
    const ids = buildCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  test('every command has a non-empty title and a run function', () => {
    for (const cmd of buildCommands()) {
      expect(cmd.title.trim().length).toBeGreaterThan(0);
      expect(typeof cmd.run).toBe('function');
    }
  });

  test('enabled guards are callable and boolean-valued', () => {
    for (const cmd of buildCommands()) {
      if (cmd.enabled) {
        expect(typeof cmd.enabled()).toBe('boolean');
      }
    }
  });

  test('the table covers the expected command set', () => {
    const ids = new Set(buildCommands().map((c) => c.id));
    for (const expected of [
      'new-tab',
      'close-tab',
      'close-all-tabs',
      'next-tab',
      'prev-tab',
      'rename-tab',
      'open-file',
      'save',
      'save-as',
      'export',
      'mode-raw',
      'mode-split',
      'mode-rich',
      'mode-read',
      'font-increase',
      'font-decrease',
      'font-reset',
      'toggle-fullscreen',
      'open-settings',
      'toggle-explorer',
      'open-docs',
      'add-workspace',
    ]) {
      expect(ids).toContain(expected);
    }
  });
});
