/**
 * The layers panel — a floating list over the board, built with plain DOM.
 *
 * Split out of `whiteboard.ts` purely for size: this file is all markup and
 * event wiring, and every decision it can make is already a pure function in
 * `core/whiteboard/layers.ts`. It owns no state — it re-renders from the scene
 * it is handed and reports intent back through callbacks.
 *
 * The list is shown TOPMOST FIRST (the reverse of `doc.layers`, which is
 * z-order), because that is how every drawing app presents a stack and how the
 * board actually looks.
 */

import { isEditable } from '../core/whiteboard/layers';
import type { Layer, SceneDoc } from '../core/whiteboard/scene';

export interface LayersPanelCallbacks {
  onSelect(id: string): void;
  onToggleVisible(id: string, visible: boolean): void;
  onToggleLocked(id: string, locked: boolean): void;
  onRename(id: string, name: string): void;
  onMove(id: string, delta: number): void;
  onAdd(): void;
  onDelete(id: string): void;
  onClose(): void;
}

export interface LayersPanel {
  readonly element: HTMLElement;
  render(doc: SceneDoc, activeLayerId: string | null): void;
}

function iconButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'wb-layer-btn';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', (event) => {
    // Don't let a control click also select the row underneath it.
    event.stopPropagation();
    onClick();
  });
  return button;
}

export function createLayersPanel(callbacks: LayersPanelCallbacks): LayersPanel {
  const element = document.createElement('div');
  element.className = 'wb-layers';

  const header = document.createElement('div');
  header.className = 'wb-layers-header';
  const heading = document.createElement('span');
  heading.textContent = 'Layers';
  header.append(
    heading,
    iconButton('✚', 'Add a layer', () => callbacks.onAdd()),
    iconButton('✕', 'Close the layers panel', () => callbacks.onClose()),
  );

  const list = document.createElement('div');
  list.className = 'wb-layers-list';
  element.append(header, list);

  function row(layer: Layer, index: number, count: number, active: boolean): HTMLElement {
    const item = document.createElement('div');
    item.className = 'wb-layer';
    item.dataset.active = active ? 'true' : 'false';
    item.dataset.dimmed = isEditable(layer) ? 'false' : 'true';
    item.addEventListener('click', () => callbacks.onSelect(layer.id));

    item.append(
      iconButton(
        layer.visible ? '👁' : '⃠',
        layer.visible ? 'Hide this layer' : 'Show this layer',
        () => callbacks.onToggleVisible(layer.id, !layer.visible),
      ),
      iconButton(
        layer.locked ? '🔒' : '🔓',
        layer.locked ? 'Unlock this layer' : 'Lock this layer',
        () => callbacks.onToggleLocked(layer.id, !layer.locked),
      ),
    );

    // Double-click to rename in place; a foreign ("Imported") layer keeps its
    // name, since it isn't ours to label.
    const name = document.createElement('span');
    name.className = 'wb-layer-name';
    name.textContent = layer.name;
    name.title = layer.kind === 'foreign' ? 'Imported content (locked)' : 'Double-click to rename';
    if (layer.kind !== 'foreign') {
      name.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        const input = document.createElement('input');
        input.className = 'wb-layer-rename';
        input.value = layer.name;
        const commit = (): void => {
          const value = input.value;
          input.replaceWith(name);
          callbacks.onRename(layer.id, value);
        };
        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (key) => {
          if (key.key === 'Enter') {
            commit();
          } else if (key.key === 'Escape') {
            input.replaceWith(name);
          }
          key.stopPropagation();
        });
        name.replaceWith(input);
        input.focus();
        input.select();
      });
    }
    item.append(name);

    // `index` is the position in the reversed (topmost-first) list, so "up" in
    // the panel is +1 in z-order.
    const up = iconButton('▲', 'Move up', () => callbacks.onMove(layer.id, 1));
    up.disabled = index === 0;
    const down = iconButton('▼', 'Move down', () => callbacks.onMove(layer.id, -1));
    down.disabled = index === count - 1;
    item.append(
      up,
      down,
      iconButton('🗑', 'Delete this layer', () => callbacks.onDelete(layer.id)),
    );
    return item;
  }

  return {
    element,
    render(doc, activeLayerId) {
      const ordered = [...doc.layers].reverse();
      list.replaceChildren(
        ...ordered.map((layer, index) =>
          row(layer, index, ordered.length, layer.id === activeLayerId),
        ),
      );
    },
  };
}
