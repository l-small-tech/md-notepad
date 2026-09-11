import { describe, expect, test } from 'vitest';

import { diffLines } from '../../diff';
import { changeMap, changeRanges, deletionGaps } from '../changes';
import type { ChangeMap } from '../changes';
import type { CodeModel } from '../model';
import { parseCode } from '../parse';

/* ---- fixtures: two versions of one small file per language --------------- */

const TS_BASE = `/** Trims text. */
export function keepMe(text: string): string {
  return text.trim();
}

export function bodyChanged(n: number): number {
  const doubled = n * 2;
  return doubled;
}

export function paramAdded(dir: string): boolean {
  return dir.length > 0;
}

export function paramRemoved(a: string, b: string): string {
  return a + b;
}

export function returnChanged(n: number): number {
  return n;
}

export function goneSoon(): void {
  return;
}
`;

const TS_CURRENT = `/** Trims text. */
export function keepMe(text: string): string {
  return text.trim();
}

export function bodyChanged(n: number): number {
  const tripled = n * 3;
  return tripled + 1;
}

export function paramAdded(dir: string, hiddenDirs: string[]): boolean {
  return dir.length > 0 && hiddenDirs.length === 0;
}

export function paramRemoved(a: string): string {
  return a;
}

export function returnChanged(n: number): boolean {
  return n > 0;
}

export function newcomer(id: string): string {
  return id;
}
`;

const RUST_BASE = `pub struct Thing {
    pub name: String,
}

impl Thing {
    /// Makes one.
    pub fn new(name: String) -> Thing {
        Thing { name }
    }

    pub fn wanders(&self) -> usize {
        self.name.len()
    }
}

impl Other {
    pub fn stays(&self) -> bool {
        true
    }
}
`;

const RUST_CURRENT = `pub struct Thing {
    pub name: String,
}

impl Thing {
    /// Makes one.
    pub fn new(name: String) -> Thing {
        Thing { name }
    }
}

impl Other {
    pub fn wanders(&self) -> usize {
        self.name.len()
    }

    pub fn stays(&self) -> bool {
        true
    }
}
`;

function parsed(text: string, path: string): CodeModel {
  const model = parseCode(text, path);
  if (!model) {
    throw new Error(`no model for ${path}`);
  }
  return model;
}

function mapFor(baseText: string | null, currentText: string, path: string): ChangeMap {
  const current = parsed(currentText, path);
  const base = baseText === null ? null : parsed(baseText, path);
  return changeMap(base, current, diffLines(baseText ?? '', currentText));
}

/** The change info of a unit, found by name anywhere in the model. */
function statusOf(model: CodeModel, map: ChangeMap, name: string) {
  const find = (
    units: readonly CodeModel['units'][number][],
  ): CodeModel['units'][number] | null => {
    for (const u of units) {
      if (u.name === name) {
        return u;
      }
      const child = find(u.children);
      if (child) {
        return child;
      }
    }
    return null;
  };
  const unit = find(model.units);
  if (!unit) {
    throw new Error(`no unit ${name}`);
  }
  const info = map.units.get(unit.id);
  if (!info) {
    throw new Error(`no change info for ${name}`);
  }
  return info;
}

/* ---- line ranges --------------------------------------------------------- */

describe('changeRanges / deletionGaps', () => {
  test('reports inserted and replaced lines as 1-based inclusive current ranges', () => {
    expect(changeRanges(diffLines('a\nb\nc\n', 'a\nB\nc\n'))).toEqual([[2, 2]]);
    expect(changeRanges(diffLines('a\nc\n', 'a\nx\ny\nc\n'))).toEqual([[2, 3]]);
    expect(changeRanges(diffLines('a\nb\n', 'a\nb\n'))).toEqual([]);
  });

  test('a pure deletion is a gap, and only a unit spanning it is touched', () => {
    // "a b c d" → "a d": lines b and c go, leaving the gap after current line 1.
    const ops = diffLines('a\nb\nc\nd\n', 'a\nd\n');
    expect(changeRanges(ops)).toEqual([]);
    expect(deletionGaps(ops)).toEqual([1]);
  });

  test('a replacement reports no gap', () => {
    expect(deletionGaps(diffLines('a\nb\nc\n', 'a\nB\nc\n'))).toEqual([]);
  });
});

