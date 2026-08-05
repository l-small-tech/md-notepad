/**
 * Layer and element operations. Two things are being pinned down here:
 * the behaviour itself, and IMMUTABILITY — every op must return a new document
 * and leave the old one untouched, because that is the entire basis of the
 * snapshot undo stack.
 */

import { describe, expect, it } from 'vitest';
import {
  addElement,
  addLayer,
  ensureDrawLayer,
  isEditable,
  moveLayer,
  removeElements,
  removeLayer,
  renameLayer,
  setLayerLocked,
  setLayerVisible,
  targetLayerId,
} from '../layers';
import { createLayer, createScene, type SceneDoc, type SceneElement } from '../scene';

const STROKE: SceneElement = {
  kind: 'stroke',
  id: null,
  tool: 'pen',
  d: 'M0 0L10 10',
  stroke: '#1a1a1a',
  strokeWidth: 3,
  opacity: null,
  widths: null,
};

/** Deterministic ids for the tests that create layers. */
function fixedRandom(): () => number {
  let n = 0;
  return () => (n += 0.137) % 1;
}

function board(...layers: ReturnType<typeof createLayer>[]): SceneDoc {
  return createScene({ layers });
}

describe('isEditable', () => {
  it('excludes hidden, locked and imported layers', () => {
    expect(isEditable(createLayer({ id: 'a' }))).toBe(true);
    expect(isEditable(createLayer({ id: 'a', visible: false }))).toBe(false);
    expect(isEditable(createLayer({ id: 'a', locked: true }))).toBe(false);
    expect(isEditable(createLayer({ id: 'a', kind: 'foreign' }))).toBe(false);
    // A scan layer is ordinary editable ink — that is the whole point of
    // centerline tracing.
    expect(isEditable(createLayer({ id: 'a', kind: 'scan' }))).toBe(true);
  });
});

describe('targetLayerId', () => {
  it('keeps the preferred layer while it stays editable', () => {
    const doc = board(createLayer({ id: 'a' }), createLayer({ id: 'b' }));
    expect(targetLayerId(doc, 'a')).toBe('a');
  });

  it('falls to the TOPMOST editable layer when the preference is unusable', () => {
    const doc = board(
      createLayer({ id: 'a' }),
      createLayer({ id: 'b' }),
      createLayer({ id: 'c', locked: true }),
    );
    expect(targetLayerId(doc, 'c')).toBe('b');
    expect(targetLayerId(doc, null)).toBe('b');
    expect(targetLayerId(doc, 'gone')).toBe('b');
  });

  it('is null when nothing can be drawn on', () => {
    const doc = board(createLayer({ id: 'x', kind: 'foreign', locked: true }));
    expect(targetLayerId(doc, null)).toBeNull();
  });
});

describe('ensureDrawLayer', () => {
  it('returns the document untouched when a target exists', () => {
    const doc = board(createLayer({ id: 'a' }));
    const result = ensureDrawLayer(doc, null);
    expect(result.doc).toBe(doc);
    expect(result.layerId).toBe('a');
  });

  it('adds a layer on top of an imported-only document (the foreign-SVG case)', () => {
    const doc = board(createLayer({ id: 'imported', kind: 'foreign', locked: true }));
    const result = ensureDrawLayer(doc, null, fixedRandom());
    expect(result.doc.layers).toHaveLength(2);
    expect(result.doc.layers[1]!.id).toBe(result.layerId);
    expect(result.doc.layers[0]!.kind).toBe('foreign');
    expect(doc.layers).toHaveLength(1); // the original is untouched
  });
});

describe('addLayer', () => {
  it('appends on top with a non-colliding name', () => {
    const doc = board(createLayer({ id: 'a', name: 'Layer 1' }));
    const next = addLayer(doc, undefined, fixedRandom());
    expect(next.layers).toHaveLength(2);
    expect(next.layers[1]!.name).toBe('Layer 2');
  });

  it('skips names already taken rather than duplicating them', () => {
    const doc = board(
      createLayer({ id: 'a', name: 'Layer 1' }),
      createLayer({ id: 'b', name: 'Layer 2' }),
    );
    expect(addLayer(doc, undefined, fixedRandom()).layers[2]!.name).toBe('Layer 3');
  });

  it('never reuses an existing id', () => {
    const doc = board(createLayer({ id: 'a' }));
    const next = addLayer(doc, undefined, fixedRandom());
    expect(next.layers[1]!.id).not.toBe('a');
  });
});

