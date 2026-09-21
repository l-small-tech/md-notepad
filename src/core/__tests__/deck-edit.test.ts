import { describe, expect, test } from 'vitest';

import { splitSlides } from '../deck';
import {
  appendBlock,
  appendedBlockRange,
  blockRange,
  deleteSlide,
  duplicateSlide,
  getImageWidth,
  getLines,
  getSlideBackground,
  getSlideDirective,
  getSlideNotes,
  insertSlide,
  moveSlide,
  replaceLines,
  setFrontmatterValue,
  setImageWidth,
  setSlideBackground,
  setSlideDirective,
  setSlideNotes,
  slideCount,
} from '../deck-edit';

const md = (...lines: string[]): string => lines.join('\n');

const DECK = md(
  '---',
  'marp: true',
  'theme: gaia',
  '---',
  '',
  '<!-- _class: lead -->',
  '',
  '# One',
  '',
  '<!-- say hello -->',
  '',
  '---',
  '',
  '# Two',
  '',
  '- a',
  '- b',
  '',
  '***',
  '',
  '# Three',
);

describe('blocks', () => {
  test('blockRange gives back the blank line a list map swallows, and clamps', () => {
    expect(blockRange(DECK, 16, 18)).toEqual({ start: 16, end: 17 });
    expect(blockRange(DECK, 21, 99)).toEqual({ start: 21, end: 21 });
  });

  test('getLines / replaceLines touch only their lines', () => {
    expect(getLines(DECK, 16, 17)).toBe('- a\n- b');
    const next = replaceLines(DECK, 16, 17, '- a\n- b\n- c');
    expect(next).toBe(DECK.replace('- a\n- b', '- a\n- b\n- c'));
  });

  test('replacing a block with nothing removes its separating blank line too', () => {
    const next = replaceLines(DECK, 16, 17, '');
    expect(next).toContain('# Two\n\n***');
  });

  test('CRLF documents stay CRLF', () => {
    const crlf = DECK.replace(/\n/g, '\r\n');
    const next = replaceLines(crlf, 8, 8, '# Uno\nmore');
    expect(next).toBe(crlf.replace('# One', '# Uno\r\nmore'));
  });
});

describe('slide management', () => {
  test('moveSlide carries the body, leaves the rulers and frontmatter where they are', () => {
    const next = moveSlide(DECK, 2, 0);
    expect(next.startsWith('---\nmarp: true\ntheme: gaia\n---\n\n# Three')).toBe(true);
    expect(slideCount(next)).toBe(3);
    // The rulers kept their positions: `---` still opens slide 2, `***` slide 3.
    const lines = next.split('\n');
    const ranges = splitSlides(next);
    expect(lines[ranges[1]!.start - 1]).toBe('---');
    expect(lines[ranges[2]!.start - 1]).toBe('***');
    expect(getSlideNotes(next, 1)).toBe('say hello');
  });

  test('a body that ended the file gets a blank line, so its last line is not a setext heading', () => {
    const next = moveSlide(md('---', 'marp: true', '---', '# A', '', '---', 'last words'), 1, 0);
    expect(next).toBe(md('---', 'marp: true', '---', 'last words', '', '---', '# A', ''));
    expect(slideCount(next)).toBe(2);
  });

  test('moving there and back is the identity; out-of-range is a no-op', () => {
    expect(moveSlide(moveSlide(DECK, 0, 1), 1, 0)).toBe(DECK);
    expect(moveSlide(DECK, 0, 7)).toBe(DECK);
  });

  test('duplicateSlide / insertSlide / deleteSlide', () => {
    const dup = duplicateSlide(DECK, 1);
    expect(slideCount(dup)).toBe(4);
    expect(getLines(dup, splitSlides(dup)[2]!.start, splitSlides(dup)[2]!.end)).toContain('# Two');
    const added = insertSlide(DECK, 2);
    expect(slideCount(added)).toBe(4);
    expect(added.endsWith('# Three\n\n---\n\n# New slide\n')).toBe(true);
    expect(deleteSlide(dup, 2)).toBe(DECK);
    const first = deleteSlide(DECK, 0);
    expect(slideCount(first)).toBe(2);
    expect(first.startsWith('---\nmarp: true\ntheme: gaia\n---\n\n# Two')).toBe(true);
  });

  test('the only slide is emptied, never removed', () => {
    const next = deleteSlide('---\nmarp: true\n---\n# Only', 0);
    expect(next).toBe('---\nmarp: true\n---\n');
    expect(slideCount(next)).toBe(1);
  });
});

