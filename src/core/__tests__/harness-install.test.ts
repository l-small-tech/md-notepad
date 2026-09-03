/**
 * The install-command policy: which route each harness gets per OS and tool
 * set, how a missing npm is bridged, and how the line is spelled for the
 * shell that runs it. These pin the documented commands verbatim — a change
 * here should come with a re-read of the tool's install page.
 */
import { describe, expect, test } from 'vitest';
import {
  INSTALL_TOOLS,
  defaultInstallShell,
  installCommandFor,
  installContextFrom,
  installShellFor,
  type InstallContext,
} from '../harness-install';
import { HARNESS_IDS } from '../types';

const NOTHING: InstallContext = { hasNpm: false };
const NPM: InstallContext = { hasNpm: true };
const WINGET: InstallContext = { hasNpm: false, hasWinget: true };
const BREW: InstallContext = { hasNpm: true, hasBrew: true };

describe('installShellFor', () => {
  test('macOS and Linux are always the POSIX dialect, whatever the shell', () => {
    expect(installShellFor('zsh', 'mac')).toBe('posix');
    expect(installShellFor('/usr/bin/fish', 'linux')).toBe('posix');
    expect(installShellFor(null, 'linux')).toBe('posix');
  });

  test('Windows tells PowerShell 7, Windows PowerShell and cmd apart by basename', () => {
    expect(installShellFor('pwsh.exe', 'windows')).toBe('pwsh');
    expect(installShellFor('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'windows')).toBe('pwsh');
    expect(installShellFor('powershell.exe', 'windows')).toBe('powershell');
    expect(installShellFor('PowerShell', 'windows')).toBe('powershell');
    expect(installShellFor('cmd.exe', 'windows')).toBe('cmd');
    // A hand-picked bash (Git for Windows / MSYS) speaks POSIX.
    expect(installShellFor('C:\\msys64\\usr\\bin\\bash.exe', 'windows')).toBe('posix');
    // Unknown = the platform's automatic pick, PowerShell 7.
    expect(installShellFor(null, 'windows')).toBe('pwsh');
    expect(defaultInstallShell('windows')).toBe('pwsh');
    expect(defaultInstallShell('mac')).toBe('posix');
  });
});

describe('installContextFrom', () => {
  test('maps the detected tools onto the context, absent = false', () => {
    expect(installContextFrom({ npm: true, winget: true })).toEqual({
      hasNpm: true,
      hasBrew: false,
      hasWinget: true,
      hasScoop: false,
    });
    expect(INSTALL_TOOLS).toEqual(['npm', 'brew', 'winget', 'scoop']);
  });
});

describe('installCommandFor — macOS/Linux', () => {
  test('Claude Code: brew cask on a Mac with Homebrew, else the native installer', () => {
    expect(installCommandFor('claude', 'mac', BREW)).toBe('brew install --cask claude-code');
    expect(installCommandFor('claude', 'mac', NOTHING)).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash',
    );
    // Linuxbrew is not assumed: Linux always gets the script.
    expect(installCommandFor('claude', 'linux', BREW)).toBe(
      'curl -fsSL https://claude.ai/install.sh | bash',
    );
  });

  test('Copilot, Codex and opencode: brew where it is, else their own scripts', () => {
    expect(installCommandFor('copilot', 'mac', BREW)).toBe('brew install --cask copilot-cli');
    expect(installCommandFor('copilot', 'linux', NPM)).toBe(
      'curl -fsSL https://gh.io/copilot-install | bash',
    );
    expect(installCommandFor('chatgpt', 'mac', BREW)).toBe('brew install --cask codex');
    expect(installCommandFor('chatgpt', 'linux', NOTHING)).toBe(
      'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    );
    expect(installCommandFor('opencode', 'mac', BREW)).toBe('brew install anomalyco/tap/opencode');
    expect(installCommandFor('opencode', 'linux', NOTHING)).toBe(
      'curl -fsSL https://opencode.ai/install | bash',
    );
    expect(installCommandFor('grok', 'mac', BREW)).toBe(
      'curl -fsSL https://x.ai/cli/install.sh | bash',
    );
  });

  test('Gemini is npm-only, and never the deprecated brew formula', () => {
    expect(installCommandFor('gemini', 'mac', BREW)).toBe('npm install -g @google/gemini-cli');
    expect(installCommandFor('gemini', 'linux', NPM)).toBe('npm install -g @google/gemini-cli');
  });

  test('no npm: Node comes first — brew on a Mac that has it, nvm elsewhere', () => {
    expect(installCommandFor('gemini', 'mac', { hasNpm: false, hasBrew: true })).toBe(
      'brew install node && npm install -g @google/gemini-cli',
    );
    expect(installCommandFor('gemini', 'linux', NOTHING)).toBe(
      'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh | bash && ' +
        '. "$HOME/.nvm/nvm.sh" && nvm install --lts && npm install -g @google/gemini-cli',
    );
    // A Mac without Homebrew takes the nvm route too.
    expect(installCommandFor('gemini', 'mac', NOTHING)).toMatch(/^curl -o- .*nvm.* && \. "\$HOME/);
  });

  test('every harness has a route on every unix OS whatever is installed', () => {
    for (const harness of HARNESS_IDS) {
      for (const os of ['mac', 'linux'] as const) {
        for (const ctx of [NOTHING, NPM, BREW]) {
          expect(installCommandFor(harness, os, ctx)).not.toBeNull();
        }
      }
    }
  });
});

describe('installCommandFor — Windows', () => {
  test('winget where the tool ships there: Claude Code and Copilot', () => {
    expect(installCommandFor('claude', 'windows', WINGET)).toBe(
      'winget install -e --id Anthropic.ClaudeCode',
    );
    expect(installCommandFor('copilot', 'windows', WINGET)).toBe(
      'winget install -e --id GitHub.Copilot',
    );
  });

  test('native installers: Claude without winget, Codex and Grok always', () => {
    expect(installCommandFor('claude', 'windows', NPM)).toBe(
      'irm https://claude.ai/install.ps1 | iex',
    );
    expect(installCommandFor('chatgpt', 'windows', WINGET)).toBe(
      'irm https://chatgpt.com/codex/install.ps1 | iex',
    );
    expect(installCommandFor('grok', 'windows', NOTHING)).toBe(
      'irm https://x.ai/cli/install.ps1 | iex',
    );
  });

  test('npm routes: Copilot without winget, Gemini, opencode without scoop', () => {
    expect(installCommandFor('copilot', 'windows', NPM)).toBe('npm install -g @github/copilot');
    expect(installCommandFor('gemini', 'windows', NPM)).toBe('npm install -g @google/gemini-cli');
    expect(installCommandFor('opencode', 'windows', NPM)).toBe('npm install -g opencode-ai');
    expect(installCommandFor('opencode', 'windows', { hasNpm: true, hasScoop: true })).toBe(
      'scoop install opencode',
    );
  });

  test('no npm: Node via winget first, then the PATH is refreshed in-session', () => {
    expect(installCommandFor('gemini', 'windows', WINGET)).toBe(
      'winget install -e --id OpenJS.NodeJS.LTS && ' +
        "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + " +
        "[Environment]::GetEnvironmentVariable('Path', 'User') && " +
        'npm install -g @google/gemini-cli',
    );
  });

  test('no npm and no winget: the npm-only tools have no route (null)', () => {
    expect(installCommandFor('gemini', 'windows', NOTHING)).toBeNull();
    expect(installCommandFor('copilot', 'windows', NOTHING)).toBeNull();
    expect(installCommandFor('opencode', 'windows', NOTHING)).toBeNull();
    // The native-installer tools still do.
    expect(installCommandFor('claude', 'windows', NOTHING)).not.toBeNull();
    expect(installCommandFor('chatgpt', 'windows', NOTHING)).not.toBeNull();
    expect(installCommandFor('grok', 'windows', NOTHING)).not.toBeNull();
  });

  test('Windows PowerShell 5.1 has no &&: steps nest under if ($?)', () => {
    expect(installCommandFor('gemini', 'windows', WINGET, 'powershell')).toBe(
      'winget install -e --id OpenJS.NodeJS.LTS; if ($?) { ' +
        "$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + " +
        "[Environment]::GetEnvironmentVariable('Path', 'User'); if ($?) { " +
        'npm install -g @google/gemini-cli } }',
    );
    // A single step needs no wrapping.
    expect(installCommandFor('claude', 'windows', NPM, 'powershell')).toBe(
      'irm https://claude.ai/install.ps1 | iex',
    );
  });

  test('cmd: PowerShell pipelines are handed to PowerShell, the rest is native', () => {
    expect(installCommandFor('claude', 'windows', NPM, 'cmd')).toBe(
      'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
    );
    expect(installCommandFor('chatgpt', 'windows', NPM, 'cmd')).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://chatgpt.com/codex/install.ps1 | iex"',
    );
    expect(installCommandFor('gemini', 'windows', WINGET, 'cmd')).toBe(
      'winget install -e --id OpenJS.NodeJS.LTS && ' +
        'set "PATH=%PATH%;%ProgramFiles%\\nodejs;%APPDATA%\\npm" && ' +
        'npm install -g @google/gemini-cli',
    );
  });

  test('a POSIX shell on Windows (Git Bash) gets bash spelling', () => {
    expect(installCommandFor('gemini', 'windows', WINGET, 'posix')).toBe(
      'winget install -e --id OpenJS.NodeJS.LTS && ' +
        'export PATH="$PATH:$PROGRAMFILES/nodejs:$APPDATA/npm" && ' +
        'npm install -g @google/gemini-cli',
    );
    expect(installCommandFor('grok', 'windows', NPM, 'posix')).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://x.ai/cli/install.ps1 | iex"',
    );
  });

  test('wrapped PowerShell lines never carry quotes or dollars (cmd/bash-safe)', () => {
    for (const harness of HARNESS_IDS) {
      for (const shell of ['cmd', 'posix'] as const) {
        const line = installCommandFor(harness, 'windows', WINGET, shell) ?? '';
        for (const m of line.matchAll(/-Command "([^"]*)"/g)) {
          expect(m[1]).not.toMatch(/["$]/);
        }
      }
    }
  });
});
