import { describe, expect, test, vi } from 'vitest';

// The module's default instance reaches the Tauri path API; only the factory
// is under test here.
vi.mock('../../ipc/paths', () => ({ resolveShellIntegrationDir: () => Promise.reject() }));
vi.mock('../../ipc/commands', () => ({ ipc: {} }));

import { createShellIntegration } from '../shell-integration';

function harness(dir: string | Error = 'C:\\App\\shell-integration') {
  const writes: Record<string, string> = {};
  const writeText = vi.fn((path: string, text: string) => {
    writes[path] = text;
    return Promise.resolve();
  });
  const integration = createShellIntegration({
    resolveDir: () => (dir instanceof Error ? Promise.reject(dir) : Promise.resolve(dir)),
    writeText,
  });
  return { integration, writes, writeText };
}

describe('createShellIntegration', () => {
  test('bash gets --rcfile pointing into the scripts dir, written on first use', async () => {
    const { integration, writes } = harness();
    const extras = await integration.launchFor('bash');
    expect(extras).toEqual({
      args: ['--rcfile', 'C:\\App\\shell-integration/bash/bashrc'],
      env: {},
    });
    expect(Object.keys(writes).sort()).toEqual([
      'C:\\App\\shell-integration/bash/bashrc',
      'C:\\App\\shell-integration/zsh/.zprofile',
      'C:\\App\\shell-integration/zsh/.zshenv',
      'C:\\App\\shell-integration/zsh/.zshrc',
    ]);
    expect(writes['C:\\App\\shell-integration/bash/bashrc']).toContain('__mdn_report_cwd');
  });

  test('zsh gets ZDOTDIR and no args', async () => {
    const { integration } = harness('/home/u/.local/share/app/shell-integration');
    await expect(integration.launchFor('zsh')).resolves.toEqual({
      args: [],
      env: { ZDOTDIR: '/home/u/.local/share/app/shell-integration/zsh' },
    });
  });

  test('the scripts are written once per instance, even for concurrent launches', async () => {
    const { integration, writeText } = harness();
    await Promise.all([integration.launchFor('bash'), integration.launchFor('zsh')]);
    await integration.launchFor('bash');
    expect(writeText).toHaveBeenCalledTimes(4);
  });

  test('pwsh, cmd and fish need no files: nothing is written', async () => {
    const { integration, writeText } = harness();
    const pwsh = await integration.launchFor('pwsh');
    expect(pwsh?.args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-Command']);
    expect((await integration.launchFor('cmd'))?.args[0]).toBe('/K');
    expect((await integration.launchFor('fish'))?.args[0]).toBe('--init-command');
    expect(writeText).not.toHaveBeenCalled();
  });

  test('a directory that cannot be written leaves bash and zsh plain, others intact', async () => {
    const { integration } = harness(new Error('read-only'));
    await expect(integration.launchFor('bash')).resolves.toBeNull();
    await expect(integration.launchFor('zsh')).resolves.toBeNull();
    expect(await integration.launchFor('pwsh')).not.toBeNull();
  });

  test('sh has no integration at all', async () => {
    const { integration, writeText } = harness();
    await expect(integration.launchFor('sh')).resolves.toBeNull();
    expect(writeText).not.toHaveBeenCalled();
  });
});