describe('spot directives', () => {
  test('reads the slide’s own value only', () => {
    expect(getSlideDirective(DECK, 0, 'class')).toBe('lead');
    expect(getSlideDirective(DECK, 1, 'class')).toBeNull();
  });

  test('rewrites an existing line in place', () => {
    expect(setSlideDirective(DECK, 0, 'class', 'lead invert')).toBe(
      DECK.replace('_class: lead', '_class: lead invert'),
    );
  });

  test('a new directive goes under the leading directive comments', () => {
    const next = setSlideDirective(DECK, 0, 'backgroundColor', '#123456');
    expect(next).toContain('<!-- _class: lead -->\n\n<!-- _backgroundColor: #123456 -->\n\n# One');
    expect(getSlideDirective(next, 0, 'backgroundColor')).toBe('#123456');
    const two = setSlideDirective(DECK, 1, 'paginate', 'false');
    expect(two).toContain('---\n\n<!-- _paginate: false -->\n\n# Two');
  });

  test('clearing removes the comment and its blank line', () => {
    const next = setSlideDirective(DECK, 0, 'class', null);
    expect(next).toContain('---\n\n# One');
    expect(setSlideDirective(next, 0, 'class', 'lead')).toBe(DECK);
  });

  test('a multi-key comment keeps its other keys', () => {
    const source = md(
      '---',
      'marp: true',
      '---',
      '<!--',
      '_class: lead',
      '_color: red',
      '-->',
      '',
      '# T',
    );
    const next = setSlideDirective(source, 0, 'class', null);
    expect(next).toBe(md('---', 'marp: true', '---', '<!--', '_color: red', '-->', '', '# T'));
    expect(setSlideDirective(next, 0, 'color', '')).toBe(md('---', 'marp: true', '---', '', '# T'));
  });

  test('values YAML would misread are quoted, and read back unquoted', () => {
    const next = setSlideDirective(DECK, 1, 'footer', 'Q3: the "plan"');
    expect(next).toContain('<!-- _footer: "Q3: the \\"plan\\"" -->');
    expect(getSlideDirective(next, 1, 'footer')).toBe('Q3: the "plan"');
  });

  test('a directive inside a code fence is not a directive', () => {
    const source = md('---', 'marp: true', '---', '```html', '<!-- _class: lead -->', '```');
    expect(getSlideDirective(source, 0, 'class')).toBeNull();
  });
});

describe('speaker notes', () => {
  test('reads non-directive comments', () => {
    expect(getSlideNotes(DECK, 0)).toBe('say hello');
    expect(getSlideNotes(DECK, 1)).toBe('');
  });

  test('replaces in place, appends when new, removes when emptied', () => {
    expect(setSlideNotes(DECK, 0, 'say hi')).toBe(DECK.replace('say hello', 'say hi'));
    const added = setSlideNotes(DECK, 1, 'line one\nline two');
    expect(added).toContain('- b\n\n<!--\nline one\nline two\n-->\n\n***');
    expect(getSlideNotes(added, 1)).toBe('line one\nline two');
    expect(setSlideNotes(added, 1, '')).toBe(DECK);
    const last = setSlideNotes(DECK, 2, 'end');
    expect(last.endsWith('# Three\n\n<!-- end -->')).toBe(true);
  });

  test('unchanged notes are a no-op, and a comment closer cannot escape', () => {
    expect(setSlideNotes(DECK, 0, 'say hello ')).toBe(DECK);
    expect(setSlideNotes(DECK, 0, 'a --> b')).toContain('<!-- a -- > b -->');
  });
});

describe('appendBlock', () => {
  test('lands above the slide’s trailing notes, and reports where', () => {
    const next = appendBlock(DECK, 0, 'New text');
    expect(next).toContain('# One\n\nNew text\n\n<!-- say hello -->');
    expect(appendedBlockRange(DECK, next)).toEqual({ start: 10, end: 10 });
    const end = appendBlock(DECK, 2, 'Tail');
    expect(end.endsWith('# Three\n\nTail')).toBe(true);
  });
});

describe('background image', () => {
  test('parses side, size, fit and keeps unknown keywords', () => {
    const source = md(
      '---',
      'marp: true',
      '---',
      '![bg right:40% contain blur](<my pic.png>)',
      '# T',
    );
    expect(getSlideBackground(source, 0)).toEqual({
      src: 'my pic.png',
      side: 'right',
      sideSize: '40%',
      fit: 'contain',
      extra: ['blur'],
    });
    const next = setSlideBackground(source, 0, {
      src: 'my pic.png',
      side: 'left',
      sideSize: null,
      fit: null,
      extra: ['blur'],
    });
    expect(next).toContain('![bg left blur](<my pic.png>)');
  });

  test('inserts under the directives, removes cleanly, ignores ordinary images', () => {
    expect(getSlideBackground(md('---', 'marp: true', '---', '![w:200](a.png)'), 0)).toBeNull();
    const bg = { src: './hero.png', side: 'full' as const, sideSize: null, fit: null, extra: [] };
    const next = setSlideBackground(DECK, 0, bg);
    expect(next).toContain('<!-- _class: lead -->\n\n![bg](./hero.png)\n\n# One');
    expect(setSlideBackground(next, 0, null)).toBe(DECK);
  });
});

describe('inline image width', () => {
  test('reads, sets, replaces and clears the width keyword of the nth image', () => {
    const block = 'See ![logo](a.png) and ![w:100px alt](b.png)';
    expect(getImageWidth(block, 0)).toBeNull();
    expect(getImageWidth(block, 1)).toBe('100px');
    expect(setImageWidth(block, 0, '300')).toBe(
      'See ![logo w:300px](a.png) and ![w:100px alt](b.png)',
    );
    expect(setImageWidth(block, 1, '50%')).toBe('See ![logo](a.png) and ![alt w:50%](b.png)');
    expect(setImageWidth(block, 1, null)).toBe('See ![logo](a.png) and ![alt](b.png)');
    expect(setImageWidth(block, 5, '1')).toBe(block);
  });
});

describe('frontmatter', () => {
  test('replaces, adds before the closer, removes', () => {
    expect(setFrontmatterValue(DECK, 'theme', 'uncover')).toBe(DECK.replace('gaia', 'uncover'));
    expect(setFrontmatterValue(DECK, 'size', '4:3')).toContain('theme: gaia\nsize: 4:3\n---');
    expect(setFrontmatterValue(DECK, 'theme', null)).toContain('marp: true\n---');
    expect(setFrontmatterValue('# no frontmatter', 'theme', 'gaia')).toBe('# no frontmatter');
  });
});
