/**
 * Where a new terminal starts: the selected workspace wins over everything,
 * with the default (notes dir) workspace as the fallback.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

// terminal-open imports the session facade, whose module graph reaches the
// Tauri plugins — only getDefaultWorkspacePath matters here.
const defaultWorkspacePath = vi.fn<() => string | null>(() => null);
vi.mock('../session', () => ({
  getDefaultWorkspacePath: () => defaultWorkspacePath(),
}));

import { uiStore } from '../stores/ui';
import { workspaceCwd } from '../terminal-open';

describe('workspaceCwd', () => {
  beforeEach(() => {
    uiStore.getState().setSelectedExplorerDir(null);
    defaultWorkspacePath.mockReturnValue(null);
  });

  test('falls back to the default workspace when nothing is selected', () => {
    defaultWorkspacePath.mockReturnValue('/home/u/notes');
    expect(workspaceCwd()).toBe('/home/u/notes');
  });

  test('the explorer selection wins over the default workspace', () => {
    defaultWorkspacePath.mockReturnValue('/home/u/notes');
    uiStore.getState().setSelectedExplorerDir('/home/u/code/project');
    expect(workspaceCwd()).toBe('/home/u/code/project');
  });

  test('a synced (saf://) selection has no spawnable path', () => {
    uiStore.getState().setSelectedExplorerDir('saf://token/docs');
    expect(workspaceCwd()).toBeNull();
  });

  test('null when there is no workspace at all', () => {
    expect(workspaceCwd()).toBeNull();
  });
});
