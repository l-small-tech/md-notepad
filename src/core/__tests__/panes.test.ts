import { describe, expect, it } from 'vitest';
import {
  clampRatio,
  layoutPanes,
  leaf,
  neighborPane,
  normalizePaneTree,
  paneCount,
  paneIds,
  ratioFromDrag,
  removePane,
  setSplitRatio,
  splitPane,
  splitRect,
  type PaneNode,
} from '../panes';

/** a | b, then b split into b over c. */
function tree(): PaneNode {
  const one = splitPane(leaf('a'), 'a', { direction: 'row', newId: 'b', splitId: 's1' });
  return splitPane(one, 'b', { direction: 'column', newId: 'c', splitId: 's2' });
}

describe('splitPane', () => {
  it('replaces the target leaf with a split, the new pane second', () => {
    const split = splitPane(leaf('a'), 'a', { direction: 'row', newId: 'b', splitId: 's1' });
    expect(split).toEqual({
      kind: 'split',
      id: 's1',
      direction: 'row',
      ratio: 0.5,
      first: leaf('a'),
      second: leaf('b'),
    });
  });

  it('finds the target at any depth, and leaves the tree alone otherwise', () => {
    expect(paneIds(tree())).toEqual(['a', 'b', 'c']);
    const original = tree();
    // Same reference, not just an equal tree: React relies on that to skip
    // re-rendering untouched subtrees.
    expect(splitPane(original, 'nope', { direction: 'row', newId: 'x', splitId: 's' })).toBe(
      original,
    );
  });

  it('clamps a silly ratio', () => {
    const split = splitPane(leaf('a'), 'a', {
      direction: 'row',
      newId: 'b',
      splitId: 's',
      ratio: 0.999,
    });
    expect(split.kind === 'split' && split.ratio).toBe(0.9);
    expect(clampRatio(Number.NaN)).toBe(0.5);
  });
});

describe('removePane', () => {
  it('promotes the sibling into the split it leaves behind', () => {
    expect(removePane(tree(), 'c')).toEqual(
      splitPane(leaf('a'), 'a', { direction: 'row', newId: 'b', splitId: 's1' }),
    );
    expect(paneIds(removePane(tree(), 'a')!)).toEqual(['b', 'c']);
  });

  it('returns null for the last pane — the caller closes the tab', () => {
    expect(removePane(leaf('a'), 'a')).toBeNull();
  });

  it('ignores a pane that is not in the tree', () => {
    const original = tree();
    expect(removePane(original, 'zzz')).toBe(original);
  });
});

describe('setSplitRatio', () => {
  it('sets the named split and clamps the value', () => {
    const resized = setSplitRatio(tree(), 's2', 0.75);
    expect(splitRect(resized, 's2')).toBeTruthy();
    const layout = layoutPanes(resized);
    // 's2' splits the right half vertically: b takes three quarters of it.
    expect(layout.panes.find((pane) => pane.id === 'b')!.rect.height).toBeCloseTo(0.75);
    expect(setSplitRatio(tree(), 's2', 5)).not.toBe(tree());
    const clamped = setSplitRatio(tree(), 's2', 5);
    expect(
      clamped.kind === 'split' && clamped.second.kind === 'split' && clamped.second.ratio,
    ).toBe(0.9);
  });

  it('leaves other splits and unknown ids untouched', () => {
    const original = tree();
    expect(setSplitRatio(original, 'missing', 0.2)).toBe(original);
  });
});

describe('neighborPane', () => {
  it('cycles in visual order, wrapping both ways', () => {
    const node = tree();
    expect(neighborPane(node, 'a', 1)).toBe('b');
    expect(neighborPane(node, 'c', 1)).toBe('a');
    expect(neighborPane(node, 'a', -1)).toBe('c');
    // Delta 0 on a pane that is gone: the fallback is the first pane, which is
    // what closing the focused pane needs.
    expect(neighborPane(node, 'gone', 0)).toBe('a');
  });
});

describe('layoutPanes', () => {
  it('gives a lone pane the whole area', () => {
    expect(layoutPanes(leaf('a'))).toEqual({
      panes: [{ id: 'a', rect: { left: 0, top: 0, width: 1, height: 1 } }],
      dividers: [],
    });
  });

  it('splits the area by ratio, with a seam between', () => {
    const { panes, dividers } = layoutPanes(tree());
    expect(panes.find((pane) => pane.id === 'a')!.rect).toEqual({
      left: 0,
      top: 0,
      width: 0.5,
      height: 1,
    });
    // b and c share the right half, stacked.
    expect(panes.find((pane) => pane.id === 'b')!.rect).toEqual({
      left: 0.5,
      top: 0,
      width: 0.5,
      height: 0.5,
    });
    expect(panes.find((pane) => pane.id === 'c')!.rect).toEqual({
      left: 0.5,
      top: 0.5,
      width: 0.5,
      height: 0.5,
    });

    const vertical = dividers.find((divider) => divider.splitId === 's1')!;
    expect(vertical.rect).toEqual({ left: 0.5, top: 0, width: 0, height: 1 });
    const horizontal = dividers.find((divider) => divider.splitId === 's2')!;
    expect(horizontal.rect).toEqual({ left: 0.5, top: 0.5, width: 0.5, height: 0 });
  });

  it('tiles without gaps or overlap', () => {
    const area = layoutPanes(tree()).panes.reduce(
      (sum, pane) => sum + pane.rect.width * pane.rect.height,
      0,
    );
    expect(area).toBeCloseTo(1);
  });

  it('counts panes and finds a split rectangle', () => {
    expect(paneCount(tree())).toBe(3);
    expect(splitRect(tree(), 's2')).toEqual({ left: 0.5, top: 0, width: 0.5, height: 1 });
    expect(splitRect(tree(), 'nope')).toBeNull();
  });
});

describe('ratioFromDrag', () => {
  it('turns a position in the whole area into a ratio of one split', () => {
    const rect = splitRect(tree(), 's2')!;
    // Dragging the horizontal divider to a quarter down the window.
    expect(ratioFromDrag(rect, 'column', 0.25)).toBeCloseTo(0.25);
    // The right half starts at 0.5, so 0.75 of the window is its midpoint.
    const outer = splitRect(tree(), 's1')!;
    expect(ratioFromDrag(outer, 'row', 0.75)).toBeCloseTo(0.75);
    // Past the edge clamps instead of collapsing a pane to nothing.
    expect(ratioFromDrag(outer, 'row', 0)).toBe(0.1);
    expect(ratioFromDrag({ left: 0, top: 0, width: 0, height: 0 }, 'row', 0.5)).toBe(0.5);
  });
});

describe('normalizePaneTree', () => {
  const ids = () => {
    let n = 0;
    return () => `s${++n}`;
  };

  it('renames leaves through the supplied mapping', () => {
    const restored = normalizePaneTree(tree(), (stored) => `${stored}!`, ids());
    expect(paneIds(restored!)).toEqual(['a!', 'b!', 'c!']);
  });

  it('keeps the usable half of a damaged split', () => {
    const damaged = { kind: 'split', direction: 'row', ratio: 0.5, first: leaf('a'), second: 7 };
    expect(normalizePaneTree(damaged, (id) => id, ids())).toEqual(leaf('a'));
  });

  it('rejects what it cannot read at all', () => {
    expect(normalizePaneTree(null, (id) => id, ids())).toBeNull();
    expect(normalizePaneTree({ kind: 'window' }, (id) => id, ids())).toBeNull();
    expect(normalizePaneTree({ kind: 'leaf' }, (id) => id, ids())).toBeNull();
  });
});
