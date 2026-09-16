import { describe, expect, test } from 'vitest';
import { carryGrid, DEFAULT_GRID, gridOf, gridSnaps, setGrid, snapToGrid } from '../grid';
import { createHistory } from '../history';
import { parseWhiteboard } from '../parse';
import { createScene } from '../scene';
import { serializeWhiteboard } from '../serialize';

describe('grid accessors', () => {
  test('a document with no grid key reads as the default', () => {
    expect(gridOf(createScene())).toEqual(DEFAULT_GRID);
    expect(DEFAULT_GRID).toEqual({ show: false, size: 20, snap: true });
  });

  test('invalid metadata degrades field by field', () => {
    expect(gridOf(createScene({ meta: { grid: 'on' } }))).toEqual(DEFAULT_GRID);
    expect(gridOf(createScene({ meta: { grid: null } }))).toEqual(DEFAULT_GRID);
    expect(gridOf(createScene({ meta: { grid: [1, 2] } }))).toEqual(DEFAULT_GRID);
    // A usable field survives beside a broken one.
    expect(gridOf(createScene({ meta: { grid: { show: true, size: 'big' } } }))).toEqual({
      show: true,
      size: 20,
      snap: true,
    });
    expect(gridOf(createScene({ meta: { grid: { size: 0 } } })).size).toBe(20);
    expect(gridOf(createScene({ meta: { grid: { size: -8 } } })).size).toBe(20);
  });

  test('setGrid round-trips through gridOf', () => {
    const doc = setGrid(createScene(), { show: true, size: 32, snap: false });
    expect(gridOf(doc)).toEqual({ show: true, size: 32, snap: false });
    expect(gridOf(setGrid(doc, { size: 8 }))).toEqual({ show: true, size: 8, snap: false });
  });

  test('a default grid emits no key at all, and going back to it removes one', () => {
    const plain = createScene();
    expect(setGrid(plain, { show: false })).toBe(plain);
    expect('grid' in setGrid(plain, DEFAULT_GRID).meta).toBe(false);
    const shown = setGrid(plain, { show: true });
    expect(shown.meta.grid).toEqual({ show: true });
    expect('grid' in setGrid(shown, { show: false }).meta).toBe(false);
  });

  test('only the fields that differ from the default are written', () => {
    expect(setGrid(createScene(), { show: true, size: 20, snap: true }).meta.grid).toEqual({
      show: true,
    });
    expect(setGrid(createScene(), { show: true, size: 25, snap: false }).meta.grid).toEqual({
      show: true,
      size: 25,
      snap: false,
    });
  });

  test('a no-op patch returns the same document', () => {
    const doc = setGrid(createScene(), { show: true, size: 16 });
    expect(setGrid(doc, { show: true })).toBe(doc);
    expect(setGrid(doc, { size: 16 })).toBe(doc);
  });

  test('other metadata is untouched', () => {
    const doc = setGrid(createScene({ meta: { colorMode: 'fixed', ocr: { a: 1 } } }), {
      show: true,
    });
    expect(doc.meta.colorMode).toBe('fixed');
    expect(doc.meta.ocr).toEqual({ a: 1 });
  });

  test('the grid survives a save and a reload', () => {
    const doc = setGrid(createScene(), { show: true, size: 25, snap: false });
    const text = serializeWhiteboard(doc);
    expect(gridOf(parseWhiteboard(text))).toEqual({ show: true, size: 25, snap: false });
    // Fixed point: the setting does not perturb the serializer.
    expect(serializeWhiteboard(parseWhiteboard(text))).toBe(text);
  });

  test('a board written before the grid existed is byte-identical after a reload', () => {
    const before = serializeWhiteboard(createScene());
    expect(before).not.toContain('grid');
    expect(serializeWhiteboard(parseWhiteboard(before))).toBe(before);
  });

  test('the grid is never drawn into the file', () => {
    const text = serializeWhiteboard(setGrid(createScene(), { show: true }));
    expect(text).not.toContain('<pattern');
    expect(text).not.toContain('wb-grid');
    // The ONLY trace is the metadata blob.
    expect(text).toContain('"grid":{"show":true}');
  });
});

describe('grid snapping helpers', () => {
  test('gridSnaps needs both switches and a visible grid', () => {
    expect(gridSnaps({ show: true, size: 20, snap: true })).toBe(true);
    expect(gridSnaps({ show: false, size: 20, snap: true })).toBe(false);
    expect(gridSnaps({ show: true, size: 20, snap: false })).toBe(false);
    expect(gridSnaps({ show: true, size: 0, snap: true })).toBe(false);
  });

  test('snapToGrid rounds to the nearest multiple, through zero', () => {
    expect(snapToGrid(23, 20)).toBe(20);
    expect(snapToGrid(31, 20)).toBe(40);
    expect(snapToGrid(-9, 20)).toBe(-0);
    expect(snapToGrid(-11, 20)).toBe(-20);
    expect(snapToGrid(7, 0)).toBe(7);
  });
});

describe('undo carries the current grid', () => {
  test('carryGrid puts the live settings on a restored snapshot', () => {
    const before = setGrid(createScene(), { show: false });
    const after = setGrid(before, { show: true, size: 50 });
    expect(gridOf(carryGrid(before, after))).toEqual({ show: true, size: 50, snap: true });
    expect(gridOf(carryGrid(after, before))).toEqual(DEFAULT_GRID);
  });

  test('toggling the grid costs no undo step, and Ctrl+Z does not bring it back', () => {
    // The adapter's shape: edits are pushed, a grid change is `replace`d, and
    // every restore is carried through `carryGrid`.
    const history = createHistory(createScene());
    const edited = { ...history.current(), width: 1300 };
    history.push(edited);
    // The user shows the grid — no push.
    let live = setGrid(history.current(), { show: true, size: 32 });
    history.replace(live);
    expect(history.canUndo()).toBe(true);

    live = carryGrid(history.undo(), live);
    expect(live.width).toBe(1200); // the edit was undone…
    expect(gridOf(live)).toEqual({ show: true, size: 32, snap: true }); // …the grid was not
    expect(history.canUndo()).toBe(false);

    live = carryGrid(history.redo(), live);
    expect(live.width).toBe(1300);
    expect(gridOf(live)).toEqual({ show: true, size: 32, snap: true });
  });
});
