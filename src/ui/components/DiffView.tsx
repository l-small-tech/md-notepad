/**
 * DiffView — read-only side-by-side diff of two texts (VS Code-style: old on
 * the left, new on the right, modified lines paired with intra-line
 * highlights). All comparison logic lives in core/diff.ts; this component
 * only renders rows.
 *
 * Reusable by design: it takes plain texts + labels, so the future git
 * integration can render `HEAD ↔ working tree` with the same component the
 * conflict banner uses for `on disk ↔ in editor`.
 */

import { useMemo } from 'react';
import { buildDiffRows, diffLines, diffStats, type DiffRow } from '../../core/diff';

function DiffColumn({ rows, side }: { rows: DiffRow[]; side: 'left' | 'right' }) {
  return (
    <div className="diff-col">
      {rows.map((row, i) => {
        const cell = side === 'left' ? row.left : row.right;
        if (!cell) {
          return (
            <div key={i} className="diff-line diff-line-filler">
              <span className="diff-gutter" />
              <span className="diff-text" />
            </div>
          );
        }
        const changedClass = cell.changed
          ? side === 'left'
            ? ' diff-line-del'
            : ' diff-line-ins'
          : '';
        return (
          <div key={i} className={`diff-line${changedClass}`}>
            <span className="diff-gutter">{cell.num}</span>
            <span className="diff-text">
              {cell.hi ? (
                <>
                  {cell.text.slice(0, cell.hi[0])}
                  <span className="diff-hi">{cell.text.slice(cell.hi[0], cell.hi[1])}</span>
                  {cell.text.slice(cell.hi[1])}
                </>
              ) : (
                cell.text
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function DiffView({
  oldText,
  newText,
  oldLabel,
  newLabel,
}: {
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
}) {
  const { rows, stats } = useMemo(() => {
    const ops = diffLines(oldText, newText);
    return { rows: buildDiffRows(ops), stats: diffStats(ops) };
  }, [oldText, newText]);

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className="diff-header-label">{oldLabel}</span>
        <span className="diff-header-label">
          {newLabel}
          <span className="diff-stats">
            <span className="diff-stat-ins">+{stats.added}</span>{' '}
            <span className="diff-stat-del">−{stats.removed}</span>
          </span>
        </span>
      </div>
      <div className="diff-body">
        <DiffColumn rows={rows} side="left" />
        <div className="diff-col-divider" />
        <DiffColumn rows={rows} side="right" />
      </div>
    </div>
  );
}