describe('visibility, locking and renaming', () => {
  const doc = board(createLayer({ id: 'a', name: 'Ink' }));

  it('sets flags without mutating the original', () => {
    expect(setLayerVisible(doc, 'a', false).layers[0]!.visible).toBe(false);
    expect(setLayerLocked(doc, 'a', true).layers[0]!.locked).toBe(true);
    expect(doc.layers[0]!.visible).toBe(true);
    expect(doc.layers[0]!.locked).toBe(false);
  });

  it('renames, trimming, and refuses to blank a name', () => {
    expect(renameLayer(doc, 'a', '  Sketch  ').layers[0]!.name).toBe('Sketch');
    expect(renameLayer(doc, 'a', '   ')).toBe(doc);
  });

  it('returns the SAME object when the id matches nothing (no wasted undo step)', () => {
    expect(setLayerVisible(doc, 'nope', false)).toBe(doc);
  });
});

describe('moveLayer', () => {
  const doc = board(createLayer({ id: 'a' }), createLayer({ id: 'b' }), createLayer({ id: 'c' }));

  it('moves through the z-order', () => {
    expect(moveLayer(doc, 'a', 1).layers.map((l) => l.id)).toEqual(['b', 'a', 'c']);
    expect(moveLayer(doc, 'c', -2).layers.map((l) => l.id)).toEqual(['c', 'a', 'b']);
  });

  it('clamps at the ends and is a no-op there', () => {
    expect(moveLayer(doc, 'a', -1)).toBe(doc);
    expect(moveLayer(doc, 'c', 5)).toBe(doc);
  });
});

describe('removeLayer', () => {
  it('removes one of several', () => {
    const doc = board(createLayer({ id: 'a' }), createLayer({ id: 'b' }));
    expect(removeLayer(doc, 'a').layers.map((l) => l.id)).toEqual(['b']);
  });

  it('EMPTIES the last layer instead of leaving nowhere to draw', () => {
    const doc = board(createLayer({ id: 'a', elements: [STROKE] }));
    const next = removeLayer(doc, 'a');
    expect(next.layers).toHaveLength(1);
    expect(next.layers[0]!.elements).toEqual([]);
  });
});

describe('addElement / removeElements', () => {
  it('appends on top of the named layer', () => {
    const doc = board(createLayer({ id: 'a' }), createLayer({ id: 'b' }));
    const next = addElement(doc, 'b', STROKE);
    expect(next.layers[1]!.elements).toEqual([STROKE]);
    expect(next.layers[0]).toBe(doc.layers[0]); // untouched layers are shared
  });

  it('deletes several elements across layers as ONE operation', () => {
    const doc = board(
      createLayer({ id: 'a', elements: [STROKE, STROKE, STROKE] }),
      createLayer({ id: 'b', elements: [STROKE, STROKE] }),
    );
    // Indices resolve against the document as passed in — applying them one at
    // a time would shift the later ones and delete the wrong strokes.
    const next = removeElements(doc, [
      { layerId: 'a', index: 0 },
      { layerId: 'a', index: 2 },
      { layerId: 'b', index: 1 },
    ]);
    expect(next.layers[0]!.elements).toHaveLength(1);
    expect(next.layers[1]!.elements).toHaveLength(1);
    expect(doc.layers[0]!.elements).toHaveLength(3);
  });

  it('is the same document when nothing matched', () => {
    const doc = board(createLayer({ id: 'a', elements: [STROKE] }));
    expect(removeElements(doc, [])).toBe(doc);
    expect(removeElements(doc, [{ layerId: 'a', index: 9 }])).toBe(doc);
  });
});
