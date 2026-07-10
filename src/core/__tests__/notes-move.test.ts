import { describe, expect, test } from 'vitest';
import { planNoteMoves } from '../notes-move';

describe('planNoteMoves', () => {
  test('maps each basename into the new directory', () => {
    expect(planNoteMoves(['a.md', 'b.md'], '/old', '/new')).toEqual([
      { from: '/old/a.md', to: '/new/a.md' },
      { from: '/old/b.md', to: '/new/b.md' },
    ]);
  });

  test('accepts full paths and moves by basename', () => {
    expect(planNoteMoves(['/old/note.md'], '/old', '/new')).toEqual([
      { from: '/old/note.md', to: '/new/note.md' },
    ]);
  });

  test('same directory is a no-op', () => {
    expect(planNoteMoves(['a.md'], '/old', '/old')).toEqual([]);
  });

  test('empty listing yields no moves', () => {
    expect(planNoteMoves([], '/old', '/new')).toEqual([]);
  });

  test('de-duplicates repeated basenames', () => {
    expect(planNoteMoves(['a.md', '/old/a.md', 'a.md'], '/old', '/new')).toEqual([
      { from: '/old/a.md', to: '/new/a.md' },
    ]);
  });

  test('honors a trailing separator on the target dir', () => {
    expect(planNoteMoves(['a.md'], '/old', '/new/')).toEqual([
      { from: '/old/a.md', to: '/new/a.md' },
    ]);
  });
});
