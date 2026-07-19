import { describe, expect, test } from 'vitest';
import { isEditableTextPath, isMarkdownPath } from '../text-files';

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
