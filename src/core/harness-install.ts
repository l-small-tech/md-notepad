/**
 * How to install each harness: the command line the Settings dialog's
 * **Install** button types into a fresh shell tab.
 *
 * Pure policy, no execution — the shell the user sees is what runs it, so the
 * user can read the exact command first and is left standing in a shell
 * afterwards. Routes follow each tool's official install docs (URLs beside
 * each entry) and prefer, in order:
 *
 *   1. a native package manager the tool officially ships in (winget, brew,
 *      scoop) — installs are then upgradable the way everything else is;
 *   2. the tool's own user-space installer script;
 *   3. `npm install -g`, with a Node.js install step prepended when npm is
 *      missing (see `nodeSteps`).
 *
 * User space throughout: nothing here asks for `sudo`, and the one route that
 * can raise a UAC prompt (Node's Windows installer) is used only where every
 * documented alternative needs the same or worse.
 *
 * The line is shaped for the shell that will run it (`InstallShell`): the
 * only real fork is Windows, where PowerShell, cmd and a POSIX shell (Git
 * Bash) spell the same steps three ways.
 */

import { shellKind, type DesktopOs } from './terminal-shells';
import type { HarnessId } from './types';

/**
 * The shell dialect the install line is written in. `pwsh` (PowerShell 7)
 * and `powershell` (Windows PowerShell 5.1) share syntax except for `&&`,
 * which 5.1 lacks — hence two kinds.
 */
export type InstallShell = 'posix' | 'pwsh' | 'powershell' | 'cmd';

/**
 * Which package managers are on `PATH`, from the same `find_programs` scan
 * that finds the harnesses (`INSTALL_TOOLS` names the programs to ask for).
 */
export interface InstallContext {
  hasNpm: boolean;
  hasBrew?: boolean;
  hasWinget?: boolean;
  hasScoop?: boolean;
}

/** Programs whose presence shapes an install line — detect these alongside the harnesses. */
export const INSTALL_TOOLS = ['npm', 'brew', 'winget', 'scoop'] as const;
export type InstallTool = (typeof INSTALL_TOOLS)[number];

/** `InstallContext` from a per-program presence map (`INSTALL_TOOLS` keys). */
export function installContextFrom(has: Partial<Record<InstallTool, boolean>>): InstallContext {
  return {
    hasNpm: has.npm ?? false,
    hasBrew: has.brew ?? false,
    hasWinget: has.winget ?? false,
    hasScoop: has.scoop ?? false,
  };
}

/**
 * The dialect for a shell program (`settings.terminalShell`, or what
 * `default_shell` resolved). Matched on the basename so `C:\…\pwsh.exe` and
 * `pwsh` agree. Anything unrecognised on Windows is assumed POSIX — a
 * hand-picked `bash.exe` from Git or MSYS is the realistic case — and every
 * shell on macOS/Linux speaks the POSIX line (fish included: `&&` and
 * `curl … | bash` are the same there).
 */
export function installShellFor(
  shellProgram: string | null | undefined,
  os: DesktopOs,
): InstallShell {
  if (os !== 'windows') {
    return 'posix';
  }
  // One basename parser for the whole app: the same `shellKind` the pane uses
  // to choose its shell integration decides the install dialect.
  switch (shellKind(shellProgram ?? 'pwsh')) {
    case 'pwsh':
      return 'pwsh';
    case 'powershell':
      return 'powershell';
    case 'cmd':
      return 'cmd';
    default:
      return 'posix';
  }
}

/** The dialect a plain terminal on this OS speaks when nothing is configured. */
export function defaultInstallShell(os: DesktopOs): InstallShell {
  return os === 'windows' ? 'pwsh' : 'posix';
}

/**
 * One step of a Windows install, spelled for each dialect. Most steps are the
 * same program invocation three times; the ones that differ are PowerShell
 * pipelines (`irm … | iex`) and environment edits.
 */
interface WinStep {
  ps: string;
  cmd: string;
  sh: string;
}

/** A step that reads the same in every Windows shell (a plain program call). */
function same(line: string): WinStep {
  return { ps: line, cmd: line, sh: line };
}

/**
 * A PowerShell-only pipeline, run from cmd or bash by handing it to
 * PowerShell. The inner line must contain neither `"` nor `$` for the
 * wrapping to survive both cmd's and bash's quoting — every caller's does.
 */
