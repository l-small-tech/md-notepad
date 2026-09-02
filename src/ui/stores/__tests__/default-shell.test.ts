import { beforeEach, describe, expect, test, vi } from 'vitest';
import { setPtyProvider, type PtyProvider } from '../../../ipc/pty';
import { defaultShellStore, resetDefaultShell } from '../default-shell';

function provider(defaultShell: () => Promise<string>): PtyProvider {
  return {
    defaultShell,
    spawn: () => Promise.reject(new Error('not under test')),
  };
}

beforeEach(() => {
  resetDefaultShell();
  setPtyProvider(null);
});

describe('defaultShellStore', () => {
  test('asks the backend once and caches the answer', async () => {
    const ask = vi.fn(() => Promise.resolve('pwsh.exe'));
    setPtyProvider(provider(ask));

    expect(defaultShellStore.getState().program).toBeNull();
    await expect(defaultShellStore.getState().resolve()).resolves.toBe('pwsh.exe');
    await expect(defaultShellStore.getState().resolve()).resolves.toBe('pwsh.exe');
    expect(defaultShellStore.getState().program).toBe('pwsh.exe');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test('concurrent callers share one request', async () => {
    const ask = vi.fn(() => Promise.resolve('zsh'));
    setPtyProvider(provider(ask));

    const [a, b] = await Promise.all([
      defaultShellStore.getState().resolve(),
      defaultShellStore.getState().resolve(),
    ]);
    expect([a, b]).toEqual(['zsh', 'zsh']);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test('a failed request yields null and is retried next time', async () => {
    const ask = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('no backend'))
      .mockResolvedValueOnce('bash');
    setPtyProvider(provider(ask));

    await expect(defaultShellStore.getState().resolve()).resolves.toBeNull();
    expect(defaultShellStore.getState().program).toBeNull();
    await expect(defaultShellStore.getState().resolve()).resolves.toBe('bash');
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
