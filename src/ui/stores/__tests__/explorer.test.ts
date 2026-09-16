import { beforeEach, describe, expect, it } from 'vitest';
import { explorerStore } from '../explorer';

const s = () => explorerStore.getState();

beforeEach(() => {
  explorerStore.setState({ selected: null, clipboard: null });
});

describe('explorer selection', () => {
  it('remembers the clicked row and clears on null', () => {
    s().select({ path: 'C:/notes/a.md', isDir: false });
    expect(s().selected).toEqual({ path: 'C:/notes/a.md', isDir: false });
    s().select(null);
    expect(s().selected).toBeNull();
  });

  it('keeps the same object when nothing changed (no needless re-render)', () => {
    s().select({ path: 'C:/notes/a.md', isDir: false });
    const first = s().selected;
    s().select({ path: 'C:/notes/a.md', isDir: false });
    expect(s().selected).toBe(first);
  });
});

describe('explorer clipboard', () => {
  it('holds one entry with its mode, replacing whatever was there', () => {
    s().put({ path: 'C:/notes/a.md', name: 'a.md', isDir: false }, 'copy');
    expect(s().clipboard).toEqual({
      path: 'C:/notes/a.md',
      name: 'a.md',
      isDir: false,
      mode: 'copy',
    });
    s().put({ path: 'C:/notes/sub', name: 'sub', isDir: true }, 'cut');
    expect(s().clipboard?.mode).toBe('cut');
    expect(s().clipboard?.path).toBe('C:/notes/sub');
  });

  it('clears', () => {
    s().put({ path: 'C:/notes/a.md', name: 'a.md', isDir: false }, 'cut');
    s().clearClipboard();
    expect(s().clipboard).toBeNull();
  });
});

describe('dropUnder', () => {
  it('forgets a selection and clipboard entry inside the removed root', () => {
    s().select({ path: 'C:/notes/sub/a.md', isDir: false });
    s().put({ path: 'C:/notes/sub/b.md', name: 'b.md', isDir: false }, 'cut');
    s().dropUnder('C:\\Notes\\Sub');
    expect(s().selected).toBeNull();
    expect(s().clipboard).toBeNull();
  });

  it('forgets the root row itself', () => {
    s().select({ path: 'C:/notes/sub', isDir: true });
    s().dropUnder('C:/notes/sub');
    expect(s().selected).toBeNull();
  });

  it('leaves a sibling whose name merely shares the prefix', () => {
    s().select({ path: 'C:/notes/sub-old/a.md', isDir: false });
    s().put({ path: 'C:/other/b.md', name: 'b.md', isDir: false }, 'copy');
    s().dropUnder('C:/notes/sub');
    expect(s().selected).not.toBeNull();
    expect(s().clipboard).not.toBeNull();
  });
});
