import { describe, expect, test } from 'vitest';
import {
  isEditableTextPath,
  isMarkdownPath,
  showAllFilesState,
  showsAllFiles,
  toggleShowAllFiles,
} from '../text-files';

describe('showAllFilesState', () => {
  test('off with nothing switched', () => {
    expect(showAllFilesState('/ws', [])).toEqual({ show: false, explicit: false });
    expect(showsAllFiles('/ws', [])).toBe(false);
  });

  test('on for the switched dir itself, ignoring case, separators and trailing slash', () => {
    expect(showAllFilesState('C:\\Work\\Proj', ['c:/work/proj/'])).toEqual({
      show: true,
      explicit: true,
    });
    expect(showsAllFiles('/ws/', ['/ws'])).toBe(true);
  });

  test('inherited by every subfolder', () => {
    expect(showAllFilesState('/ws/src/deep', ['/ws'])).toEqual({ show: true, explicit: false });
  });

  test('the nearest switch wins: a subfolder can hide, a deeper one show again', () => {
    const shown = ['/ws', '/ws/src/keep'];
    const hidden = ['/ws/src'];
    expect(showsAllFiles('/ws/docs', shown, hidden)).toBe(true);
    expect(showAllFilesState('/ws/src', shown, hidden)).toEqual({ show: false, explicit: true });
    expect(showsAllFiles('/ws/src/lib', shown, hidden)).toBe(false);
    expect(showsAllFiles('/ws/src/keep/x', shown, hidden)).toBe(true);
  });

  test('a sibling sharing a name prefix is not inside', () => {
    expect(showsAllFiles('/ws-other', ['/ws'])).toBe(false);
  });

  test('synced ids compare verbatim (case-sensitive)', () => {
    expect(showsAllFiles('saf://Tok/a/b', ['saf://Tok/a'])).toBe(true);
    expect(showsAllFiles('saf://tok/a/b', ['saf://Tok/a'])).toBe(false);
  });
});

describe('toggleShowAllFiles', () => {
  test('turning a workspace on shows everything under it', () => {
    expect(toggleShowAllFiles('/ws', [], [])).toEqual({ shown: ['/ws'], hidden: [] });
  });

  test('a subfolder of a showing workspace can be hidden, and shown again', () => {
    const off = toggleShowAllFiles('/ws/src', ['/ws'], []);
    expect(off).toEqual({ shown: ['/ws'], hidden: ['/ws/src'] });
    expect(toggleShowAllFiles('/ws/src', off.shown, off.hidden)).toEqual({
      shown: ['/ws'],
      hidden: [],
    });
  });

  test('setting the workspace again resets its folders to follow it', () => {
    const shown = ['/ws', '/ws/a/b'];
    const hidden = ['/ws/a', '/ws/c'];
    const off = toggleShowAllFiles('/ws', shown, hidden);
    expect(off).toEqual({ shown: [], hidden: [] });
    expect(showsAllFiles('/ws/c', off.shown, off.hidden)).toBe(false);
    const on = toggleShowAllFiles('/ws', off.shown, off.hidden);
    expect(showsAllFiles('/ws/c', on.shown, on.hidden)).toBe(true);
    expect(showsAllFiles('/ws/a/b', on.shown, on.hidden)).toBe(true);
  });

  test('leaves switches outside the folder alone', () => {
    expect(toggleShowAllFiles('/ws/src', ['/other'], ['/ws-x'])).toEqual({
      shown: ['/other', '/ws/src'],
      hidden: ['/ws-x'],
    });
  });
});

describe('isMarkdownPath', () => {
  test('matches .md and .markdown, any case', () => {
    expect(isMarkdownPath('note.md')).toBe(true);
    expect(isMarkdownPath('NOTE.MD')).toBe(true);
    expect(isMarkdownPath('readme.markdown')).toBe(true);
  });

  test('rejects .txt and other extensions', () => {
    expect(isMarkdownPath('note.txt')).toBe(false);
    expect(isMarkdownPath('photo.png')).toBe(false);
    expect(isMarkdownPath('report.pdf')).toBe(false);
  });
});

describe('isEditableTextPath', () => {
  test('matches markdown and plain text, any case', () => {
    expect(isEditableTextPath('note.md')).toBe(true);
    expect(isEditableTextPath('readme.markdown')).toBe(true);
    expect(isEditableTextPath('todo.txt')).toBe(true);
    expect(isEditableTextPath('TODO.TXT')).toBe(true);
  });

  test('rejects images, documents, and extension-less names', () => {
    expect(isEditableTextPath('photo.png')).toBe(false);
    expect(isEditableTextPath('report.pdf')).toBe(false);
    expect(isEditableTextPath('Makefile')).toBe(false);
  });
});
