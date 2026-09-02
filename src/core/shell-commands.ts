/**
 * Commands the app TYPES into a shell on the user's behalf — the right-click
 * helpers on a terminal pane ("Change directory…", "List files", "Open
 * <agent>"). The point of those helpers is to teach: what gets typed is what
 * the user would have typed, so each command is spelled the way that shell
 * expects it and quoted only when it has to be (`cd ..\src`, not
 * `cd '..\src'`).
 *
 * Everything here is pure and tested. Three quoting dialects:
 *
 *   PowerShell  single quotes, `'` doubled; `cd` (the alias of Set-Location
 *               everyone knows) with `-LiteralPath` only when the path holds
 *               a wildcard character. A program that needs quoting is invoked
 *               with `&`.
 *   cmd         double quotes when the token has a space or a metacharacter;
 *               `cd /d` so a change of drive works too.
 *   POSIX       single quotes, `'` as `'\''`; `cd --` for a name that begins
 *               with `-`.
 *
 * `relativePath` decides how a folder picked in the OS dialog is spelled:
 * relative when it lies in the same workspace as the pane's cwd (`cdTarget`),
 * absolute otherwise. Windows paths compare case-insensitively and never cross
 * a drive letter (or a UNC share); POSIX paths compare exactly.
 */

import type { ShellKind } from './terminal-shells';
import { workspaceForPath, type WorkspaceRoot } from './tab-workspaces';

/** How paths are compared and rooted — the OS, not the shell (Git Bash on Windows walks Windows paths). */
export type PathOs = 'windows' | 'posix';

interface ParsedDir {
  /** `c:` / `//server/share` (lowercased) on Windows, `/` on POSIX. */
  root: string;
  segments: string[];
}

/** Split an absolute directory into root + normalized segments; null for a relative or unrecognized path. */
function parseDir(path: string, os: PathOs): ParsedDir | null {
  let root: string;
  let rest: string;
  if (os === 'windows') {
    const p = path.replaceAll('\\', '/');
    const drive = /^([A-Za-z]):(?:\/|$)/.exec(p);
    const unc = drive ? null : /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(p);
    if (drive) {
      root = `${drive[1]!.toLowerCase()}:`;
      rest = p.slice(drive[0].length);
    } else if (unc) {
      root = `//${unc[1]}/${unc[2]}`.toLowerCase();
      rest = p.slice(unc[0].length);
    } else {
      return null;
    }
  } else {
    if (!path.startsWith('/')) {
      return null;
    }
    root = '/';
    rest = path.slice(1);
  }
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return { root, segments };
}

/**
 * `toDir` relative to `fromDir`, `/`-separated (`../src/app`), or `.` when
 * they are the same folder. Null when no relative form exists: a different
 * drive or share on Windows, or an input that is not an absolute path.
 */
export function relativePath(fromDir: string, toDir: string, os: PathOs): string | null {
  const from = parseDir(fromDir, os);
  const to = parseDir(toDir, os);
  if (!from || !to || from.root !== to.root) {
    return null;
  }
  const same =
    os === 'windows'
      ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      : (a: string, b: string) => a === b;
  let common = 0;
  while (
    common < from.segments.length &&
    common < to.segments.length &&
    same(from.segments[common]!, to.segments[common]!)
  ) {
    common++;
  }
  const parts = [
    ...Array.from({ length: from.segments.length - common }, () => '..'),
    ...to.segments.slice(common),
  ];
  return parts.length === 0 ? '.' : parts.join('/');
}

/**
 * How to spell a folder the user picked: relative to the pane's cwd when both
 * lie in the SAME open workspace (the everyday case — moving around inside a
 * project), absolute otherwise (another workspace, another drive, no cwd yet).
 */
export function cdTarget(
  cwd: string | null,
  target: string,
  roots: readonly WorkspaceRoot[],
  os: PathOs,
): { path: string; relative: boolean } {
  if (cwd) {
    const from = workspaceForPath(cwd, roots);
    const to = workspaceForPath(target, roots);
    if (from && to && from.key === to.key) {
      const relative = relativePath(cwd, target, os);
      if (relative !== null) {
        return { path: relative, relative: true };
      }
    }
  }
  return { path: target, relative: false };
}

/* --------------------------------------------------------------------- quoting */

/** Characters a token may hold and still go bare, per dialect. */
const POSIX_BARE = /^[A-Za-z0-9_./:@%+=,-]+$/;
const POWERSHELL_BARE = /^[A-Za-z0-9_.:\\/-]+$/;
const CMD_BARE = /^[A-Za-z0-9_.:\\/~=+,-]+$/;

export function quotePosix(arg: string): string {
  if (arg !== '' && POSIX_BARE.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

export function quotePowerShell(arg: string): string {
  if (arg !== '' && POWERSHELL_BARE.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", "''")}'`;
}

/** cmd has no escape for `"` inside a quoted token — and no Windows path can contain one. */
export function quoteCmd(arg: string): string {
  if (arg !== '' && CMD_BARE.test(arg)) {
    return arg;
  }
  return `"${arg}"`;
}

/** Quote one word — a program argument — for a shell. */
export function quoteArg(kind: ShellKind, arg: string): string {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return quotePowerShell(arg);
    case 'cmd':
      return quoteCmd(arg);
    default:
      return quotePosix(arg);
  }
}

/** True for the shells that read `\` as the path separator. */
function windowsStyle(kind: ShellKind): boolean {
  return kind === 'pwsh' || kind === 'powershell' || kind === 'cmd';
}

/** A path spelled with the separator that shell's users write. */
export function shellPath(kind: ShellKind, path: string): string {
  return windowsStyle(kind) ? path.replaceAll('/', '\\') : path.replaceAll('\\', '/');
}

/* -------------------------------------------------------------------- commands */

/** `cd` into a folder — the form a user of that shell should learn. */
export function cdCommand(kind: ShellKind, path: string): string {
  const target = shellPath(kind, path);
  switch (kind) {
    case 'pwsh':
    case 'powershell': {
      // A bare word starting with `-` would parse as a parameter name, and
      // Set-Location's -Path treats `[`, `]`, `*` and `?` as wildcards.
      const quoted = target.startsWith('-') ? `'${target}'` : quotePowerShell(target);
      return /[[\]*?]/.test(target) ? `cd -LiteralPath ${quoted}` : `cd ${quoted}`;
    }
    case 'cmd':
      return `cd /d ${quoteCmd(target)}`;
    default:
      return target.startsWith('-') ? `cd -- ${quotePosix(target)}` : `cd ${quotePosix(target)}`;
  }
}

/** The directory listing a user of that shell would type. */
export function listCommand(kind: ShellKind): string {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return 'ls';
    case 'cmd':
      return 'dir';
    default:
      return 'ls -l';
  }
}

/**
 * A program with its arguments as one typed line. PowerShell needs the call
 * operator for a quoted program (`& 'C:\Tools\my agent.exe' --fast`); the
 * others just quote the token.
 */
export function quoteCommand(kind: ShellKind, program: string, args: readonly string[]): string {
  const words = args.map((arg) => quoteArg(kind, arg));
  let head: string;
  if (kind === 'pwsh' || kind === 'powershell') {
    const quoted = quotePowerShell(program);
    head = quoted === program ? program : `& ${quoted}`;
  } else {
    head = quoteArg(kind, program);
  }
  return [head, ...words].join(' ');
}
