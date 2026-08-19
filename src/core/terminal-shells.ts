/**
 * The shells the Settings dialog offers, per desktop OS.
 *
 * There is ONE shell setting for the whole app (`settings.terminalShell`), not
 * one per profile: the app stays a notepad with a terminal in it, and a
 * profile manager is a feature of a terminal emulator. The stored value is
 * simply the program to spawn — a bare name resolved against `PATH`, an
 * absolute path, or `AUTO_SHELL` (empty) to let Rust pick the platform default
 * (`src-tauri/src/shell.rs`). Anything not in these lists is still valid and
 * reaches the dialog as "Custom", so the picker never limits what can run.
 */

export type DesktopOs = 'windows' | 'mac' | 'linux';

export interface ShellOption {
  /** The program written to `settings.terminalShell`. */
  readonly value: string;
  readonly label: string;
}

/** Empty = "let the backend decide" — the default, and what upgrades cleanly. */
export const AUTO_SHELL = '';

const WINDOWS: readonly ShellOption[] = [
  { value: AUTO_SHELL, label: 'Automatic (PowerShell 7, else Windows PowerShell)' },
  { value: 'pwsh.exe', label: 'PowerShell 7' },
  { value: 'powershell.exe', label: 'Windows PowerShell 5' },
  { value: 'cmd.exe', label: 'Command Prompt' },
];

const MAC: readonly ShellOption[] = [
  { value: AUTO_SHELL, label: 'Automatic (zsh)' },
  { value: 'zsh', label: 'Zsh' },
  { value: 'bash', label: 'Bash' },
  { value: 'fish', label: 'Fish' },
  { value: '/bin/sh', label: 'sh' },
];

const LINUX: readonly ShellOption[] = [
  { value: AUTO_SHELL, label: 'Automatic (bash)' },
  { value: 'bash', label: 'Bash' },
  { value: 'zsh', label: 'Zsh' },
  { value: 'fish', label: 'Fish' },
  { value: '/bin/sh', label: 'sh' },
];

export function shellOptions(os: DesktopOs): readonly ShellOption[] {
  switch (os) {
    case 'windows':
      return WINDOWS;
    case 'mac':
      return MAC;
    case 'linux':
      return LINUX;
  }
}

/**
 * The picker's label for the AUTO option once the backend has answered what
 * it would actually pick (`ipc.defaultShell()`): "Auto (zsh)", "Auto (pwsh)".
 * Directories and a Windows `.exe` suffix are trimmed — the label names the
 * shell, not its install location. null (answer not in yet) → plain "Auto".
 */
export function autoShellLabel(resolved: string | null): string {
  if (!resolved) {
    return 'Auto';
  }
  const base = resolved.replaceAll('\\', '/').split('/').pop() ?? resolved;
  const name = base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base;
  return name ? `Auto (${name})` : 'Auto';
}

/** True when a stored value is one of the offered shells (else: "Custom"). */
export function isListedShell(os: DesktopOs, program: string): boolean {
  return shellOptions(os).some((option) => option.value === program);
}

/** A hand-edited or pasted value, trimmed; blank collapses to `AUTO_SHELL`. */
export function normalizeShell(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : AUTO_SHELL;
}
