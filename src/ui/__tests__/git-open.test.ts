/**
 * The git tab never types into a terminal. `openTerminalAt` is the feature's
 * only terminal call: it opens a shell or the harness IN a directory and
 * passes nothing else — no third argument, no `initialInput`, ever.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const openTerminal = vi.fn<(profileId?: string, cwd?: string, options?: unknown) => string | null>(
  () => 'tab-1',
);
vi.mock('../terminal-open', () => ({
  openTerminal: (...args: unknown[]) =>
    openTerminal(...(args as [string | undefined, string | undefined, unknown])),
}));
// git-open reaches the session facade only for the default workspace path.
vi.mock('../session', () => ({
  getDefaultWorkspacePath: () => null,
}));

import { HARNESS_PROFILE_ID } from '../../core/types';
import { openTerminalAt } from '../git-open';

const here = dirname(fileURLToPath(import.meta.url));

describe('openTerminalAt', () => {
  beforeEach(() => {
    openTerminal.mockClear();
  });

  test('a shell in a directory: the default profile, the cwd, nothing else', () => {
    openTerminalAt('C:/code/proj/worktrees/x', false);
    expect(openTerminal).toHaveBeenCalledTimes(1);
    const call = openTerminal.mock.calls[0]!;
    expect(call).toHaveLength(2);
    expect(call).toEqual([undefined, 'C:/code/proj/worktrees/x']);
  });

  test('the harness in a directory: the harness profile, the cwd, nothing else', () => {
    openTerminalAt('/r/worktrees/y', true);
    const call = openTerminal.mock.calls[0]!;
    expect(call).toHaveLength(2);
    expect(call).toEqual([HARNESS_PROFILE_ID, '/r/worktrees/y']);
  });

  test('the feature never mentions initialInput or a terminal-send action', () => {
    const files = [
      join(here, '..', 'git-open.ts'),
      join(here, '..', 'git-deps.ts'),
      join(here, '..', 'watch-dirs.ts'),
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/initialInput/);
      expect(source, file).not.toMatch(/terminal-send/);
    }
  });
});