/* ---- TypeScript ---------------------------------------------------------- */

describe('changeMap — TypeScript', () => {
  const current = parsed(TS_CURRENT, 'sample.ts');
  const map = mapFor(TS_BASE, TS_CURRENT, 'sample.ts');

  test('an untouched unit is same', () => {
    expect(statusOf(current, map, 'keepMe')).toEqual({ status: 'same' });
  });

  test('a body-only edit is changed, with no signature note', () => {
    expect(statusOf(current, map, 'bodyChanged')).toEqual({ status: 'changed' });
  });

  test('a new parameter is signature-changed and says which', () => {
    expect(statusOf(current, map, 'paramAdded')).toEqual({
      status: 'signature-changed',
      signatureNote: 'now also takes hiddenDirs',
    });
  });

  test('a dropped parameter is signature-changed and says which', () => {
    expect(statusOf(current, map, 'paramRemoved')).toEqual({
      status: 'signature-changed',
      signatureNote: 'no longer takes b',
    });
  });

  test('a new return type is phrased in plain English', () => {
    expect(statusOf(current, map, 'returnChanged')).toEqual({
      status: 'signature-changed',
      signatureNote: 'now gives back yes or no',
    });
  });

  test('a unit the baseline did not have is added', () => {
    expect(statusOf(current, map, 'newcomer')).toEqual({ status: 'added' });
  });

  test('a unit the baseline had and the file does not is removed, with its body kept', () => {
    expect(map.removed.map((u) => u.name)).toEqual(['goneSoon']);
    expect(map.removed[0]!.signature).toContain('goneSoon');
    expect(map.removed[0]!.kind).toBe('function');
  });

  test('changedCount counts every badged unit plus the ghosts', () => {
    // bodyChanged, paramAdded, paramRemoved, returnChanged, newcomer + goneSoon.
    expect(map.changedCount).toBe(6);
    expect(map.units.size).toBe(current.units.length);
  });
});

/* ---- Rust --------------------------------------------------------------- */

describe('changeMap — Rust', () => {
  const current = parsed(RUST_CURRENT, 'sample.rs');
  const map = mapFor(RUST_BASE, RUST_CURRENT, 'sample.rs');

  test('a method that moved impl blocks is changed, not added and removed', () => {
    expect(statusOf(current, map, 'wanders').status).toBe('changed');
    expect(map.removed.map((u) => u.name)).toEqual([]);
  });

  test('nested children carry their own statuses', () => {
    expect(statusOf(current, map, 'new')).toEqual({ status: 'same' });
    expect(statusOf(current, map, 'stays')).toEqual({ status: 'same' });
    expect(statusOf(current, map, 'Thing')).toEqual({ status: 'same' });
  });

  test('the impl blocks the method left and joined are changed', () => {
    const impls = current.units.filter((u) => u.kind === 'impl');
    expect(impls).toHaveLength(2);
    for (const impl of impls) {
      expect(map.units.get(impl.id)?.status, impl.qualifiedName).toBe('changed');
    }
  });
});

/* ---- no baseline -------------------------------------------------------- */

describe('changeMap — no baseline', () => {
  test('a file git has never seen has every unit added, nothing removed', () => {
    const current = parsed(TS_CURRENT, 'sample.ts');
    const map = changeMap(null, current, diffLines('', TS_CURRENT));
    const statuses = [...map.units.values()].map((i) => i.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(new Set(statuses)).toEqual(new Set(['added']));
    expect(map.removed).toEqual([]);
    expect(map.changedCount).toBe(map.units.size);
  });

  test('an identical file badges nothing', () => {
    const map = mapFor(TS_BASE, TS_BASE, 'sample.ts');
    expect(map.changedCount).toBe(0);
    expect([...map.units.values()].every((i) => i.status === 'same')).toBe(true);
  });
});
