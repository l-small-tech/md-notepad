/** The undo stack: branch discarding, the cap, and no-op rejection. */

import { describe, expect, it } from 'vitest';
import { createHistory } from '../history';

describe('createHistory', () => {
  it('starts with nowhere to go', () => {
    const history = createHistory('a');
    expect(history.current()).toBe('a');
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    // Stepping off either end is a no-op, not an error.
    expect(history.undo()).toBe('a');
    expect(history.redo()).toBe('a');
  });

  it('walks back and forward through pushed states', () => {
    const history = createHistory('a');
    history.push('b');
    history.push('c');
    expect(history.undo()).toBe('b');
    expect(history.undo()).toBe('a');
    expect(history.canUndo()).toBe(false);
    expect(history.redo()).toBe('b');
    expect(history.redo()).toBe('c');
    expect(history.canRedo()).toBe(false);
  });

  it('discards the redo branch on a new edit', () => {
    const history = createHistory('a');
    history.push('b');
    history.undo();
    history.push('c');
    expect(history.canRedo()).toBe(false);
    expect(history.current()).toBe('c');
    expect(history.undo()).toBe('a');
  });

  it('ignores a push of the identical state (an op that changed nothing)', () => {
    const doc = { n: 1 };
    const history = createHistory(doc);
    history.push(doc);
    expect(history.canUndo()).toBe(false);
  });

  it('drops the OLDEST state at the cap, never the current one', () => {
    const history = createHistory(0, 3);
    for (let n = 1; n <= 10; n++) {
      history.push(n);
    }
    expect(history.current()).toBe(10);
    expect(history.undo()).toBe(9);
    expect(history.undo()).toBe(8);
    expect(history.canUndo()).toBe(false);
  });

  it('reset throws the whole timeline away (an external file change)', () => {
    const history = createHistory('a');
    history.push('b');
    history.reset('fresh');
    expect(history.current()).toBe('fresh');
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});
