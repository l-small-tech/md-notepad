import { describe, expect, test, vi } from 'vitest';
import { createDocModel } from '../doc-model';

describe('createDocModel', () => {
  test('starts clean with version 0', () => {
    const model = createDocModel('hello');
    expect(model.getText()).toBe('hello');
    expect(model.getVersion()).toBe(0);
    expect(model.isDirty('session')).toBe(false);
    expect(model.isDirty('file')).toBe(false);
  });

  test('pushText updates text, bumps version, returns the new version', () => {
    const model = createDocModel('');
    const v1 = model.pushText('a', 'cm6');
    expect(v1).toBe(1);
    expect(model.getText()).toBe('a');
    const v2 = model.pushText('ab', 'cm6');
    expect(v2).toBe(2);
  });

  test('identical push is a no-op: same version, no notification', () => {
    const model = createDocModel('same');
    const listener = vi.fn();
    model.subscribe(listener);
    const v = model.pushText('same', 'milkdown');
    expect(v).toBe(0);
    expect(listener).not.toHaveBeenCalled();
  });

  test('subscribers get text, version and source synchronously', () => {
    const model = createDocModel('');
    const listener = vi.fn();
    model.subscribe(listener);
    model.pushText('x', 'file-load');
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      text: 'x',
      version: 1,
      source: 'file-load',
    });
  });

  test('unsubscribe stops notifications', () => {
    const model = createDocModel('');
    const listener = vi.fn();
    const unsubscribe = model.subscribe(listener);
    unsubscribe();
    model.pushText('x', 'cm6');
    expect(listener).not.toHaveBeenCalled();
  });

  test('a listener may unsubscribe itself during dispatch', () => {
    const model = createDocModel('');
    const calls: string[] = [];
    const unsubscribe = model.subscribe(() => {
      calls.push('first');
      unsubscribe();
    });
    model.subscribe(() => calls.push('second'));
    model.pushText('x', 'cm6');
    model.pushText('y', 'cm6');
    expect(calls).toEqual(['first', 'second', 'second']);
  });

  test('reentrancy-flag echo suppression pattern works', () => {
    // This is the exact pattern editor adapters use (src/editors/README.md).
    // NOTE a version-comparison filter CANNOT work here: dispatch is
    // synchronous, so the listener runs before the caller could store the
    // version returned by pushText.
    const model = createDocModel('');
    let pushingSelf = false;
    const applied: string[] = [];
    model.subscribe(({ text }) => {
      if (pushingSelf) {
        return; // our own push echoing back
      }
      applied.push(text);
    });

    pushingSelf = true;
    try {
      model.pushText('typed in this editor', 'cm6');
    } finally {
      pushingSelf = false;
    }
    model.pushText('changed elsewhere', 'programmatic');
    expect(applied).toEqual(['changed elsewhere']);
  });

  test('dirty tracking is independent per persistence kind', () => {
    const model = createDocModel('start');
    model.pushText('edited', 'cm6');
    expect(model.isDirty('session')).toBe(true);
    expect(model.isDirty('file')).toBe(true);

    model.markPersisted('session');
    expect(model.isDirty('session')).toBe(false);
    expect(model.isDirty('file')).toBe(true);

    model.markPersisted('file');
    expect(model.isDirty('file')).toBe(false);
  });

  test('reverting to the persisted text makes the doc clean again', () => {
    const model = createDocModel('start');
    model.pushText('edited', 'cm6');
    model.pushText('start', 'cm6');
    // String-snapshot dirty tracking can see through an edit-then-undo.
    expect(model.isDirty('session')).toBe(false);
  });
});
