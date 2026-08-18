import { describe, expect, it } from 'vitest';
import {
  allowedModesFor,
  defaultModeFor,
  docFamilyFor,
  docFamilyForTab,
  isModeAllowed,
} from '../doc-family';

describe('docFamilyFor', () => {
  it('recognizes .svg regardless of case or directory', () => {
    expect(docFamilyFor('/notes/board.svg')).toBe('svg');
    expect(docFamilyFor('C:\\Users\\me\\Board.SVG')).toBe('svg');
  });

  it('treats everything else — including no path at all — as markdown', () => {
    expect(docFamilyFor('/notes/todo.md')).toBe('markdown');
    expect(docFamilyFor('/notes/svg')).toBe('markdown');
    expect(docFamilyFor('/notes/board.svg.md')).toBe('markdown');
    expect(docFamilyFor(null)).toBe('markdown');
    expect(docFamilyFor(undefined)).toBe('markdown');
  });
});

describe('allowedModesFor', () => {
  it('offers Draw and Raw for a whiteboard, and never Rich/Split/Read', () => {
    expect(allowedModesFor('svg')).toEqual(['draw', 'raw']);
  });

  it('leaves the markdown modes exactly as they were, with no Draw', () => {
    expect(allowedModesFor('markdown')).toEqual(['raw', 'split', 'wysiwyg', 'read']);
  });

  it('agrees with isModeAllowed', () => {
    expect(isModeAllowed('svg', 'draw')).toBe(true);
    expect(isModeAllowed('svg', 'wysiwyg')).toBe(false);
    expect(isModeAllowed('markdown', 'draw')).toBe(false);
    expect(isModeAllowed('markdown', 'read')).toBe(true);
  });
});

describe('defaultModeFor', () => {
  it('keeps a preference the family supports', () => {
    expect(defaultModeFor('svg', 'raw')).toBe('raw');
    expect(defaultModeFor('markdown', 'read')).toBe('read');
  });

  it('self-heals a mode from the other family', () => {
    // The manifest never validates `mode`, so both directions must degrade.
    expect(defaultModeFor('svg', 'read')).toBe('draw');
    expect(defaultModeFor('svg', 'wysiwyg')).toBe('draw');
    expect(defaultModeFor('markdown', 'draw')).toBe('raw');
  });
});

describe('the terminal family', () => {
  it('is keyed on the TAB, since a terminal has no path to key on', () => {
    expect(docFamilyForTab({ kind: 'terminal', filePath: null, notePath: null })).toBe('terminal');
    expect(docFamilyForTab({ kind: 'file', filePath: '/notes/board.svg' })).toBe('svg');
    expect(docFamilyForTab({ kind: 'note', notePath: '/notes/todo.md' })).toBe('markdown');
  });

  it('offers exactly one mode, so the picker and mod+1..4 filter it out', () => {
    expect(allowedModesFor('terminal')).toEqual(['term']);
    expect(isModeAllowed('terminal', 'term')).toBe(true);
    expect(isModeAllowed('terminal', 'raw')).toBe(false);
    expect(isModeAllowed('markdown', 'term')).toBe(false);
    expect(isModeAllowed('svg', 'term')).toBe(false);
  });

  it('self-heals a stale mode from a manifest', () => {
    expect(defaultModeFor('terminal', 'raw')).toBe('term');
    expect(defaultModeFor('markdown', 'term')).toBe('raw');
    expect(defaultModeFor('svg', 'term')).toBe('draw');
  });
});
