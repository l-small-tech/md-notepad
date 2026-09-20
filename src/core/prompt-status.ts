/**
 * Prompt status — notes as prompts, with the agent reporting back through a
 * file (pure; tested).
 *
 * The app never runs an agent. The user copies a note — or one heading
 * section of it — into whatever harness they run in their own terminal, and
 * the workspace's AGENTS.md (the `prompt-status` module, see
 * `workspace-modules.ts`) tells that agent to record its progress in
 * `STATUSES.md` at the workspace root. This module is both ends of that file:
 *
 * - `parseStatuses` / `serializeStatuses` / `upsertStatus` — the markdown
 *   table. One row per PROMPT, keyed `path/to/note.md#heading-slug` (or the
 *   bare path for a whole note), relative to the workspace root with forward
 *   slashes. The parser is generous (an agent may have hand-edited the file);
 *   the serializer is what the bundled `.notepad/status.py` also writes.
 * - `promptSections` — a note's headings as prompt units: slug, line range
 *   and the row key, for the status strip and "Copy as prompt".
 * - `promptText` — what "Copy as prompt" puts on the clipboard: the section
 *   plus a trailing `Prompt-id:` line, so the agent need not search for the
 *   note it was handed.
 *
 * Slugs follow the GitHub anchor rule (lowercase, punctuation dropped, spaces
 * to hyphens, `-1`/`-2` for repeats). `status.py` implements the same rule;
 * `STATUS_SCRIPT` in `workspace-module-texts.ts` is tested against this one.
 */

import { extractOutline } from './outline';

export const STATUS_FILE = 'STATUSES.md';

export const PROMPT_STATUSES = ['queued', 'running', 'needs-input', 'done', 'failed'] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

export interface StatusRow {
  /** `path/to/note.md` or `path/to/note.md#heading-slug`, workspace-relative. */
  key: string;
  status: PromptStatus;
  /** Whatever the writer put there — `YYYY-MM-DD HH:MM` from the script. */
  updated: string;
  summary: string;
}

/** A heading of a note, seen as a unit that can be handed to an agent. */
export interface PromptSection {
  level: number;
  title: string;
  slug: string;
  /** 1-based first line (the heading) and last line (inclusive) of the section. */
  line: number;
  endLine: number;
}

/** Human labels for the chips. */
export const STATUS_LABELS: Record<PromptStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  'needs-input': 'Needs input',
  done: 'Done',
  failed: 'Failed',
};

export function isPromptStatus(value: string): value is PromptStatus {
  return (PROMPT_STATUSES as readonly string[]).includes(value);
}

/** GitHub-style anchor slug of one heading (no de-duplication). */
export function headingSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .replace(/\s+/g, '-');
}

export function promptKey(notePath: string, slug?: string | null): string {
  const path = notePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return slug ? `${path}#${slug}` : path;
}

export function splitPromptKey(key: string): { note: string; slug: string | null } {
  const hash = key.indexOf('#');
  return hash < 0
    ? { note: key, slug: null }
    : { note: key.slice(0, hash), slug: key.slice(hash + 1) || null };
}

/** The headings of a note as prompt sections; a section runs to the next
 *  heading of the same or a higher level. */
