import { describe, expect, test } from 'vitest';
import { extractOutline } from '../outline';

describe('extractOutline — ATX headings', () => {
  test('all six levels, with 1-based line numbers', () => {
    const md = '# a\n## b\n### c\n#### d\n##### e\n###### f';
    expect(extractOutline(md)).toEqual([
      { level: 1, text: 'a', line: 1 },
      { level: 2, text: 'b', line: 2 },
      { level: 3, text: 'c', line: 3 },
      { level: 4, text: 'd', line: 4 },
      { level: 5, text: 'e', line: 5 },
      { level: 6, text: 'f', line: 6 },
    ]);
  });

  test('seven #s is not a heading', () => {
    expect(extractOutline('####### nope')).toEqual([]);
  });

  test('a trailing closing sequence is stripped', () => {
    expect(extractOutline('## title ##')).toEqual([{ level: 2, text: 'title', line: 1 }]);
    expect(extractOutline('# only # #')).toEqual([{ level: 1, text: 'only #', line: 1 }]);
    // `# #` is an empty heading whose text was just the closing run.
    expect(extractOutline('# #')).toEqual([{ level: 1, text: '', line: 1 }]);
  });

  test('a trailing # with no space before it stays in the text', () => {
    expect(extractOutline('# C#')).toEqual([{ level: 1, text: 'C#', line: 1 }]);
  });

  test('up to 3 leading spaces allowed; 4 = indented code, not a heading', () => {
    expect(extractOutline('   # indented')).toEqual([{ level: 1, text: 'indented', line: 1 }]);
    expect(extractOutline('    # code')).toEqual([]);
  });

  test('#hashtag (no space after #s) is not a heading', () => {
    expect(extractOutline('#hashtag')).toEqual([]);
  });

  test('an inline # mid-line is not a heading', () => {
    expect(extractOutline('this line mentions # something')).toEqual([]);
  });
});

describe('extractOutline — setext headings', () => {
  test('=== under a paragraph line is an H1 on the text line', () => {
    expect(extractOutline('Title\n===')).toEqual([{ level: 1, text: 'Title', line: 1 }]);
  });

  test('--- under a paragraph line is an H2', () => {
    expect(extractOutline('Sub\n---\nbody')).toEqual([{ level: 2, text: 'Sub', line: 1 }]);
  });

  test('--- after a blank line is a thematic break, not a heading', () => {
    expect(extractOutline('para\n\n---\ntext')).toEqual([]);
  });

  test('--- after a list item or another --- is not a heading', () => {
    expect(extractOutline('- item\n---')).toEqual([]);
    expect(extractOutline('para\n\n---\n---')).toEqual([]);
  });

  test('--- after an ATX heading is not a setext heading', () => {
    expect(extractOutline('# real\n---')).toEqual([{ level: 1, text: 'real', line: 1 }]);
  });
});

describe('extractOutline — fenced code blocks', () => {
  test('headings inside ``` fences are ignored', () => {
    const md = '# real\n```\n# fake\n```\n## after';
    expect(extractOutline(md)).toEqual([
      { level: 1, text: 'real', line: 1 },
      { level: 2, text: 'after', line: 5 },
    ]);
  });

  test('~~~ fences are ignored too, and ``` inside them does not close', () => {
    const md = '~~~\n# fake\n```\n# still fake\n~~~\n# real';
    expect(extractOutline(md)).toEqual([{ level: 1, text: 'real', line: 6 }]);
  });

  test('a longer closing fence closes a shorter opener', () => {
    const md = '````\n# fake\n`````\n# real';
    expect(extractOutline(md)).toEqual([{ level: 1, text: 'real', line: 4 }]);
    // ...but a SHORTER closer does not.
    expect(extractOutline('````\n# fake\n```\n# still fake')).toEqual([]);
  });

  test('an unclosed fence swallows the rest of the document', () => {
    expect(extractOutline('# real\n```\n# fake\n# fake too')).toEqual([
      { level: 1, text: 'real', line: 1 },
    ]);
  });
});

describe('extractOutline — frontmatter, CRLF, edges', () => {
  test('YAML frontmatter is skipped; line numbers stay document-absolute', () => {
    const md = '---\ntitle: x\ndate: 2026\n---\n# Real';
    expect(extractOutline(md)).toEqual([{ level: 1, text: 'Real', line: 5 }]);
  });

  test('an unclosed leading --- is not frontmatter', () => {
    expect(extractOutline('---\ntitle: x\n# heading')).toEqual([
      { level: 1, text: 'heading', line: 3 },
    ]);
  });

  test('CRLF line endings work throughout', () => {
    const md = '---\r\na: 1\r\n---\r\n# One\r\nTwo\r\n---\r\n```\r\n# fake\r\n```\r\n';
    expect(extractOutline(md)).toEqual([
      { level: 1, text: 'One', line: 4 },
      { level: 2, text: 'Two', line: 5 },
    ]);
  });

  test('empty and heading-free documents yield an empty outline', () => {
    expect(extractOutline('')).toEqual([]);
    expect(extractOutline('just a paragraph\nand another')).toEqual([]);
  });
});
