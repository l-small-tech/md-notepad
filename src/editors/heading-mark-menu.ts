/**
 * The heading right-click menu both text editors share (Raw/Split's CM6 and
 * Edit mode's Milkdown): Mark running / Mark complete / Clear mark, with the
 * current choice ticked. Decides nothing — the caller reads the heading's
 * mark (`core/heading-mark.ts`) and applies the one picked.
 */

import { HEADING_MARKS, HEADING_MARK_LABELS, type HeadingMark } from '../core/heading-mark';
import { openContextMenu, type ContextMenuItem } from './whiteboard-menu';

export function openHeadingMarkMenu(
  current: HeadingMark | null,
  x: number,
  y: number,
  apply: (mark: HeadingMark | null) => void,
): void {
  const items: ContextMenuItem[] = [
    ...HEADING_MARKS.map((mark) => ({
      label: `Mark ${HEADING_MARK_LABELS[mark].toLowerCase()}`,
      checked: current === mark,
      onSelect: () => apply(mark),
    })),
    'separator',
    { label: 'Clear mark', disabled: current === null, onSelect: () => apply(null) },
  ];
  openContextMenu(items, x, y, undefined, 'Heading');
}

/** The class list a marked heading carries in either editor. */
export function headingMarkClass(mark: HeadingMark): string {
  return `heading-mark heading-mark-${mark}`;
}