export function promptSections(markdown: string): PromptSection[] {
  const headings = extractOutline(markdown);
  const lineCount = markdown.split('\n').length;
  const seen = new Map<string, number>();
  return headings.map((h, i) => {
    const base = headingSlug(h.text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const next = headings.slice(i + 1).find((o) => o.level <= h.level);
    return {
      level: h.level,
      title: h.text,
      slug: n === 0 ? base : `${base}-${n}`,
      line: h.line,
      endLine: next ? next.line - 1 : lineCount,
    };
  });
}

/** The innermost section containing a 1-based line, or null above the first heading. */
export function sectionAtLine(sections: PromptSection[], line: number): PromptSection | null {
  let found: PromptSection | null = null;
  for (const s of sections) {
    if (s.line <= line && line <= s.endLine) {
      found = s;
    }
  }
  return found;
}

/**
 * The clipboard text for a prompt: the section (or, with `section` null, the
 * whole note minus YAML frontmatter) and the `Prompt-id:` line.
 */
export function promptText(
  markdown: string,
  notePath: string,
  section: PromptSection | null,
): string {
  const lines = markdown.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  let body: string[];
  if (section) {
    body = lines.slice(section.line - 1, section.endLine);
  } else {
    body = lines;
    if (lines[0] === '---') {
      const close = lines.findIndex((l, n) => n > 0 && /^(-{3,}|\.{3})[ \t]*$/.test(l));
      if (close > 0) {
        body = lines.slice(close + 1);
      }
    }
  }
  const text = body.join('\n').trim();
  return `${text}\n\nPrompt-id: ${promptKey(notePath, section?.slug)}\n`;
}

const escapeCell = (s: string) => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

/** Split one table line into unescaped cells (`\|` is a literal pipe). */
function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) {
    return null;
  }
  const cells: string[] = [];
  let cell = '';
  for (let i = 1; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cell += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.trim() !== '') {
    cells.push(cell.trim());
  }
  return cells;
}

/**
 * Rows of a STATUSES.md. Header and separator lines, rows with an unknown
 * status and anything outside the table are skipped; a repeated key keeps its
 * LAST row (an agent that appended instead of replacing still reads right).
 */
export function parseStatuses(text: string): StatusRow[] {
  const rows = new Map<string, StatusRow>();
  for (const line of text.split('\n')) {
    const cells = splitRow(line);
    if (!cells || cells.length < 2) {
      continue;
    }
    const key = (cells[0] ?? '').replace(/^`|`$/g, '');
    const status = (cells[1] ?? '').toLowerCase();
    if (!key || !isPromptStatus(status)) {
      continue;
    }
    rows.delete(key);
    rows.set(key, { key, status, updated: cells[2] ?? '', summary: cells[3] ?? '' });
  }
  return [...rows.values()];
}

export function serializeStatuses(rows: StatusRow[]): string {
  const out = [
    '# Statuses',
    '',
    'Prompt progress, written by agents (`python .notepad/status.py`). One row per prompt.',
    '',
    '| Prompt | Status | Updated | Summary |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    out.push(
      `| ${escapeCell(r.key)} | ${r.status} | ${escapeCell(r.updated)} | ${escapeCell(r.summary)} |`,
    );
  }
  return `${out.join('\n')}\n`;
}

/** Replace the row with this key in place, or append it. */
export function upsertStatus(rows: StatusRow[], row: StatusRow): StatusRow[] {
  const at = rows.findIndex((r) => r.key === row.key);
  return at < 0 ? [...rows, row] : rows.map((r, i) => (i === at ? row : r));
}

/** `YYYY-MM-DD HH:MM`, local — the stamp both the app and the script write. */
export function statusStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** The rows that belong to one note: slug → row, `''` for the whole-note row. */
export function statusesForNote(rows: StatusRow[], notePath: string): Map<string, StatusRow> {
  const want = promptKey(notePath).toLowerCase();
  const out = new Map<string, StatusRow>();
  for (const r of rows) {
    const { note, slug } = splitPromptKey(r.key);
    if (promptKey(note).toLowerCase() === want) {
      out.set(slug ?? '', r);
    }
  }
  return out;
}

/** Rows grouped for the status panel, in lifecycle order of attention. */
export const PANEL_ORDER: readonly PromptStatus[] = [
  'needs-input',
  'running',
  'failed',
  'queued',
  'done',
];

export function groupByStatus(rows: StatusRow[]): { status: PromptStatus; rows: StatusRow[] }[] {
  return PANEL_ORDER.map((status) => ({
    status,
    rows: rows.filter((r) => r.status === status),
  })).filter((g) => g.rows.length > 0);
}
