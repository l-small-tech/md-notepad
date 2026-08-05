import { describe, expect, it } from 'vitest';
import { allowedModesFor, defaultModeFor, docFamilyFor, isModeAllowed } from '../doc-family';

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
