/**
 * "What changed" (review_plan.md §6): the per-unit change badges of Review
 * mode, from three pure inputs — the parsed baseline model, the parsed current
 * model, and the line diff between the two texts (`core/diff.ts`).
 *
 * A line diff alone cannot say "removed" or "signature changed": a deleted
 * function has no lines left to badge, and a changed parameter list looks like
 * any other changed line. Parsing the baseline too gives both. The split of
 * work is:
 *
 *   - the LINE DIFF decides whether a surviving unit was touched at all
 *     ({@link changeRanges} / {@link deletionGaps} intersected with the unit's
 *     span in the CURRENT text);
 *   - the TWO MODELS decide what kind of change it was (a body edit, a
 *     signature edit with a sentence saying how, an addition, a removal).
 *
 * No DOM, no git: the caller (`EditorHost`) fetches the baseline text and the
 * pane draws the badges.
 */

import type { DiffOp } from '../diff';
import type { CodeLanguage, CodeModel, CodeUnit, Param } from './model';
import { describeType, joinList } from './plain-english';

export type UnitChange = 'added' | 'changed' | 'signature-changed' | 'same';

export interface UnitChangeInfo {
  status: UnitChange;
  /**
   * Only on `signature-changed`: how the signature moved, in the same voice as
   * the plain-English sentence — "now also takes hiddenDirs", "no longer takes
   * x", "now gives back yes or no". Several changes join with "; ".
   */
  signatureNote?: string;
}

export interface ChangeMap {
  /** Keyed by {@link CodeUnit.id}, every unit of `current` including children. */
  units: Map<string, UnitChangeInfo>;
  /**
   * Units of the BASELINE model with no counterpart in `current` — the ghost
   * cards at the end of the deck. The whole `CodeUnit` is kept so the pane can
   * draw the ghost from the baseline's own signature and doc. Only the
   * outermost removal is listed: when a class goes, its methods ride along in
   * that unit's `children` rather than appearing here as well.
   */
  removed: CodeUnit[];
  /** Units badged anything but `same`, plus the ghosts — what the Changes chip counts. */
  changedCount: number;
}

/**
 * The 1-based inclusive line ranges of the CURRENT text that the diff inserted
 * or replaced, merged and in order. `core/diff.ts` reports ops, not ranges, and
 * nothing else needed this shape yet.
 *
 * Pure deletions produce no range (they own no current line) — see
 * {@link deletionGaps}.
 */
