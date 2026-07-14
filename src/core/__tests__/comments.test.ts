import { describe, expect, test } from 'vitest';
import {
  commentsPathFor,
  findAnchors,
  insertAnchorText,
  isCommentsPath,
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

describe('findAnchors', () => {
  test('locates tokens with correct id, offsets, and 1-based line', () => {
    const doc = 'line one\n## Setup <!-- ^c1a2 -->\nbody\n- item <!-- ^c9zz -->';
    const anchors = findAnchors(doc);
    expect(anchors.map((a) => a.id)).toEqual(['c1a2', 'c9zz']);
    expect(anchors[0]!.line).toBe(2);
    expect(anchors[1]!.line).toBe(4);
    // Offset round-trips to the exact token text.
    expect(doc.slice(anchors[0]!.from, anchors[0]!.to)).toBe('<!-- ^c1a2 -->');
  });

  test('tolerates flexible whitespace inside the token', () => {
    expect(findAnchors('x <!--   ^cabc   -->').map((a) => a.id)).toEqual(['cabc']);
  });

  test('returns [] when there are no anchors', () => {
    expect(findAnchors('nothing here\njust text')).toEqual([]);
  });

  test('insertAnchorText produces a token findAnchors recognizes', () => {
    const doc = `heading${insertAnchorText('cff01')}`;
    expect(findAnchors(doc).map((a) => a.id)).toEqual(['cff01']);
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

  test('avoids a saturated prefix by retrying', () => {
    // Force a collision on the first candidate by pre-filling, and confirm it
    // still yields a fresh, valid id.
    const taken = new Set<string>(['c0000']);
    const id = newCommentId(taken);
    expect(id).not.toBe('c0000');
    expect(id).toMatch(/^c[0-9a-z]+$/);
  });
});

describe('parse/serialize round-trip', () => {
  test('round-trips a multi-comment file including an audio field', () => {
    const comments: VoiceComment[] = [
      { id: 'c3f9a', time: '2026-07-13T10:22:04.511Z', transcript: 'Buy milk before Friday.' },
      {
        id: 'c7b21',
        time: '2026-07-13T10:24:31.002Z',
        transcript: 'Follow up with design.',
        audio: 'foo.c7b21.webm',
      },
    ];
    const text = serializeCommentsFile(comments);
    expect(parseCommentsFile(text)).toEqual([
      { ...comments[0], audio: null },
      comments[1],
    ]);
  });

  test('preserves a multi-line transcript with dashes and list markers', () => {
    const comments: VoiceComment[] = [
      {
        id: 'cabcd',
        time: '2026-07-13T10:00:00.000Z',
        transcript: 'first line\n- a dashed line\nsecond paragraph',
        audio: null,
      },
    ];
    const parsed = parseCommentsFile(serializeCommentsFile(comments));
    expect(parsed[0]!.transcript).toBe('first line\n- a dashed line\nsecond paragraph');
  });

  test('tolerates CRLF line endings and a missing header', () => {
    const text = '## ^cxyz\r\n- time: 2026-01-01T00:00:00.000Z\r\n\r\nhello world\r\n';
    expect(parseCommentsFile(text)).toEqual([
      { id: 'cxyz', time: '2026-01-01T00:00:00.000Z', audio: null, transcript: 'hello world' },
    ]);
  });

  test('handles an empty transcript (desktop record-only entry)', () => {
    const comments: VoiceComment[] = [
      { id: 'cnull', time: '2026-01-01T00:00:00.000Z', transcript: '', audio: 'a.webm' },
    ];
    expect(parseCommentsFile(serializeCommentsFile(comments))).toEqual(comments);
  });

  test('an empty comment list serializes to just the header and parses back empty', () => {
    expect(parseCommentsFile(serializeCommentsFile([]))).toEqual([]);
  });
});
