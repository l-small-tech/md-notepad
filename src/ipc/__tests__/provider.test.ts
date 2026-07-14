import { afterEach, describe, expect, test } from 'vitest';
import { LocalFsProvider, currentProvider, setProvider } from '../provider';
import { ipc } from '../commands';

afterEach(() => {
  setProvider(LocalFsProvider);
});

describe('LocalFsProvider', () => {
  test('delegates its fs methods straight to ipc', () => {
    expect(LocalFsProvider.readTextFile).toBe(ipc.readTextFile);
    expect(LocalFsProvider.atomicWriteText).toBe(ipc.atomicWriteText);
    expect(LocalFsProvider.listDir).toBe(ipc.listDir);
    expect(LocalFsProvider.statPath).toBe(ipc.statPath);
    expect(LocalFsProvider.renamePath).toBe(ipc.renamePath);
    expect(LocalFsProvider.deletePath).toBe(ipc.deletePath);
  });

  test('reports local-filesystem capabilities (desktop test env)', () => {
    expect(LocalFsProvider.capabilities.isLocalFs).toBe(true);
    expect(LocalFsProvider.capabilities.canRename).toBe(true);
    // The test env's UA is not Android, so folder-picking is available.
    expect(LocalFsProvider.capabilities.canPickDir).toBe(true);
  });
});

describe('provider registry', () => {
  test('defaults to the local provider', () => {
    expect(currentProvider()).toBe(LocalFsProvider);
  });

  test('setProvider swaps the active provider', () => {
    const fake = { ...LocalFsProvider, id: 'fake' };
    setProvider(fake);
    expect(currentProvider()).toBe(fake);
    expect(currentProvider().id).toBe('fake');
  });
});
