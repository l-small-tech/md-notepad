import { describe, expect, test } from 'vitest';

import {
  AUTO_SHELL,
  autoShellLabel,
  isListedShell,
  normalizeShell,
  shellKind,
  shellOptions,
  type DesktopOs,
} from '../terminal-shells';

describe('shellKind', () => {
  test('judges by basename, ignoring directories, case and a .exe suffix', () => {
    expect(shellKind('pwsh.exe')).toBe('pwsh');
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
    expect(shellKind('pwsh-preview')).toBe('pwsh');
    expect(shellKind('powershell.exe')).toBe('powershell');
    expect(shellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE')).toBe(
      'powershell',
    );
    expect(shellKind('cmd.exe')).toBe('cmd');
    expect(shellKind('/bin/bash')).toBe('bash');
    expect(shellKind('/usr/local/bin/zsh')).toBe('zsh');
    expect(shellKind('fish')).toBe('fish');
    expect(shellKind('/bin/sh')).toBe('sh');
    expect(shellKind('dash')).toBe('sh');
  });

  test('anything else is null — an agent, ssh, an unknown shell, nothing', () => {
    expect(shellKind('claude')).toBeNull();
    expect(shellKind('ssh')).toBeNull();
    expect(shellKind('nu')).toBeNull();
    expect(shellKind('')).toBeNull();
    expect(shellKind(null)).toBeNull();
    expect(shellKind(undefined)).toBeNull();
  });
});
import { DEFAULT_SETTINGS, normalizeSettings, terminalProgram } from '../settings';
import { SHELL_PROFILE_ID, type TerminalProfile } from '../types';

const OSES: DesktopOs[] = ['windows', 'mac', 'linux'];

describe('shellOptions', () => {
  test('every OS leads with the automatic choice', () => {
    for (const os of OSES) {
      expect(shellOptions(os)[0]?.value).toBe(AUTO_SHELL);
    }
  });

  test('each OS offers the shell the request named as its default', () => {
    // The labels promise a default; these are the values a user picks to pin
    // that same shell explicitly, so they must exist.
    expect(shellOptions('windows').map((o) => o.value)).toContain('pwsh.exe');
    expect(shellOptions('windows').map((o) => o.value)).toContain('powershell.exe');
    expect(shellOptions('mac').map((o) => o.value)).toContain('zsh');
    expect(shellOptions('linux').map((o) => o.value)).toContain('bash');
  });

  test('no duplicate values within an OS (a select would break)', () => {
    for (const os of OSES) {
      const values = shellOptions(os).map((o) => o.value);
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

describe('isListedShell', () => {
  test('recognises an offered shell and rejects anything else', () => {
    expect(isListedShell('linux', 'bash')).toBe(true);
    expect(isListedShell('linux', AUTO_SHELL)).toBe(true);
    expect(isListedShell('linux', '/opt/nu/bin/nu')).toBe(false);
    // Per-OS: pwsh is not offered on Linux even though it can be installed
    // there — the picker lists the usual, "Custom" covers the rest.
    expect(isListedShell('linux', 'pwsh.exe')).toBe(false);
  });
});

describe('normalizeShell', () => {
  test('trims, and collapses blank or non-string to automatic', () => {
    expect(normalizeShell('  /usr/bin/fish \n')).toBe('/usr/bin/fish');
    expect(normalizeShell('   ')).toBe(AUTO_SHELL);
    expect(normalizeShell(undefined)).toBe(AUTO_SHELL);
    expect(normalizeShell(42)).toBe(AUTO_SHELL);
  });

  test('normalizeSettings routes terminalShell through it', () => {
    expect(normalizeSettings({ terminalShell: ' zsh ' }).terminalShell).toBe('zsh');
    expect(normalizeSettings({}).terminalShell).toBe(AUTO_SHELL);
  });
});

describe('terminalProgram', () => {
  const loginShell: TerminalProfile = {
    id: SHELL_PROFILE_ID,
    name: 'System shell',
    args: [],
    env: {},
  };
  const claude: TerminalProfile = {
    id: 'claude',
    name: 'Claude',
    program: 'claude',
    args: [],
    env: {},
  };

  test('automatic leaves the program unset, so Rust picks the platform default', () => {
    expect(terminalProgram(DEFAULT_SETTINGS, loginShell)).toBeUndefined();
  });

  test('the app-wide setting fills in for a profile that names no program', () => {
    const settings = { ...DEFAULT_SETTINGS, terminalShell: 'pwsh.exe' };
    expect(terminalProgram(settings, loginShell)).toBe('pwsh.exe');
  });

  test("a profile's own program wins over the setting", () => {
    const settings = { ...DEFAULT_SETTINGS, terminalShell: 'pwsh.exe' };
    expect(terminalProgram(settings, claude)).toBe('claude');
  });
});

describe('terminalFont', () => {
  test('defaults to Fira Code rather than following the editor font', () => {
    expect(DEFAULT_SETTINGS.terminalFont).toBe('fira-code');
    expect(normalizeSettings({ editorFont: 'inconsolata' }).terminalFont).toBe('fira-code');
  });

  test('accepts match and any editor font id, and rejects junk', () => {
    expect(normalizeSettings({ terminalFont: 'match' }).terminalFont).toBe('match');
    expect(normalizeSettings({ terminalFont: 'victor-mono' }).terminalFont).toBe('victor-mono');
    expect(normalizeSettings({ terminalFont: 'Comic Sans' }).terminalFont).toBe('fira-code');
  });
});

describe('autoShellLabel', () => {
  test('names the resolved shell, without directories or .exe', () => {
    expect(autoShellLabel('zsh')).toBe('Auto (zsh)');
    expect(autoShellLabel('/usr/bin/bash')).toBe('Auto (bash)');
    expect(autoShellLabel('pwsh.exe')).toBe('Auto (pwsh)');
    expect(autoShellLabel('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('Auto (pwsh)');
  });

  test('plain "Auto" until the backend has answered', () => {
    expect(autoShellLabel(null)).toBe('Auto');
    expect(autoShellLabel('')).toBe('Auto');
  });
});
