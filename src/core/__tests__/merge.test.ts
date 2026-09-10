import { describe, expect, it } from 'vitest';

import { mergeThreeWay } from '../merge';

const base = 'one\ntwo\nthree\nfour\nfive\n';

describe('mergeThreeWay', () => {
  it('is a no-op when disk equals the baseline', () => {
    const r = mergeThreeWay(base, 'one\nTWO\nthree\nfour\nfive\n', base);
    expect(r.changed).toBe(false);
    expect(r.text).toBe('one\nTWO\nthree\nfour\nfive\n');
    expect(r.theirs).toEqual([]);
  });

  it('takes theirs wholesale when I have not edited', () => {
    const theirs = 'one\ntwo\nthree!\nfour\nfive\n';
    const r = mergeThreeWay(base, base, theirs);
    expect(r.text).toBe(theirs);
    expect(r.changed).toBe(true);
    expect(r.overlaps).toBe(0);
    expect(r.theirs).toEqual([{ from: 8, to: 14, startLine: 2, endLine: 3 }]);
  });

  it('merges non-overlapping edits from both sides', () => {
    const mine = 'ONE\ntwo\nthree\nfour\nfive\n';
    const theirs = 'one\ntwo\nthree\nfour\nFIVE\n';
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
    expect(r.overlaps).toBe(0);
    expect(r.theirs.map((x) => r.text.slice(x.from, x.to))).toEqual(['FIVE']);
  });

  it('keeps both versions when the same lines were edited differently', () => {
    const mine = 'one\ntwo\nthree (mine)\nfour\nfive\n';
    const theirs = 'one\ntwo\nthree (theirs)\nfour\nfive\n';
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe('one\ntwo\nthree (mine)\nthree (theirs)\nfour\nfive\n');
    expect(r.overlaps).toBe(1);
    expect(r.theirs.map((x) => r.text.slice(x.from, x.to))).toEqual(['three (theirs)']);
  });

  it('takes an identical change once, without highlighting it', () => {
    const both = 'one\ntwo\nthree!\nfour\nfive\n';
    const r = mergeThreeWay(base, both, both);
    expect(r.text).toBe(both);
    expect(r.changed).toBe(false);
    expect(r.overlaps).toBe(0);
  });

  it('applies their deletion around my insertion', () => {
    const mine = 'one\ntwo\ntwo-and-a-half\nthree\nfour\nfive\n';
    const theirs = 'one\ntwo\nthree\nfour\n'; // deleted "five"
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe('one\ntwo\ntwo-and-a-half\nthree\nfour\n');
    expect(r.overlaps).toBe(0);
  });

  it('treats insertions at the same point as an overlap and keeps both', () => {
    const mine = 'one\nA\ntwo\nthree\nfour\nfive\n';
    const theirs = 'one\nB\ntwo\nthree\nfour\nfive\n';
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe('one\nA\nB\ntwo\nthree\nfour\nfive\n');
    expect(r.overlaps).toBe(1);
  });

  it('lets an insertion at a replaced block boundary order cleanly', () => {
    const mine = 'one\ntwo\nthree\nfour\nfive\nsix\n'; // append after five
    const theirs = 'one\ntwo\nthree\nfour\nFIVE\n'; // replace five
    const r = mergeThreeWay(base, mine, theirs);
    expect(r.text).toBe('one\ntwo\nthree\nfour\nFIVE\nsix\n');
    expect(r.overlaps).toBe(0);
  });

  it('converges: the other machine adopts the kept-both text without re-merging', () => {
    const mine = 'x (A)\n';
    const theirs = 'x (B)\n';
    const onA = mergeThreeWay('x\n', mine, theirs); // A merges B's write
    // B's baseline is its own write; disk now holds A's merged text; B typed nothing since.
    const onB = mergeThreeWay(theirs, theirs, onA.text);
    expect(onB.text).toBe(onA.text);
    expect(onB.overlaps).toBe(0);
  });

  it('preserves CRLF lines and a missing trailing newline', () => {
    const b = 'a\r\nb\r\nc';
    const r = mergeThreeWay(b, 'a\r\nb!\r\nc', 'a\r\nb\r\nc\r\nd');
    expect(r.text).toBe('a\r\nb!\r\nc\r\nd');
    // "c" gained a CR, so it counts as their line too.
    expect(r.theirs.map((x) => r.text.slice(x.from, x.to))).toEqual(['c\r\nd']);
  });

  it('merges into an empty base', () => {
    const r = mergeThreeWay('', 'mine\n', 'theirs\n');
    expect(r.text).toBe('mine\ntheirs\n');
    expect(r.overlaps).toBe(1);
  });
});
