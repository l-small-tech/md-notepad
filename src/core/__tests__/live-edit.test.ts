import { describe, expect, it } from 'vitest';

import { extraLiveWatchDirs, formatClockTime, isLiveEditTab } from '../live-edit';

const shared = { path: 'C:/Users/me/OneDrive/Team', liveEdit: true };
const plain = { path: 'C:/Users/me/Notes' };
const workspaces = [shared, plain];

function fileTab(filePath: string | null, liveEdit: boolean | null, kind = 'file') {
  return { kind, filePath, liveEdit };
}

describe('isLiveEditTab', () => {
  it('follows the workspace flag when the tab has no override', () => {
    expect(isLiveEditTab(fileTab('C:\\Users\\me\\OneDrive\\Team\\plan.md', null), workspaces)).toBe(
      true,
    );
    expect(isLiveEditTab(fileTab('C:/Users/me/Notes/a.md', null), workspaces)).toBe(false);
    expect(isLiveEditTab(fileTab('D:/elsewhere/a.md', null), workspaces)).toBe(false);
  });

  it('lets the per-tab override win in both directions', () => {
    expect(isLiveEditTab(fileTab('C:/Users/me/OneDrive/Team/plan.md', false), workspaces)).toBe(
      false,
    );
    expect(isLiveEditTab(fileTab('D:/elsewhere/a.md', true), workspaces)).toBe(true);
  });

  it('never applies to non-file tabs or unsaved files', () => {
    expect(isLiveEditTab(fileTab(null, true, 'note'), workspaces)).toBe(false);
    expect(isLiveEditTab(fileTab(null, true), workspaces)).toBe(false);
    expect(
      isLiveEditTab(fileTab('C:/Users/me/OneDrive/Team/x.png', null, 'image'), workspaces),
    ).toBe(false);
  });

  it('prefers the nested workspace', () => {
    const nested = [
      { path: 'C:/root', liveEdit: true },
      { path: 'C:/root/private', liveEdit: false },
    ];
    expect(isLiveEditTab(fileTab('C:/root/private/x.md', null), nested)).toBe(false);
    expect(isLiveEditTab(fileTab('C:/root/x.md', null), nested)).toBe(true);
  });
});

describe('extraLiveWatchDirs', () => {
  const roots = [shared.path, plain.path];

  it('adds the parent of an overridden file outside every root, once', () => {
    const tabs = [
      fileTab('D:\\Shared\\a.md', true),
      fileTab('d:/shared/b.md', true),
      fileTab('D:/Shared/c.md', null),
      fileTab('C:/Users/me/OneDrive/Team/in-root.md', null),
    ];
    expect(extraLiveWatchDirs(tabs, workspaces, roots)).toEqual(['D:\\Shared']);
  });

  it('is empty when nothing is live outside the roots', () => {
    expect(extraLiveWatchDirs([fileTab('D:/x/a.md', null)], workspaces, roots)).toEqual([]);
  });
});

describe('formatClockTime', () => {
  it('renders a zero-padded local time', () => {
    expect(formatClockTime(new Date(2026, 0, 1, 9, 5, 7).getTime())).toBe('09:05:07');
  });
});