function viaPowershell(ps: string): WinStep {
  const wrapped = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`;
  return { ps, cmd: wrapped, sh: wrapped };
}

/**
 * Node.js on Windows when npm is missing.
 *
 * Chosen: the official installer through winget (`OpenJS.NodeJS.LTS`). It is
 * an MSI declared `Scope: machine`, so it raises ONE UAC prompt — the user
 * sees it in front of the terminal and answers it, the way a `sudo` prompt
 * would be answered on Linux. `--scope user` is not honoured for this
 * package (the manifest allows only machine scope), and the user-space
 * alternative, fnm, only works once a `fnm env` line is added to the
 * PowerShell profile — which on a stock Windows install never runs at all
 * (execution policy `Restricted`), so a fresh terminal would still have no
 * `node`, and the harness installed under it would look missing forever.
 * The MSI puts `node` and npm's global bin dir on the persistent PATH; the
 * second step folds that into the CURRENT session so `npm` resolves right
 * away. `npm -g` itself needs no elevation (`%APPDATA%\npm` is user-owned).
 *
 * Without winget there is no documented route that avoids a manual download,
 * so the install is declined (null) and the row says why.
 */
function windowsNodeSteps(ctx: InstallContext): WinStep[] | null {
  if (!ctx.hasWinget) {
    return null;
  }
  return [
    same('winget install -e --id OpenJS.NodeJS.LTS'),
    {
      ps: "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')",
      cmd: 'set "PATH=%PATH%;%ProgramFiles%\\nodejs;%APPDATA%\\npm"',
      sh: 'export PATH="$PATH:$PROGRAMFILES/nodejs:$APPDATA/npm"',
    },
  ];
}

/**
 * Node.js on macOS/Linux when npm is missing.
 *
 * macOS with Homebrew: `brew install node` — the package manager the user
 * already has. Everywhere else: nvm's installer, which lives entirely in
 * `~/.nvm`, appends its own lines to the shell profile (so future shells
 * have `node` too), and is sourced here so THIS shell has it immediately.
 * Distro packages were rejected on purpose: Ubuntu LTS ships a Node several
 * majors behind what these CLIs require (Copilot: 22+, Gemini: 20+), and
 * they would need `sudo` besides. nvm is pinned to the release its README
 * documents at the time of writing (v0.40.7) — an unpinned URL is a moving
 * target.
 */
function posixNodeSteps(os: DesktopOs, ctx: InstallContext): string[] {
  if (os === 'mac' && ctx.hasBrew) {
    return ['brew install node'];
  }
  return [
    'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash',
    '. "$HOME/.nvm/nvm.sh"',
    'nvm install --lts',
  ];
}

/** The npm route on Windows, with Node first when there is no npm. */
function windowsNpm(pkg: string, ctx: InstallContext): WinStep[] | null {
  const install = same(`npm install -g ${pkg}`);
  if (ctx.hasNpm) {
    return [install];
  }
  const node = windowsNodeSteps(ctx);
  return node ? [...node, install] : null;
}

/** The npm route on macOS/Linux, with Node first when there is no npm. */
function posixNpm(pkg: string, os: DesktopOs, ctx: InstallContext): string[] {
  const install = `npm install -g ${pkg}`;
  return ctx.hasNpm ? [install] : [...posixNodeSteps(os, ctx), install];
}

/**
 * Windows routes, per harness. Sources:
 * - Claude Code: https://code.claude.com/docs/en/setup — winget
 *   `Anthropic.ClaudeCode`, else the native installer (`irm … install.ps1 |
 *   iex`; cmd gets the documented `install.cmd` form). Both are user-space.
 * - Copilot CLI: https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli
 *   — winget `GitHub.Copilot`, else npm `@github/copilot` (Node 22+).
 * - Codex: https://learn.chatgpt.com/docs/codex/cli — the native PowerShell
 *   installer. A winget id exists in the community repo but is not on any
 *   OpenAI page, so it is not relied on.
 * - Gemini CLI: https://geminicli.com/docs/get-started/installation/ — npm
 *   `@google/gemini-cli` only; there is no winget package.
 * - opencode: https://opencode.ai/docs/ — scoop when present (the officially
 *   listed Windows package manager), else npm `opencode-ai`; the curl
 *   installer is a bash script and does not apply here.
 * - Grok: xAI's Grok Build, https://docs.x.ai/build/overview — the native
 *   installer (`irm https://x.ai/cli/install.ps1 | iex`); nothing on npm,
 *   brew or winget is official.
 */
function windowsSteps(harness: HarnessId, ctx: InstallContext): WinStep[] | null {
  switch (harness) {
    case 'claude':
      return ctx.hasWinget
        ? [same('winget install -e --id Anthropic.ClaudeCode')]
        : [
            {
              ps: 'irm https://claude.ai/install.ps1 | iex',
              cmd: 'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
              sh: viaPowershell('irm https://claude.ai/install.ps1 | iex').sh,
            },
          ];
    case 'copilot':
      return ctx.hasWinget
        ? [same('winget install -e --id GitHub.Copilot')]
        : windowsNpm('@github/copilot', ctx);
    case 'chatgpt':
      return [viaPowershell('irm https://chatgpt.com/codex/install.ps1 | iex')];
    case 'gemini':
      return windowsNpm('@google/gemini-cli', ctx);
    case 'opencode':
      return ctx.hasScoop ? [same('scoop install opencode')] : windowsNpm('opencode-ai', ctx);
    case 'grok':
      return [viaPowershell('irm https://x.ai/cli/install.ps1 | iex')];
  }
}

/**
 * macOS and Linux routes, per harness. Sources as in `windowsSteps`, plus:
 * - Claude Code: brew cask `claude-code` on a Mac with Homebrew, else the
 *   native `install.sh`. The apt/dnf repositories exist but need a signing
 *   key and a sources entry installed with `sudo` first — the user-space
 *   script is the documented default and self-updates.
 * - Copilot CLI: brew cask `copilot-cli` (https://formulae.brew.sh/cask/copilot-cli),
 *   else the official `gh.io/copilot-install` script.
 * - Codex: brew cask `codex`, else `chatgpt.com/codex/install.sh`.
 * - Gemini CLI: npm. Homebrew's `gemini-cli` formula is marked deprecated
 *   (disable date 2026-12-18), so it is not offered even where brew exists.
 * - opencode: the `anomalyco/tap/opencode` tap (the docs' recommended brew
 *   route) on a Mac with Homebrew, else the official `opencode.ai/install`
 *   script, which lands in `~/.opencode/bin` or `~/bin`.
 * - Grok: `x.ai/cli/install.sh`.
 */
function posixSteps(harness: HarnessId, os: DesktopOs, ctx: InstallContext): string[] {
  const brew = os === 'mac' && ctx.hasBrew === true;
  switch (harness) {
    case 'claude':
      return brew
        ? ['brew install --cask claude-code']
        : ['curl -fsSL https://claude.ai/install.sh | bash'];
    case 'copilot':
      return brew
        ? ['brew install --cask copilot-cli']
        : ['curl -fsSL https://gh.io/copilot-install | bash'];
    case 'chatgpt':
      return brew
        ? ['brew install --cask codex']
        : ['curl -fsSL https://chatgpt.com/codex/install.sh | sh'];
    case 'gemini':
      return posixNpm('@google/gemini-cli', os, ctx);
    case 'opencode':
      return brew
        ? ['brew install anomalyco/tap/opencode']
        : ['curl -fsSL https://opencode.ai/install | bash'];
    case 'grok':
      return ['curl -fsSL https://x.ai/cli/install.sh | bash'];
  }
}

/**
 * Join steps so a failure stops the chain, in each dialect: `&&` where the
 * shell has it (POSIX, cmd, PowerShell 7); Windows PowerShell 5.1 has no
 * `&&`, so later steps nest under `if ($?)` — same semantics, spelled long.
 */
function joinSteps(steps: string[], shell: InstallShell): string {
  if (shell !== 'powershell') {
    return steps.join(' && ');
  }
  return steps.reduceRight((rest, step) => (rest ? `${step}; if ($?) { ${rest} }` : step), '');
}

/**
 * The full command line that installs `harness` on this machine, or null when
 * no documented route exists with what is installed (on Windows: npm-only
 * tools when neither npm nor winget is present). `shell` defaults to the
 * OS's usual one, which is enough to decide whether a route exists at all.
 */
export function installCommandFor(
  harness: HarnessId,
  os: DesktopOs,
  ctx: InstallContext,
  shell: InstallShell = defaultInstallShell(os),
): string | null {
  if (os !== 'windows') {
    return joinSteps(posixSteps(harness, os, ctx), 'posix');
  }
  const steps = windowsSteps(harness, ctx);
  if (!steps) {
    return null;
  }
  const dialect = shell === 'posix' ? 'sh' : shell === 'cmd' ? 'cmd' : 'ps';
  return joinSteps(
    steps.map((step) => step[dialect]),
    shell,
  );
}