export function changeRanges(diff: readonly DiffOp[]): [number, number][] {
  const out: [number, number][] = [];
  for (const op of diff) {
    if (op.type !== 'insert') {
      continue;
    }
    const start = op.newStart + 1;
    const end = op.newStart + op.lines.length;
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end);
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/**
 * Where the diff deleted lines without putting any back, as the 0-based count
 * of current lines before the gap: `k` means the deletion sits between current
 * line `k` and line `k + 1`. A unit is touched by such a gap only when it
 * SPANS it (`lines[0] <= k && lines[1] >= k + 1`), so lines dropped between two
 * declarations badge neither of them.
 */
export function deletionGaps(diff: readonly DiffOp[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < diff.length; i += 1) {
    const op = diff[i]!;
    if (op.type !== 'delete' || diff[i + 1]?.type === 'insert') {
      // A delete followed by an insert is a replacement: its current lines are
      // already a changeRange.
      continue;
    }
    if (!out.includes(op.newStart)) {
      out.push(op.newStart);
    }
  }
  return out;
}

/**
 * Badge every unit of `current` against `base`, and collect the units `base`
 * had and `current` does not.
 *
 * `base === null` means there is no baseline at all (a new file, or git
 * returned nothing) — every unit is `added`.
 *
 * Matching is by {@link CodeUnit.id} (kind + qualified name), falling back to
 * kind + plain name so a method that moved between `impl` blocks is one
 * `changed` unit rather than an addition and a removal.
 */
export function changeMap(
  base: CodeModel | null,
  current: CodeModel,
  diff: readonly DiffOp[],
): ChangeMap {
  const units = new Map<string, UnitChangeInfo>();
  if (base === null) {
    for (const { unit } of flatten(current.units)) {
      units.set(unit.id, { status: 'added' });
    }
    return { units, removed: [], changedCount: units.size };
  }

  const baseUnits = flatten(base.units);
  const byId = new Map<string, CodeUnit>();
  const byName = new Map<string, CodeUnit>();
  for (const { unit } of baseUnits) {
    if (!byId.has(unit.id)) {
      byId.set(unit.id, unit);
    }
    const key = `${unit.kind}:${unit.name}`;
    if (!byName.has(key)) {
      byName.set(key, unit);
    }
  }

  const ranges = changeRanges(diff);
  const gaps = deletionGaps(diff);
  const claimed = new Set<CodeUnit>();

  for (const { unit } of flatten(current.units)) {
    const match = byId.get(unit.id) ?? byName.get(`${unit.kind}:${unit.name}`) ?? null;
    if (match === null || claimed.has(match)) {
      units.set(unit.id, { status: 'added' });
      continue;
    }
    claimed.add(match);
    const note = signatureNote(match, unit, current.language);
    const moved = match.qualifiedName !== unit.qualifiedName;
    const touched = moved || note !== null || spanTouched(unit.lines, ranges, gaps);
    if (!touched) {
      units.set(unit.id, { status: 'same' });
    } else if (note !== null) {
      units.set(unit.id, { status: 'signature-changed', signatureNote: note });
    } else {
      units.set(unit.id, { status: 'changed' });
    }
  }

  const removed: CodeUnit[] = [];
  for (const { unit, parent } of baseUnits) {
    if (claimed.has(unit)) {
      continue;
    }
    // A method of an already-removed class is drawn inside its ghost card.
    if (parent !== null && !claimed.has(parent)) {
      continue;
    }
    removed.push(unit);
  }

  let changedCount = removed.length;
  for (const info of units.values()) {
    if (info.status !== 'same') {
      changedCount += 1;
    }
  }
  return { units, removed, changedCount };
}

/* ---- pieces ------------------------------------------------------------- */

/** Every unit with its parent, parents before children, in source order. */
function flatten(
  roots: readonly CodeUnit[],
  parent: CodeUnit | null = null,
): Array<{ unit: CodeUnit; parent: CodeUnit | null }> {
  const out: Array<{ unit: CodeUnit; parent: CodeUnit | null }> = [];
  for (const unit of roots) {
    out.push({ unit, parent });
    out.push(...flatten(unit.children, unit));
  }
  return out;
}

function spanTouched(
  lines: readonly [number, number],
  ranges: readonly [number, number][],
  gaps: readonly number[],
): boolean {
  const [start, end] = lines;
  for (const [a, b] of ranges) {
    if (start <= b && end >= a) {
      return true;
    }
  }
  for (const k of gaps) {
    if (start <= k && end >= k + 1) {
      return true;
    }
  }
  return false;
}

/** Parameter names as the caller sees them; `self` is not a parameter. */
function paramNames(params: readonly Param[]): string[] {
  return params.filter((p) => p.name !== 'self').map((p) => p.name);
}

/**
 * How `unit`'s signature moved from `was`, or null when it did not: the
 * parameter NAME lists and the return type text are compared (a changed
 * parameter TYPE is an ordinary body change — the line diff catches it).
 */
function signatureNote(was: CodeUnit, unit: CodeUnit, lang: CodeLanguage): string | null {
  const before = paramNames(was.params);
  const after = paramNames(unit.params);
  const added = after.filter((n) => !before.includes(n));
  const dropped = before.filter((n) => !after.includes(n));
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`${before.length === 0 ? 'now takes' : 'now also takes'} ${joinList(added)}`);
  }
  if (dropped.length > 0) {
    parts.push(`no longer takes ${joinList(dropped)}`);
  }
  const wasReturn = collapse(was.returns?.text);
  const nowReturn = collapse(unit.returns?.text);
  if (wasReturn !== nowReturn) {
    parts.push(
      nowReturn === ''
        ? 'no longer gives back anything'
        : `now gives back ${describeType(nowReturn, lang)}`,
    );
  }
  return parts.length === 0 ? null : parts.join('; ');
}

function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}
