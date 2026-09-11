import { describe, expect, test } from 'vitest';
import {
  isEditableTextPath,
  isMarkdownPath,
  showAllFilesState,
  showsAllFiles,
} from '../text-files';

describe('showAllFilesState', () => {
  test('off with nothing enabled', () => {
    expect(showAllFilesState('/ws', [])).toBe('off');
    expect(showsAllFiles('/ws', [])).toBe(false);
  });

  test('on for the enabled dir itself, ignoring case, separators and trailing slash', () => {
    expect(showAllFilesState('C:\\Work\\Proj', ['c:/work/proj/'])).toBe('on');
    expect(showAllFilesState('/ws/', ['/ws'])).toBe('on');
  });

  test('inherited by every subfolder of an enabled dir', () => {
    expect(showAllFilesState('/ws/src/deep', ['/ws'])).toBe('inherited');
    expect(showsAllFiles('/ws/src', ['/ws'])).toBe(true);
  });

  test('own switch wins over an enabled parent', () => {
    expect(showAllFilesState('/ws/src', ['/ws', '/ws/src'])).toBe('on');
  });

  test('a sibling sharing a name prefix is not inside', () => {
    expect(showAllFilesState('/ws-other', ['/ws'])).toBe('off');
  });

  test('synced ids compare verbatim (case-sensitive)', () => {
    expect(showAllFilesState('saf://Tok/a/b', ['saf://Tok/a'])).toBe('inherited');
    expect(showAllFilesState('saf://tok/a/b', ['saf://Tok/a'])).toBe('off');
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
