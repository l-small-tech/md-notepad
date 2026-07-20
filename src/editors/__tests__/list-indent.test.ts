import { describe, it, expect } from 'vitest';
import { parseListLine, reindentLists } from '../list-indent';

/** Re-indent `text` (a whole document) at the given 0-based line range. */
function reindent(text: string, start: number, end: number, delta: 1 | -1): string | null {
  const out = reindentLists(text.split('\n'), start, end, delta);
  return out === null ? null : out.join('\n');
}

describe('parseListLine', () => {
  it('parses bullet markers', () => {
    expect(parseListLine('- item')).toMatchObject({
      indent: '',
      marker: '-',
      content: 'item',
      ordered: false,
    });
    expect(parseListLine('  * item')).toMatchObject({ indent: '  ', marker: '*', ordered: false });
    expect(parseListLine('+ item')).toMatchObject({ marker: '+', ordered: false });
  });

  it('parses ordered markers with either delimiter', () => {
    expect(parseListLine('1. item')).toMatchObject({ marker: '1.', ordered: true });
    expect(parseListLine('  12) item')).toMatchObject({ marker: '12)', ordered: true });
  });

  it('accepts an empty item and normalizes the gap', () => {
    expect(parseListLine('-')).toMatchObject({ marker: '-', space: ' ', content: '' });
  });

  it('rejects non-lists', () => {
    expect(parseListLine('plain text')).toBeNull();
    expect(parseListLine('-foo')).toBeNull();
    expect(parseListLine('*emphasis*')).toBeNull();
    expect(parseListLine('**bold**')).toBeNull();
    expect(parseListLine('1.no gap')).toBeNull();
    expect(parseListLine('')).toBeNull();
  });
});

describe('reindentLists — not handled', () => {
  it('returns null when any selected line is not a list item', () => {
    expect(reindent('- a\nplain\n- b', 0, 2, 1)).toBeNull();
    expect(reindent('plain', 0, 0, 1)).toBeNull();
  });

  it('returns null for an out-of-range selection', () => {
    expect(reindentLists(['- a'], 0, 5, 1)).toBeNull();
    expect(reindentLists(['- a'], 1, 0, 1)).toBeNull();
  });
});

describe('reindentLists — bullet depth cycle', () => {
  it('indents under the preceding sibling and swaps * to -', () => {
    expect(reindent('* top\n* second', 1, 1, 1)).toBe('* top\n  - second');
  });

  it('cycles to + at the third level', () => {
    const doc = '* a\n  - b\n  - c';
    expect(reindent(doc, 2, 2, 1)).toBe('* a\n  - b\n    + c');
  });

  it('wraps the cycle back to * at the fourth level', () => {
    const doc = '* a\n  - b\n    + c\n    + d';
    expect(reindent(doc, 3, 3, 1)).toBe('* a\n  - b\n    + c\n      * d');
  });

  it('dedents a nested - back to * at column 0', () => {
    expect(reindent('* top\n  - nested', 1, 1, -1)).toBe('* top\n* nested');
  });

  it('leaves a column-0 item alone on dedent', () => {
    expect(reindent('* a\n* b', 1, 1, -1)).toBe('* a\n* b');
  });

  it('refuses to skip a level: the first item of a block cannot indent', () => {
    expect(reindent('- only', 0, 0, 1)).toBe('* only');
    expect(reindent('* a\n  - b', 1, 1, 1)).toBe('* a\n  - b');
  });

  it('normalizes a stray marker to the one its depth calls for', () => {
    expect(reindent('+ a\n+ b', 1, 1, -1)).toBe('* a\n* b');
  });
});

describe('reindentLists — descendants follow', () => {
  it('carries children along when their parent indents', () => {
    const doc = '* a\n* b\n  - b1\n    + b2';
    expect(reindent(doc, 1, 1, 1)).toBe('* a\n  - b\n    + b1\n      * b2');
  });

  it('carries children along when their parent dedents', () => {
    const doc = '* a\n  - b\n    + b1';
    expect(reindent(doc, 1, 1, -1)).toBe('* a\n* b\n  - b1');
  });

  it('stops at the first sibling of the moved item', () => {
    const doc = '* a\n* b\n  - b1\n* c';
    expect(reindent(doc, 1, 1, 1)).toBe('* a\n  - b\n    + b1\n* c');
  });
});

describe('reindentLists — multi-line selection', () => {
  it('indents every selected sibling', () => {
    const doc = '* a\n* b\n* c';
    expect(reindent(doc, 1, 2, 1)).toBe('* a\n  - b\n  - c');
  });

  it('dedents every selected line', () => {
    const doc = '* a\n  - b\n  - c';
    expect(reindent(doc, 1, 2, -1)).toBe('* a\n* b\n* c');
  });
});

describe('reindentLists — ordered lists', () => {
  it('indents and restarts numbering at 1', () => {
    expect(reindent('1. first\n2. second', 1, 1, 1)).toBe('1. first\n   1. second');
  });

  it('numbers nested siblings in sequence', () => {
    const doc = '1. first\n   1. a\n2. second';
    expect(reindent(doc, 2, 2, 1)).toBe('1. first\n   1. a\n   2. second');
  });

  it('renumbers the parent run after an item is nested away', () => {
    const doc = '1. a\n2. b\n3. c';
    expect(reindent(doc, 1, 1, 1)).toBe('1. a\n   1. b\n2. c');
  });

  it('renumbers into the parent sequence on dedent', () => {
    const doc = '1. a\n   1. b\n   2. c';
    expect(reindent(doc, 1, 2, -1)).toBe('1. a\n2. b\n3. c');
  });

  it('repairs sloppy numbering in the touched block', () => {
    const doc = '1. a\n1. b\n1. c';
    expect(reindent(doc, 2, 2, 1)).toBe('1. a\n2. b\n   1. c');
  });

  it('preserves the ) delimiter', () => {
    expect(reindent('1) a\n2) b', 1, 1, 1)).toBe('1) a\n   1) b');
  });

  it('indents under a bullet parent without renumbering it', () => {
    expect(reindent('* a\n1. b', 1, 1, 1)).toBe('* a\n  1. b');
  });
});

describe('reindentLists — block scoping', () => {
  it('leaves lists outside the block untouched', () => {
    const doc = '1. x\n1. y\n\nprose\n\n1. a\n2. b';
    expect(reindent(doc, 6, 6, 1)).toBe('1. x\n1. y\n\nprose\n\n1. a\n   1. b');
  });

  it('spans a single blank line inside a loose list', () => {
    const doc = '1. a\n\n2. b\n\n3. c';
    expect(reindent(doc, 4, 4, 1)).toBe('1. a\n\n2. b\n\n   1. c');
  });

  it('treats a tab-indented item as nested', () => {
    expect(reindent('* a\n\t- b', 1, 1, -1)).toBe('* a\n* b');
  });
});
