import { describe, expect, test } from 'vitest';
import {
  CMD_PROMPT_COMMAND,
  FISH_INIT_COMMAND,
  POWERSHELL_SNIPPET,
  SHELL_INTEGRATION_FILES,
  integrationNeedsScripts,
  pathFromFileUrl,
  shellIntegrationLaunch,
  withShellIntegration,
} from '../shell-integration';
import type { ShellKind } from '../terminal-shells';

const ALL: ShellKind[] = ['pwsh', 'powershell', 'cmd', 'bash', 'zsh', 'fish', 'sh'];

describe('shellIntegrationLaunch', () => {
  test('PowerShell (both hosts): an inline command, kept interactive, no logo', () => {
    for (const kind of ['pwsh', 'powershell'] as const) {
      const extras = shellIntegrationLaunch(kind, null);
      expect(extras?.args).toEqual(['-NoLogo', '-NoExit', '-Command', POWERSHELL_SNIPPET]);
      expect(extras?.env).toEqual({});
    }
  });

  test('the PowerShell snippet is one line with no double quotes (CreateProcess round trip)', () => {
    expect(POWERSHELL_SNIPPET).not.toMatch(/["\n\r]/);
    // Wraps the user's prompt rather than replacing it, and emits OSC 7 only
    // for filesystem locations.
    expect(POWERSHELL_SNIPPET).toContain('$function:prompt');
    expect(POWERSHELL_SNIPPET).toContain("-eq 'FileSystem'");
    expect(POWERSHELL_SNIPPET).toContain("']7;'");
    expect(POWERSHELL_SNIPPET).toContain('AbsoluteUri');
  });

  test('cmd: /K with a prompt that composes with the existing PROMPT', () => {
    expect(shellIntegrationLaunch('cmd', null)).toEqual({
      args: ['/K', CMD_PROMPT_COMMAND],
      env: {},
    });
    expect(CMD_PROMPT_COMMAND).toBe('prompt $E]7;file:///$P$E\\%PROMPT%');
  });

  test('fish: an init command adding a fish_prompt handler', () => {
    expect(shellIntegrationLaunch('fish', null)).toEqual({
      args: ['--init-command', FISH_INIT_COMMAND],
      env: {},
    });
    expect(FISH_INIT_COMMAND).toContain('--on-event fish_prompt');
    expect(FISH_INIT_COMMAND).toContain("printf '\\e]7;file://%s%s\\e\\\\'");
  });

  test('bash: --rcfile into the scripts dir; nothing without one', () => {
    expect(shellIntegrationLaunch('bash', '/data/shell-integration/')).toEqual({
      args: ['--rcfile', '/data/shell-integration/bash/bashrc'],
      env: {},
    });
    expect(shellIntegrationLaunch('bash', null)).toBeNull();
  });

  test('zsh: ZDOTDIR into the scripts dir; nothing without one', () => {
    expect(shellIntegrationLaunch('zsh', 'C:\\App\\shell-integration')).toEqual({
      args: [],
      env: { ZDOTDIR: 'C:\\App\\shell-integration/zsh' },
    });
    expect(shellIntegrationLaunch('zsh', null)).toBeNull();
  });

  test('sh gets nothing', () => {
    expect(shellIntegrationLaunch('sh', '/data')).toBeNull();
  });

  test('only bash and zsh need files on disk', () => {
    expect(ALL.filter(integrationNeedsScripts)).toEqual(['bash', 'zsh']);
  });
});

describe('SHELL_INTEGRATION_FILES', () => {
  test('covers the paths the launch args point at', () => {
    const paths = SHELL_INTEGRATION_FILES.map((f) => f.path);
    expect(paths).toContain('bash/bashrc');
    expect(paths).toEqual(expect.arrayContaining(['zsh/.zshenv', 'zsh/.zshrc', 'zsh/.zprofile']));
  });

  test("every script sources the user's own file and emits OSC 7 or hands back", () => {
    const byPath = Object.fromEntries(SHELL_INTEGRATION_FILES.map((f) => [f.path, f.text]));
    expect(byPath['bash/bashrc']).toContain('. "$HOME/.bashrc"');
    expect(byPath['bash/bashrc']).toContain("printf '\\033]7;file://%s%s\\033\\\\'");
    expect(byPath['bash/bashrc']).toContain('PROMPT_COMMAND');
    expect(byPath['zsh/.zshrc']).toContain('source "${ZDOTDIR:-$HOME}/.zshrc"');
    expect(byPath['zsh/.zshrc']).toContain('add-zsh-hook precmd __mdn_report_cwd');
    expect(byPath['zsh/.zshenv']).toContain('source "${ZDOTDIR:-$HOME}/.zshenv"');
    // Every file ends the way a text editor would write it.
    for (const file of SHELL_INTEGRATION_FILES) {
      expect(file.text.endsWith('\n')).toBe(true);
      expect(file.text).not.toContain('\r');
    }
  });
});

describe('withShellIntegration', () => {
  test('profile args first, ours after; profile env wins over ours', () => {
    expect(
      withShellIntegration(
        { args: ['-NoProfile'], env: { ZDOTDIR: '/theirs', FOO: '1' } },
        { args: ['-NoExit'], env: { ZDOTDIR: '/ours', BAR: '2' } },
      ),
    ).toEqual({
      args: ['-NoProfile', '-NoExit'],
      env: { ZDOTDIR: '/theirs', FOO: '1', BAR: '2' },
    });
  });

  test('no extras: the launch is returned untouched', () => {
    const launch = { args: ['x'], env: {} };
    expect(withShellIntegration(launch, null)).toBe(launch);
  });
});

describe('pathFromFileUrl', () => {
  test('POSIX paths, percent-decoded, host ignored', () => {
    expect(pathFromFileUrl('file://host/home/u/my%20notes')).toBe('/home/u/my notes');
    expect(pathFromFileUrl('file:///tmp/%C3%BC')).toBe('/tmp/ü');
  });

  test('Windows drive paths lose the artificial leading slash', () => {
    expect(pathFromFileUrl('file:///C:/Users/Logan%20S/x')).toBe('C:/Users/Logan S/x');
    expect(pathFromFileUrl('file:///C:')).toBe('C:');
  });

  test("cmd's unencoded backslash form still decodes", () => {
    expect(pathFromFileUrl('file:///C:\\Users\\Logan')).toBe('C:/Users/Logan');
  });

  test('a stray % (cmd does not encode) keeps the raw path instead of dropping it', () => {
    expect(pathFromFileUrl('file:///C:/100%/x')).toBe('C:/100%/x');
  });

  test('anything not a file URL is null', () => {
    expect(pathFromFileUrl('https://example.com/x')).toBeNull();
    expect(pathFromFileUrl('not a url')).toBeNull();
  });
});
