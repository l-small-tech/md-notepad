import { beforeEach, describe, expect, test } from 'vitest';

import { uiStore } from '../ui';

const state = () => uiStore.getState();

beforeEach(() => {
  state().setSelectedExplorerDir(null);
});

describe('dropSelectedExplorerDirUnder', () => {
  test('clears the selection when the deleted root IS the selected dir', () => {
    state().setSelectedExplorerDir('/notes/projects');
    state().dropSelectedExplorerDirUnder('/notes/projects');
    expect(state().selectedExplorerDir).toBeNull();
  });

  test('clears the selection when the deleted root contains the selected dir', () => {
    state().setSelectedExplorerDir('/notes/projects/2026');
    state().dropSelectedExplorerDirUnder('/notes/projects');
    expect(state().selectedExplorerDir).toBeNull();
  });

  test('compares path keys, so separators and case do not defeat the clear', () => {
    state().setSelectedExplorerDir('C:\\Notes\\Projects\\2026');
    state().dropSelectedExplorerDirUnder('c:/notes/projects');
    expect(state().selectedExplorerDir).toBeNull();
  });

  test('leaves an unrelated selection alone — including sibling name prefixes', () => {
    state().setSelectedExplorerDir('/notes/projects-archive');
    state().dropSelectedExplorerDirUnder('/notes/projects');
    expect(state().selectedExplorerDir).toBe('/notes/projects-archive');
  });
});
