/**
 * Shell integration, the side-effecting half: put the bash/zsh scripts from
 * `core/shell-integration.ts` on disk and hand a pane the launch extras for
 * its shell. The scripts are (re)written once per app process, on the first
 * terminal that needs them — so an upgrade that changes a script takes effect
 * on the next launch, and a user's edits never persist (the files say so).
 *
 * Failure is soft: if the directory cannot be written, bash/zsh open without
 * integration (the app just cannot follow their `cd`); pwsh, cmd and fish
 * need no files and are unaffected.
 */

import {
  SHELL_INTEGRATION_FILES,
  integrationNeedsScripts,
  shellIntegrationLaunch,
  type ShellLaunchExtras,
} from '../core/shell-integration';
import type { ShellKind } from '../core/terminal-shells';
import { ipc } from '../ipc/commands';
import { resolveShellIntegrationDir } from '../ipc/paths';

export interface ShellIntegrationDeps {
  /** The directory the scripts live in (`ipc/paths.ts`). */
  resolveDir: () => Promise<string>;
  /** Write one file, creating parent directories (`ipc.atomicWriteText`). */
  writeText: (path: string, text: string) => Promise<void>;
}

export interface ShellIntegration {
  /** The launch extras for a shell, writing the scripts first if it needs them. */
  launchFor: (kind: ShellKind) => Promise<ShellLaunchExtras | null>;
}

/** Injectable so the write-once contract is testable without a filesystem. */
export function createShellIntegration(deps: ShellIntegrationDeps): ShellIntegration {
  let scriptsDir: Promise<string | null> | null = null;

  function ensureScripts(): Promise<string | null> {
    scriptsDir ??= (async () => {
      try {
        const dir = await deps.resolveDir();
        const base = dir.replace(/[\\/]+$/, '');
        for (const file of SHELL_INTEGRATION_FILES) {
          await deps.writeText(`${base}/${file.path}`, file.text);
        }
        return dir;
      } catch {
        // Leave the failure cached for this process: retrying on every
        // terminal would just repeat the same IO error.
        return null;
      }
    })();
    return scriptsDir;
  }

  return {
    async launchFor(kind) {
      const dir = integrationNeedsScripts(kind) ? await ensureScripts() : null;
      return shellIntegrationLaunch(kind, dir);
    },
  };
}

const app = createShellIntegration({
  resolveDir: resolveShellIntegrationDir,
  writeText: (path, text) => ipc.atomicWriteText(path, text),
});

/** The app's instance: what `TerminalPane` appends to a plain shell's launch. */
export function shellIntegrationFor(kind: ShellKind): Promise<ShellLaunchExtras | null> {
  return app.launchFor(kind);
}
