/**
 * Renders a tab's split layout.
 *
 * The tree is data (`src/core/panes.ts`); `layoutPanes` flattens it into
 * rectangles and this places them absolutely, one element per pane keyed by
 * pane id. That flatness is the point: nesting the DOM the way the tree nests
 * would move a pane's element deeper on every split, React would reconcile it
 * as a new element, and the pty inside would be killed and respawned. Keyed
 * siblings cannot do that.
 *
 * Leaves are rendered by the caller, so this component knows nothing about
 * terminals — only about where they go.
 */

import { useRef, type ReactNode } from 'react';
import { layoutPanes, ratioFromDrag, splitRect, type PaneNode } from '../../core/panes';

export interface PaneTreeProps {
  node: PaneNode;
  renderPane: (paneId: string) => ReactNode;
  /** A divider drag: the split's new ratio for its first child. */
  onRatio: (splitId: string, ratio: number) => void;
}

const percent = (fraction: number): string => `${(fraction * 100).toFixed(4)}%`;

export function PaneTree({ node, renderPane, onRatio }: PaneTreeProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const { panes, dividers } = layoutPanes(node);

  function startDrag(event: React.PointerEvent, splitId: string): void {
    if (event.button !== 0) return;
    const area = areaRef.current;
    const rect = splitRect(node, splitId);
    const divider = dividers.find((candidate) => candidate.splitId === splitId);
    if (!area || !rect || !divider) return;
    event.preventDefault();

    const move = (moveEvent: PointerEvent) => {
      const bounds = area.getBoundingClientRect();
      const size = divider.direction === 'row' ? bounds.width : bounds.height;
      if (size <= 0) return;
      const offset =
        divider.direction === 'row'
          ? moveEvent.clientX - bounds.left
          : moveEvent.clientY - bounds.top;
      onRatio(splitId, ratioFromDrag(rect, divider.direction, offset / size));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    // Listeners on the window, not the divider: the pointer routinely leaves a
    // few-pixel target mid-drag, and losing the drag there would feel broken.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  return (
    // `data-split` lets the focused pane be outlined only when there is another
    // pane to distinguish it from.
    <div className="pane-area" data-split={panes.length > 1} ref={areaRef}>
      {panes.map(({ id, rect }) => (
        <div
          key={id}
          className="pane-slot"
          style={{
            left: percent(rect.left),
            top: percent(rect.top),
            width: percent(rect.width),
            height: percent(rect.height),
          }}
        >
          {renderPane(id)}
        </div>
      ))}
      {dividers.map(({ splitId, direction, rect }) => (
        <div
          key={splitId}
          className="pane-divider"
          data-direction={direction}
          role="separator"
          aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
          style={
            direction === 'row'
              ? { left: percent(rect.left), top: percent(rect.top), height: percent(rect.height) }
              : { left: percent(rect.left), top: percent(rect.top), width: percent(rect.width) }
          }
          onPointerDown={(event) => startDrag(event, splitId)}
          // A double-click on a divider means "make it even again" everywhere.
          onDoubleClick={() => onRatio(splitId, 0.5)}
        />
      ))}
    </div>
  );
}
