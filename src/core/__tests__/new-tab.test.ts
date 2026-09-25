import { describe, expect, test } from 'vitest';
import { defaultNewTabChoice } from '../new-tab';

describe('defaultNewTabChoice', () => {
  test('nothing open makes a note', () => {
    expect(defaultNewTabChoice(null)).toBe('note');
  });

  test('a terminal makes another terminal', () => {
    expect(defaultNewTabChoice({ kind: 'terminal', filePath: null, notePath: null })).toBe(
      'terminal',
    );
  });

  test('a drawing makes another drawing — .svg, whatever the tab kind', () => {
    expect(defaultNewTabChoice({ kind: 'file', filePath: '/notes/board.svg' })).toBe('drawing');
    expect(defaultNewTabChoice({ kind: 'file', filePath: 'C:\\me\\Board.SVG' })).toBe('drawing');
  });

  test('a deck makes a deck; the same markdown file without the flag makes a note', () => {
    expect(defaultNewTabChoice({ kind: 'file', filePath: '/notes/talk.md', deck: true })).toBe(
      'deck',
    );
    expect(defaultNewTabChoice({ kind: 'note', notePath: '/notes/talk.md', deck: true })).toBe(
      'deck',
    );
    expect(defaultNewTabChoice({ kind: 'file', filePath: '/notes/talk.md', deck: false })).toBe(
      'note',
    );
    // The flag is a markdown thing: it cannot make a drawing a deck.
    expect(defaultNewTabChoice({ kind: 'file', filePath: '/notes/board.svg', deck: true })).toBe(
      'drawing',
    );
  });

  test('every document kind makes a note', () => {
    expect(defaultNewTabChoice({ kind: 'note', notePath: '/notes/todo.md' })).toBe('note');
    expect(defaultNewTabChoice({ kind: 'file', filePath: '/notes/report.md' })).toBe('note');
    // An image viewer is not a document type you can author a new one of.
    expect(defaultNewTabChoice({ kind: 'image', filePath: '/notes/pic.png' })).toBe('note');
    expect(defaultNewTabChoice({ kind: 'import', filePath: '/notes/paper.pdf' })).toBe('note');
    // `board.svg.md` is markdown, not a drawing.
    expect(defaultNewTabChoice({ kind: 'file', filePath: '/notes/board.svg.md' })).toBe('note');
  });

  test('a git tab in front makes a note — there is no "another git tab"', () => {
    expect(defaultNewTabChoice({ kind: 'git', filePath: null, notePath: null })).toBe('note');
  });

  test('a new empty note tab (no path yet) makes a note', () => {
    expect(defaultNewTabChoice({ kind: 'note', filePath: null, notePath: null })).toBe('note');
  });

  test('without a pty the answer is never terminal', () => {
    // Android: there is no pty, so a terminal tab cannot even exist — but the
    // rule is stated where the decision is, not left to each caller.
    expect(defaultNewTabChoice({ kind: 'terminal' }, false)).toBe('note');
    expect(defaultNewTabChoice({ kind: 'file', filePath: '/a.svg' }, false)).toBe('drawing');
  });
});
