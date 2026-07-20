import { describe, expect, test } from 'vitest';
import { planOutlineJump } from '../outline-jump';

describe('planOutlineJump — the mode matrix', () => {
  test('raw with a source adapter jumps by line', () => {
    expect(planOutlineJump('raw', true, false, 2, 17)).toEqual({ kind: 'line', line: 17 });
  });

  test('split with a source adapter jumps by line (split counts as raw)', () => {
    expect(planOutlineJump('split', true, true, 0, 5)).toEqual({ kind: 'line', line: 5 });
  });

  test('raw/split without a source adapter cannot jump', () => {
    expect(planOutlineJump('raw', false, false, 2, 17)).toEqual({ kind: 'none' });
    expect(planOutlineJump('split', false, true, 2, 17)).toEqual({ kind: 'none' });
  });

  test('read with a pane reveal jumps by heading index', () => {
    expect(planOutlineJump('read', false, true, 3, 40)).toEqual({ kind: 'heading', index: 3 });
  });

  test('read without a pane reveal cannot jump (even with a source adapter)', () => {
    expect(planOutlineJump('read', true, false, 3, 40)).toEqual({ kind: 'none' });
  });

  test('wysiwyg jumps by heading index regardless of the other mechanisms', () => {
    expect(planOutlineJump('wysiwyg', false, false, 1, 9)).toEqual({ kind: 'heading', index: 1 });
    expect(planOutlineJump('wysiwyg', true, true, 1, 9)).toEqual({ kind: 'heading', index: 1 });
  });
});
