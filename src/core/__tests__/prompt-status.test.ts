import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  groupByStatus,
  headingSlug,
  parseStatuses,
  promptSections,
  promptText,
  sectionAtLine,
  serializeStatuses,
  statusStamp,
  statusesForNote,
  upsertStatus,
  type StatusRow,
} from '../prompt-status';
import { STATUS_SCRIPT } from '../workspace-module-texts';

const NOTE = [
  '---',
  'tags: x',
  '---',
  '# Plan',
  'intro',
  '## Feature: Init Workspace!',
  'body a',
  '### Detail',
  'deep',
  '```',
  '## not a heading',
  '```',
  '## Feature: Init Workspace!',
  'body b',
].join('\n');

describe('slugs and sections', () => {
  it('slugs like a GitHub anchor', () => {
    expect(headingSlug('Feature: Init Workspace!')).toBe('feature-init-workspace');
    expect(headingSlug('  Été 2026 — plan_b ')).toBe('été-2026-plan_b');
  });

  it('sections run to the next heading of the same or higher level; repeats get a suffix', () => {
    const s = promptSections(NOTE);
    expect(s.map((x) => [x.slug, x.line, x.endLine])).toEqual([
      ['plan', 4, 14],
      ['feature-init-workspace', 6, 12],
      ['detail', 8, 12],
      ['feature-init-workspace-1', 13, 14],
    ]);
  });

  it('finds the innermost section at a line', () => {
    const s = promptSections(NOTE);
    expect(sectionAtLine(s, 9)?.slug).toBe('detail');
    expect(sectionAtLine(s, 7)?.slug).toBe('feature-init-workspace');
    expect(sectionAtLine(s, 2)).toBeNull();
  });

  it('copies a section, or the whole note without frontmatter, with its id', () => {
    const s = promptSections(NOTE);
    expect(promptText(NOTE, 'prompts\\plan.md', s[3]!)).toBe(
      '## Feature: Init Workspace!\nbody b\n\nPrompt-id: prompts/plan.md#feature-init-workspace-1\n',
    );
    const whole = promptText(NOTE, 'prompts/plan.md', null);
    expect(whole.startsWith('# Plan\n')).toBe(true);
    expect(whole.endsWith('\n\nPrompt-id: prompts/plan.md\n')).toBe(true);
  });
});

describe('STATUSES.md', () => {
  const rows: StatusRow[] = [
    { key: 'a.md#x', status: 'running', updated: '2026-09-20 14:02', summary: 'a | b' },
    { key: 'dir/b.md', status: 'done', updated: '2026-09-20 15:00', summary: '' },
  ];

  it('round-trips, escaping pipes', () => {
    expect(parseStatuses(serializeStatuses(rows))).toEqual(rows);
  });

  it('is generous: skips junk, keeps the last of a repeated key, tolerates CRLF and backticks', () => {
    const text =
      '| Prompt | Status |\r\n|---|---|\r\n| `a.md` | queued | t1 | s |\r\n| a.md | bogus |\r\n| a.md | DONE | t2 |\r\ntext';
    expect(parseStatuses(text)).toEqual([
      { key: 'a.md', status: 'done', updated: 't2', summary: '' },
    ]);
  });

  it('upserts in place', () => {
    const next = upsertStatus(rows, { ...rows[0]!, status: 'done' });
    expect(next.map((r) => r.status)).toEqual(['done', 'done']);
    expect(upsertStatus(rows, { ...rows[0]!, key: 'c.md' })).toHaveLength(3);
  });

  it('picks the rows of one note, whatever the slashes or case', () => {
    const m = statusesForNote(rows, 'A.md');
    expect([...m.keys()]).toEqual(['x']);
    expect(statusesForNote(rows, 'dir\\b.md').get('')?.status).toBe('done');
  });

  it('groups for the panel with what needs attention first', () => {
    const g = groupByStatus([...rows, { ...rows[0]!, key: 'q.md', status: 'needs-input' }]);
    expect(g.map((x) => x.status)).toEqual(['needs-input', 'running', 'done']);
  });

  it('stamps local minutes', () => {
    expect(statusStamp(new Date(2026, 8, 5, 7, 3))).toBe('2026-09-05 07:03');
  });
});

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

describe.skipIf(!python)('status.py speaks the same protocol', () => {
  it('sets, replaces and finds', () => {
    const root = mkdtempSync(join(tmpdir(), 'notepad-status-'));
    try {
      mkdirSync(join(root, '.notepad'));
      mkdirSync(join(root, 'prompts'));
      writeFileSync(join(root, '.notepad', 'status.py'), STATUS_SCRIPT);
      writeFileSync(join(root, 'prompts', 'plan.prompts.md'), NOTE);
      const run = (...args: string[]) =>
        execFileSync(python!, [join(root, '.notepad', 'status.py'), ...args], { encoding: 'utf8' });

      expect(run('find', 'Feature: Init Workspace!').trim().split(/\r?\n/)).toEqual([
        'prompts/plan.prompts.md#feature-init-workspace',
        'prompts/plan.prompts.md#feature-init-workspace-1',
      ]);

      run('set', 'prompts/plan.md#detail', 'running', 'pipes | too');
      run('set', 'prompts/plan.md', 'queued');
      run('set', 'prompts/plan.md#detail', 'done', 'all', 'good');
      const text = readFileSync(join(root, 'prompts', 'STATUSES.md'), 'utf8');
      const parsed = parseStatuses(text);
      expect(parsed.map((r) => [r.key, r.status, r.summary])).toEqual([
        ['prompts/plan.md#detail', 'done', 'all good'],
        ['prompts/plan.md', 'queued', ''],
      ]);
      // Same bytes as our serializer → either side can rewrite the file.
      expect(serializeStatuses(parsed)).toBe(text);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
