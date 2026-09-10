import { describe, expect, it } from 'vitest';

import { mergeThreeWay, pickMergeBase, restoreLostBlocks } from '../merge';

const base = 'one\ntwo\nthree\nfour\nfive\n';
const slice = (text: string, r: { from: number; to: number }) => text.slice(r.from, r.to);

describe('mergeThreeWay', () => {
  it('is a no-op when disk equals the baseline', () => {
    const r = mergeThreeWay(base, 'one\nTWO\nthree\nfour\nfive\n', base);
    expect(r.changed).toBe(false);
    expect(r.text).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(r.theirs).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  it('takes theirs wholesale when I have not edited, flagging the replaced line red then green', () => {
    const theirs = 'one\ntwo\nthree!\nfour\nfive\n';
    const r = mergeThreeWay(base, base, theirs);
    expect(r.text).toBe(theirs);
    expect(r.changed).toBe(true);
    expect(r.overlaps).toBe(0);
    expect(r.lost).toEqual([]);
    expect(r.removed.map((x) => slice(base, x))).toEqual(['three']);
    expect(r.theirs.map((x) => slice(r.text, x))).toEqual(['three!']);
  });

  it('merges non-overlapping edits from both sides', () => {
    const mine = 'ONE\ntwo\nthree\nfour\nfive\n';
    const theirs = 'one\ntwo\nthree\nfour\nFIVE\n';
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    expect(r.overlaps).toBe(0);
    expect(r.removed.map((x) => slice(mine, x))).toEqual(['five']);
    expect(r.theirs.map((x) => slice(r.text, x))).toEqual(['FIVE']);
  });

  it('lets theirs win where the same lines were edited differently, keeping mine aside', () => {
    const mine = 'one\ntwo\nthree (mine)\nfour\nfive\n';
    const theirs = 'one\ntwo\nthree (theirs)\nfour\nfive\n';
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe(theirs);
    expect(r.overlaps).toBe(1);
    expect(r.removed.map((x) => slice(mine, x))).toEqual(['three (mine)']);
    expect(r.theirs.map((x) => slice(r.text, x))).toEqual(['three (theirs)']);
    expect(r.lost).toEqual([
      { lines: ['three (mine)'], afterOffset: 'one\ntwo\nthree (theirs)\n'.length },
    ]);
  });

  it('takes an identical change once, flagging nothing', () => {
    const both = 'one\ntwo\nthree!\nfour\nfive\n';
    const r = mergeThreeWay(base, both, both);
    expect(r.text).toBe(both);
    expect(r.changed).toBe(false);
    expect(r.overlaps).toBe(0);
  });

  it('applies their deletion around my insertion, red on the line that goes', () => {
    const mine = 'one\ntwo\ntwo-and-a-half\nthree\nfour\nfive\n';
    const theirs = 'one\ntwo\nthree\nfour\n'; // deleted "five"
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe('one\ntwo\ntwo-and-a-half\nthree\nfour\n');
    expect(r.overlaps).toBe(0);
    // Red lands on MY line numbering (shifted by my insertion above it).
    expect(r.removed.map((x) => slice(mine, x))).toEqual(['five']);
    expect(r.theirs).toEqual([]);
  });

  it('treats insertions at the same point as an overlap: theirs stays, mine is lost', () => {
    const mine = 'one\nA\ntwo\nthree\nfour\nfive\n';
    const theirs = 'one\nB\ntwo\nthree\nfour\nfive\n';
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe(theirs);
    expect(r.overlaps).toBe(1);
    expect(r.lost).toEqual([{ lines: ['A'], afterOffset: 'one\nB\n'.length }]);
  });

  it('lets an insertion at a replaced block boundary order cleanly', () => {
    const mine = 'one\ntwo\nthree\nfour\nfive\nsix\n'; // append after five
    const theirs = 'one\ntwo\nthree\nfour\nFIVE\n'; // replace five
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe('one\ntwo\nthree\nfour\nFIVE\nsix\n');
    expect(r.overlaps).toBe(0);
  });

  it('converges: the other machine adopts the winning text without a further change', () => {
    const mine = 'x (A)\n';
    const theirs = 'x (B)\n';
    const onA = mergeThreeWay('x\n', mine, theirs); // A merges B's write: B wins
    expect(onA.text).toBe(theirs);
    const onB = mergeThreeWay(theirs, theirs, onA.text);
    expect(onB.changed).toBe(false);
  });

  it('preserves CRLF lines and a missing trailing newline', () => {
    const b = 'a\r\nb\r\nc';
    const r = mergeThreeWay(b, 'a\r\nb!\r\nc', 'a\r\nb\r\nc\r\nd');
    expect(r.text).toBe('a\r\nb!\r\nc\r\nd');
    // "c" gained a CR, so it counts as their line too.
    expect(r.theirs.map((x) => slice(r.text, x))).toEqual(['c\r\nd']);
  });

  it('merges into an empty base: theirs wins the collision', () => {
    const r = mergeThreeWay('', 'mine\n', 'theirs\n');
    expect(r.text).toBe('theirs\n');
    expect(r.overlaps).toBe(1);
    expect(r.lost[0]?.lines[0]).toBe('mine');
  });
});

describe('pickMergeBase', () => {
  const orig = 'title\n\n';
  const myWrite = 'title\n\nmy new line\n';

  it('falls back to the older snapshot when theirs never saw my write (lost update)', () => {
    // Their machine wrote from `orig`; the sync client let their save win.
    const theirs = 'title\n\ntheir new line\n';
    expect(pickMergeBase([myWrite, orig], theirs)).toBe(orig);
    // ...so the merge SEES the collision and reports my line as lost.
    const r = mergeThreeWay(orig, myWrite, theirs);
    expect(r.text).toBe(theirs);
    expect(r.overlaps).toBe(1);
    expect(r.lost[0]?.lines).toEqual(['my new line']);
  });

  it('keeps the newest snapshot when theirs builds on my write', () => {
    const theirs = 'title\n\nmy new line\ntheir line after mine\n';
    expect(pickMergeBase([myWrite, orig], theirs)).toBe(myWrite);
  });

  it('reads a tweak of a line I rewrote as sequential (newest base), not a collision', () => {
    const before = 'title\n\nold line\n';
    const rewritten = 'title\n\nmy new line\n';
    const theirs = 'title\n\nmy new line, improved\n';
    expect(pickMergeBase([rewritten, before], theirs)).toBe(rewritten);
    expect(mergeThreeWay(rewritten, rewritten, theirs).lost).toEqual([]);
  });

  it('cannot tell a tweak of a line I just INSERTED from a concurrent insert, and warns', () => {
    // Replacing my inserted line costs 2 changed lines against `myWrite` but
    // only 1 (an insert) against `orig`, so the older base wins: a Restore
    // offer the author can dismiss beats a line that vanishes.
    const theirs = 'title\n\nmy new line, improved\n';
    expect(pickMergeBase([myWrite, orig], theirs)).toBe(orig);
  });

  it('prefers the older base on an exact tie', () => {
    const base0 = 'a\nb\nc\n';
    const mine = 'a\nX\nc\n';
    const theirs = 'a\nY\nc\n';
    expect(pickMergeBase([mine, base0], theirs)).toBe(base0);
  });

  it('handles a single candidate and an empty list', () => {
    expect(pickMergeBase(['only'], 'x')).toBe('only');
    expect(pickMergeBase([], 'x')).toBe('');
  });
});

describe('restoreLostBlocks', () => {
  it('reinserts a block right after its replacement, on its own lines', () => {
    const merged = 'one\ntwo\nthree (theirs)\nfour\n';
    const lost = mergeThreeWay(base, 'one\ntwo\nthree (mine)\nfour\nfive\n', merged).lost;
    const { text, inserted } = restoreLostBlocks(merged, lost);
    expect(text).toBe('one\ntwo\nthree (theirs)\nthree (mine)\nfour\n');
    expect(inserted.map((x) => slice(text, x))).toEqual(['three (mine)']);
  });

  it('appends when the document shrank past the recorded spot, and splits a mid-line offset', () => {
    expect(restoreLostBlocks('a\nb', [{ lines: ['mine'], afterOffset: 99 }]).text).toBe(
      'a\nb\nmine',
    );
    expect(restoreLostBlocks('abcd\nz', [{ lines: ['mine'], afterOffset: 2 }]).text).toBe(
      'ab\nmine\ncd\nz',
    );
  });

  it('restores several blocks without shifting each other', () => {
    const text = 'A\nB\nC\n';
    const { text: out } = restoreLostBlocks(text, [
      { lines: ['a1'], afterOffset: 2 },
      { lines: ['c1', 'c2'], afterOffset: 6 },
    ]);
    expect(out).toBe('A\na1\nB\nC\nc1\nc2\n');
  });
});
