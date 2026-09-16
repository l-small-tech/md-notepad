import { describe, expect, it } from 'vitest';
import {
  cleanNotes,
  deckSummary,
  frontmatterValue,
  isMarpDocument,
  slideIndexForLine,
  speakingMinutes,
  splitSlides,
} from '../deck';

describe('isMarpDocument', () => {
  it('is true only for a closed frontmatter declaring marp: true', () => {
    expect(isMarpDocument('---\nmarp: true\n---\n# Hi')).toBe(true);
    expect(isMarpDocument('---\r\ntheme: gaia\r\nmarp:true\r\n---\r\n')).toBe(true);
    expect(isMarpDocument('---\nmarp: true\n...\n')).toBe(true);
  });

  it('is false for ordinary notes, other frontmatter, and unclosed openers', () => {
    expect(isMarpDocument('# Hi\n\nmarp: true')).toBe(false);
    expect(isMarpDocument('---\ntitle: x\n---\nmarp: true')).toBe(false);
    expect(isMarpDocument('---\nmarp: true\n# never closed')).toBe(false);
    expect(isMarpDocument('---\nmarp: false\n---\n')).toBe(false);
    expect(isMarpDocument('')).toBe(false);
  });
});

describe('frontmatterValue', () => {
  it('reads a key, stripping quotes', () => {
    const md = '---\nmarp: true\ntheme: "gaia"\nsize: 4:3\n---\n';
    expect(frontmatterValue(md, 'theme')).toBe('gaia');
    expect(frontmatterValue(md, 'size')).toBe('4:3');
    expect(frontmatterValue(md, 'paginate')).toBeNull();
    expect(frontmatterValue('# no frontmatter', 'theme')).toBeNull();
  });
});

describe('splitSlides', () => {
  const md = ['---', 'marp: true', '---', '# One', '', '---', '', '# Two', '---', '# Three'].join(
    '\n',
  );

  it('starts after the frontmatter and opens a slide on each ruler', () => {
    expect(splitSlides(md)).toEqual([
      { start: 4, end: 5 },
      { start: 6, end: 8 },
      { start: 9, end: 10 },
    ]);
  });

  it('ignores rulers inside fenced code and other ruler characters', () => {
    const fenced = ['# A', '', '```', '---', '```', '', '***', '# B', '', '___', '# C'].join('\n');
    expect(splitSlides(fenced)).toEqual([
      { start: 1, end: 6 },
      { start: 7, end: 9 },
      { start: 10, end: 11 },
    ]);
  });

  it('treats --- under a paragraph as a setext heading, not a break', () => {
    const setext = ['Title', '---', 'body', '', '---', 'next'].join('\n');
    expect(splitSlides(setext)).toEqual([
      { start: 1, end: 4 },
      { start: 5, end: 6 },
    ]);
    // A directive or note comment above a ruler is an HTML block, not a paragraph.
    expect(splitSlides('# A\n<!-- _class: lead -->\n---\n# B')).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
    // A list item above a ruler cannot be a setext paragraph.
    expect(splitSlides('- item\n---\nnext')).toEqual([
      { start: 1, end: 1 },
      { start: 2, end: 3 },
    ]);
  });

  it('is CRLF-safe and always yields at least one slide', () => {
    expect(splitSlides('# A\r\n\r\n---\r\n# B')).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
    expect(splitSlides('')).toEqual([{ start: 1, end: 1 }]);
  });
});

describe('slideIndexForLine', () => {
  const slides = splitSlides('---\nmarp: true\n---\n# One\n\n---\n# Two\n\n---\n# Three');

  it('maps a line to the slide that contains it; the ruler opens the next slide', () => {
    expect(slideIndexForLine(slides, 4)).toBe(0);
    expect(slideIndexForLine(slides, 5)).toBe(0);
    expect(slideIndexForLine(slides, 6)).toBe(1);
    expect(slideIndexForLine(slides, 9)).toBe(2);
  });

  it('clamps the frontmatter to the first slide and the overflow to the last', () => {
    expect(slideIndexForLine(slides, 1)).toBe(0);
    expect(slideIndexForLine(slides, 500)).toBe(2);
  });
});

describe('speaking estimate', () => {
  it('rounds to whole minutes with a one-minute floor', () => {
    expect(speakingMinutes(0)).toBe(0);
    expect(speakingMinutes(10)).toBe(1);
    expect(speakingMinutes(1170)).toBe(9);
  });

  it('formats the status summary', () => {
    expect(deckSummary(12, 1170)).toBe('12 slides · ~9 min');
    expect(deckSummary(1, 0)).toBe('1 slide');
  });
});

describe('cleanNotes', () => {
  it('trims and drops empty comments', () => {
    expect(cleanNotes(['  say hi  ', '', '\n'])).toEqual(['say hi']);
  });
});
