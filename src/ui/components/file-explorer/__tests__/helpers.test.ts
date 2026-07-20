/**
 * Pure-helper coverage for the file explorer: the file-type badge and the
 * drawer-width clamp. `listWithTimeout` (the only helper touching the session
 * layer) is exercised through the app, not here — mocking the session module
 * keeps this suite in plain node like the rest of the pure-logic tests.
 */
import { describe, expect, test, vi } from 'vitest';

// helpers.ts imports listNoteFiles from the session controller, whose module
// graph reaches Tauri plugins and the store singletons — none of which this
// suite touches. Stub it so importing the helpers stays side-effect free.
vi.mock('../../../session', () => ({
  listNoteFiles: vi.fn(() => Promise.resolve([])),
}));

import {
  clampExplorerWidth,
  fileBadge,
  isTreeOpen,
  MAX_EXPLORER_WIDTH,
  MIN_EXPLORER_WIDTH,
  toggleTreeAll,
} from '../helpers';

describe('fileBadge', () => {
  test('markdown extensions get the accent "md" badge', () => {
    expect(fileBadge('notes.md')).toEqual({ label: 'md', kind: 'md' });
    expect(fileBadge('notes.markdown')).toEqual({ label: 'md', kind: 'md' });
    expect(fileBadge('NOTES.MD')).toEqual({ label: 'md', kind: 'md' });
  });

  test('plain text gets a "txt" badge in the md style', () => {
    expect(fileBadge('todo.txt')).toEqual({ label: 'txt', kind: 'md' });
  });

  test('importable documents keep their extension as the label', () => {
    expect(fileBadge('report.pdf')).toEqual({ label: 'pdf', kind: 'doc' });
    expect(fileBadge('letter.docx')).toEqual({ label: 'docx', kind: 'doc' });
  });

  test('images keep their extension as the label', () => {
    expect(fileBadge('shot.png')).toEqual({ label: 'png', kind: 'image' });
    expect(fileBadge('photo.jpeg')).toEqual({ label: 'jpeg', kind: 'image' });
    expect(fileBadge('anim.gif')).toEqual({ label: 'gif', kind: 'image' });
  });

  test('unrecognized extensions get no badge (name shown in full)', () => {
    expect(fileBadge('archive.zip')).toBeNull();
    expect(fileBadge('script.sh')).toBeNull();
  });

  test('extensionless names and dotfiles get no badge', () => {
    expect(fileBadge('README')).toBeNull();
    expect(fileBadge('.gitignore')).toBeNull();
  });
});

describe('clampExplorerWidth', () => {
  test('passes through widths within the bounds', () => {
    expect(clampExplorerWidth(220)).toBe(220);
    expect(clampExplorerWidth(MIN_EXPLORER_WIDTH)).toBe(MIN_EXPLORER_WIDTH);
    expect(clampExplorerWidth(MAX_EXPLORER_WIDTH)).toBe(MAX_EXPLORER_WIDTH);
  });

  test('clamps below the minimum', () => {
    expect(clampExplorerWidth(0)).toBe(MIN_EXPLORER_WIDTH);
    expect(clampExplorerWidth(-50)).toBe(MIN_EXPLORER_WIDTH);
    expect(clampExplorerWidth(MIN_EXPLORER_WIDTH - 1)).toBe(MIN_EXPLORER_WIDTH);
  });

  test('clamps above the maximum', () => {
    expect(clampExplorerWidth(10_000)).toBe(MAX_EXPLORER_WIDTH);
    expect(clampExplorerWidth(MAX_EXPLORER_WIDTH + 1)).toBe(MAX_EXPLORER_WIDTH);
  });
});

describe('isTreeOpen / toggleTreeAll', () => {
  const WS = ['/notes', '/docs'];

  test('open while any workspace is uncollapsed or any subfolder is expanded', () => {
    expect(isTreeOpen(WS, new Set(), new Set())).toBe(true);
    expect(isTreeOpen(WS, new Set(['/notes']), new Set())).toBe(true);
    expect(isTreeOpen(WS, new Set(WS), new Set())).toBe(false);
    // All workspaces collapsed but a subfolder still remembered: still open.
    expect(isTreeOpen(WS, new Set(WS), new Set(['/notes/sub']))).toBe(true);
    // No workspaces at all — nothing to show.
    expect(isTreeOpen([], new Set(), new Set())).toBe(false);
  });

  test('collapsing shuts every workspace and forgets expanded subfolders', () => {
    const next = toggleTreeAll(WS, true);
    expect([...next.collapsedWorkspaces].sort()).toEqual(['/docs', '/notes']);
    expect(next.expandedDirs.size).toBe(0);
    expect(isTreeOpen(WS, next.collapsedWorkspaces, next.expandedDirs)).toBe(false);
  });

  test('expanding opens the roots only — subfolders stay lazy', () => {
    const next = toggleTreeAll(WS, false);
    expect(next.collapsedWorkspaces.size).toBe(0);
    expect(next.expandedDirs.size).toBe(0);
    expect(isTreeOpen(WS, next.collapsedWorkspaces, next.expandedDirs)).toBe(true);
  });
});
