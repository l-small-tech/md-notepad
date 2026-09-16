import { describe, expect, it } from 'vitest';
import { checkPaste, duplicateName } from '../explorer-clipboard';

describe('duplicateName', () => {
  it('returns the name unchanged when nothing collides', () => {
    expect(duplicateName('notes.md', false, 0)).toBe('notes.md');
  });

  it('appends "copy" then numbers it, keeping the extension', () => {
    expect(duplicateName('notes.md', false, 1)).toBe('notes copy.md');
    expect(duplicateName('notes.md', false, 2)).toBe('notes copy 2.md');
    expect(duplicateName('notes.md', false, 3)).toBe('notes copy 3.md');
  });

  it('keeps a multi-dot extension to the LAST dot', () => {
    expect(duplicateName('notes.comments.md', false, 1)).toBe('notes.comments copy.md');
  });

  it('treats a dotfile as all base — the leading dot is not an extension', () => {
    expect(duplicateName('.gitignore', false, 1)).toBe('.gitignore copy');
  });

  it('treats a folder name as all base, dots and all', () => {
    expect(duplicateName('v1.2', true, 1)).toBe('v1.2 copy');
    expect(duplicateName('drafts', true, 2)).toBe('drafts copy 2');
  });
});

describe('checkPaste', () => {
  const file = { path: 'C:/notes/a.md', isDir: false, mode: 'copy' } as const;

  it('allows a plain paste into another folder', () => {
    expect(checkPaste(file, 'C:/notes/sub')).toBe('ok');
  });

  it('allows COPYing back into the source folder — that is a duplicate', () => {
    expect(checkPaste(file, 'C:/notes')).toBe('ok');
  });

  it('calls a CUT back into the source folder a no-op', () => {
    expect(checkPaste({ ...file, mode: 'cut' }, 'C:/notes')).toBe('noop');
    // Separator and case differences must not hide the no-op.
    expect(checkPaste({ ...file, mode: 'cut' }, 'C:\\Notes')).toBe('noop');
  });

  it('refuses a folder pasted into itself or a descendant', () => {
    const dir = { path: 'C:/notes/drafts', isDir: true, mode: 'copy' } as const;
    expect(checkPaste(dir, 'C:/notes/drafts')).toBe('into-self');
    expect(checkPaste(dir, 'C:/notes/drafts/deep/deeper')).toBe('into-self');
    expect(checkPaste(dir, 'C:/notes')).toBe('ok');
    // A sibling whose name merely starts with the source's is not inside it.
    expect(checkPaste(dir, 'C:/notes/drafts-old')).toBe('ok');
  });

  it('lets a cut folder move to a sibling but not into itself', () => {
    const dir = { path: 'C:/notes/drafts', isDir: true, mode: 'cut' } as const;
    expect(checkPaste(dir, 'C:/notes')).toBe('noop');
    expect(checkPaste(dir, 'C:/notes/drafts/sub')).toBe('into-self');
    expect(checkPaste(dir, 'C:/other')).toBe('ok');
  });
});
