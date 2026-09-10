import { describe, expect, test } from 'vitest';
import {
  commentsPathFor,
  isCommentsPath,
  lineQuote,
  newCommentId,
  parseCommentsFile,
  serializeCommentsFile,
  type VoiceComment,
} from '../comments';

describe('commentsPathFor', () => {
  test('replaces .md with .comments.md in the same directory', () => {
    expect(commentsPathFor('/home/me/notes/foo.md')).toBe('/home/me/notes/foo.comments.md');
  });

  test('collapses .markdown to .comments.md', () => {
    expect(commentsPathFor('/n/report.markdown')).toBe('/n/report.comments.md');
  });

  test('works over saf:// identifiers (suffix replace, no path parsing)', () => {
    expect(commentsPathFor('saf://TOKEN%2Fabc/sub/foo.md')).toBe(
      'saf://TOKEN%2Fabc/sub/foo.comments.md',
    );
  });

  test('handles Windows separators', () => {
    expect(commentsPathFor('C:\\notes\\foo.md')).toBe('C:\\notes/foo.comments.md');
  });
});

describe('isCommentsPath', () => {
  test('matches only *.comments.md', () => {
    expect(isCommentsPath('/n/foo.comments.md')).toBe(true);
    expect(isCommentsPath('/n/foo.md')).toBe(false);
    expect(isCommentsPath('/n/comments.md')).toBe(false);
    expect(isCommentsPath('/n/foo.COMMENTS.MD')).toBe(true);
  });
});

describe('lineQuote', () => {
  test('returns the trimmed 1-based line, tolerating CRLF', () => {
    expect(lineQuote('a\n  ## Setup  \r\nc', 2)).toBe('## Setup');
  });

  test('is empty out of range', () => {
    expect(lineQuote('a\nb', 0)).toBe('');
    expect(lineQuote('a\nb', 3)).toBe('');
  });
});

describe('newCommentId', () => {
  test('never returns an id already in use', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = newCommentId(taken);
      expect(taken.has(id)).toBe(false);
      expect(id).toMatch(/^c[0-9a-z]+$/);
      taken.add(id);
    }
  });
});

const NOTE = 'meeting-notes.md';

describe('serialize (v2 format)', () => {
  test('writes the version header, a title linking the parent, and every field', () => {
    const text = serializeCommentsFile(
      [
        {
          id: 'c3f9a',
          file: NOTE,
          line: 42,
          quote: 'Pricing goes live Friday',
          time: '2026-09-10T21:32:07.000Z',
          transcript: 'Ship the pricing change before the demo.',
        },
      ],
      NOTE,
    );
    expect(text).toBe(
      [
        '<!-- md-notepad voice comments v2 -->',
        '# Voice notes for [meeting-notes.md](./meeting-notes.md)',
        '',
        '## ^c3f9a',
        '- file: meeting-notes.md',
        '- line: 42',
        '- time: 2026-09-10T21:32:07.000Z',
        '',
        '> Pricing goes live Friday',
        '',
        'Ship the pricing change before the demo.',
        '',
      ].join('\n'),
    );
  });

  test('fills a legacy entry with no file from the note name and omits line/quote', () => {
    const text = serializeCommentsFile(
      [{ id: 'cold1', file: '', line: null, quote: '', time: 't', transcript: 'x' }],
      NOTE,
    );
    expect(text).toContain('- file: meeting-notes.md');
    expect(text).not.toContain('- line:');
    expect(text).not.toContain('\n> ');
  });

  test('percent-encodes spaces in the title link but not the label', () => {
    const text = serializeCommentsFile([], 'my notes.md');
    expect(text).toContain('# Voice notes for [my notes.md](./my%20notes.md)');
  });
});

describe('parse/serialize round-trip', () => {
  test('round-trips a multi-note file including an audio field', () => {
    const comments: VoiceComment[] = [
      {
        id: 'c3f9a',
        file: NOTE,
        line: 3,
        quote: '- item one',
        time: '2026-07-13T10:22:04.511Z',
        transcript: 'Buy milk before Friday.',
      },
      {
        id: 'c7b21',
        file: NOTE,
        line: 10,
        quote: '',
        time: '2026-07-13T10:24:31.002Z',
        transcript: 'Follow up with design.',
        audio: 'foo.c7b21.webm',
      },
    ];
    const text = serializeCommentsFile(comments, NOTE);
    expect(parseCommentsFile(text)).toEqual([{ ...comments[0], audio: null }, comments[1]]);
  });

  test('preserves a multi-line transcript with dashes, list markers and blockquotes', () => {
    const comments: VoiceComment[] = [
      {
        id: 'cabcd',
        file: NOTE,
        line: 1,
        quote: 'Title',
        time: '2026-07-13T10:00:00.000Z',
        transcript: 'first line\n- a dashed line\n> quoted in the body\nsecond paragraph',
        audio: null,
      },
    ];
    const parsed = parseCommentsFile(serializeCommentsFile(comments, NOTE));
    expect(parsed).toEqual(comments);
  });

  test('handles an empty transcript (desktop record-only entry)', () => {
    const comments: VoiceComment[] = [
      { id: 'cnull', file: NOTE, line: 2, quote: 'q', time: 't', transcript: '', audio: 'a.webm' },
    ];
    expect(parseCommentsFile(serializeCommentsFile(comments, NOTE))).toEqual(comments);
  });

  test('an empty note list serializes to just the header/title and parses back empty', () => {
    expect(parseCommentsFile(serializeCommentsFile([], NOTE))).toEqual([]);
  });

  test('preserves a transcript whose first body line looks like metadata', () => {
    const comments: VoiceComment[] = [
      {
        id: 'cmeta',
        file: NOTE,
        line: 5,
        quote: '',
        time: '2026-07-13T10:00:00.000Z',
        transcript: '- audio: something\nand more text',
        audio: null,
      },
    ];
    expect(parseCommentsFile(serializeCommentsFile(comments, NOTE))).toEqual(comments);
  });

  test('tolerates CRLF line endings', () => {
    const text = serializeCommentsFile(
      [{ id: 'ccrlf', file: NOTE, line: 7, quote: 'the line', time: 't', transcript: 'hi\nthere' }],
      NOTE,
    ).replace(/\n/g, '\r\n');
    expect(parseCommentsFile(text)).toEqual([
      {
        id: 'ccrlf',
        file: NOTE,
        line: 7,
        quote: 'the line',
        time: 't',
        transcript: 'hi\nthere',
        audio: null,
      },
    ]);
  });
});

describe('legacy v1 files', () => {
  test('parse with empty file/line/quote and the body kept verbatim', () => {
    const v1 = [
      '<!-- md-notepad voice comments v1 -->',
      '',
      '## ^cxyz',
      '- time: 2026-01-01T00:00:00.000Z',
      '',
      '> a v1 body that happens to start with a blockquote',
      'and continues',
      '',
    ].join('\n');
    expect(parseCommentsFile(v1)).toEqual([
      {
        id: 'cxyz',
        file: '',
        line: null,
        quote: '',
        time: '2026-01-01T00:00:00.000Z',
        audio: null,
        transcript: '> a v1 body that happens to start with a blockquote\nand continues',
      },
    ]);
  });

  test('a headerless file is treated as v1', () => {
    const text = '## ^cxyz\n- time: t\n\nhello world\n';
    expect(parseCommentsFile(text)).toEqual([
      {
        id: 'cxyz',
        file: '',
        line: null,
        quote: '',
        time: 't',
        audio: null,
        transcript: 'hello world',
      },
    ]);
  });
});
