/**
 * whiteboard.ts — the Draw-mode editor over a `.svg` file (Phase 1).
 *
 * Loaded ONLY through a dynamic import from the tab's `draw` AdapterFactory
 * (invariant I8), exactly like Milkdown: a markdown-only session never pays for
 * it. This is the only file in the whiteboard stack that touches the DOM —
 * parsing, the scene model and serialization all live in `src/core/whiteboard/`
 * and are covered by Vitest.
 *
 * Phase 1 renders and navigates; it never writes. The document is displayed by
 * handing the ORIGINAL source text to DOMParser and adopting the resulting
 * `<svg>` node, so what you see is exactly what is on disk — pixel-for-pixel
 * the same thing a browser or the markdown preview would show for
 * `![](board.svg)`. `parseWhiteboard` runs alongside it purely as validation
 * (and, from Phase 2, as the edit model); a parse failure is what raises the
 * error card instead of a blank pane.
 *
 * Because nothing is ever pushed back into the DocModel here, opening a
 * whiteboard cannot dirty it — the Phase 2 tools will add a write-back guard to
 * keep that true once edits exist (I2).
 */

import { parseWhiteboard, WhiteboardParseError } from '../core/whiteboard/parse';
import type { SceneDoc } from '../core/whiteboard/scene';
import {
  clampDiagramScale,
  DIAGRAM_ZOOM_STEP,
  fitDiagramView,
  panDiagram,
  zoomDiagramAt,
  type DiagramView,
} from '../core/diagram-zoom';
import type { DocModel } from '../core/doc-model';
import type { EditorAdapter } from '../core/mode-sync';
import '../styles/whiteboard.css';

export interface WhiteboardAdapterOptions {
  /** The error card's escape hatch — the UI switches this tab to raw source. */
  onOpenAsText: () => void;
}

export interface WhiteboardAdapter extends EditorAdapter {
  /** The parsed scene, or null while the document is unreadable. Phase 2+. */
  getScene(): SceneDoc | null;
}

export function createWhiteboardAdapter(options: WhiteboardAdapterOptions): WhiteboardAdapter {
  let root: HTMLDivElement | null = null;
  let stage: HTMLDivElement | null = null;
  let canvas: HTMLDivElement | null = null;
  let zoomLabel: HTMLSpanElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let scene: SceneDoc | null = null;
  let view: DiagramView = { scale: 1, x: 0, y: 0 };
  /** Live pointers on the stage, for the 1-finger-pan / 2-finger-pinch split. */
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  function applyView(): void {
    if (canvas) {
      canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }
    if (zoomLabel) {
      zoomLabel.textContent = `${Math.round(view.scale * 100)}%`;
    }
  }

  function setView(next: DiagramView): void {
    view = next;
    applyView();
  }

  function fit(): void {
    if (!stage || !scene) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    setView(fitDiagramView(scene.width, scene.height, rect.width, rect.height));
  }

  /** Zoom about the stage's centre — what the +/− buttons and keys do. */
  function zoomByStep(factor: number): void {
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    setView(zoomDiagramAt(view, factor, rect.width / 2, rect.height / 2));
  }

  function stagePoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = stage!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function onPointerDown(event: PointerEvent): void {
    if (!stage) {
      return;
    }
    stage.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, stagePoint(event));
    if (pointers.size === 2) {
      pinchDistance = spread();
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const previous = pointers.get(event.pointerId);
    if (!previous) {
      return;
    }
    const current = stagePoint(event);
    pointers.set(event.pointerId, current);

    if (pointers.size === 1) {
      setView(panDiagram(view, current.x - previous.x, current.y - previous.y));
      return;
    }
    if (pointers.size === 2) {
      // Pinch: zoom about the midpoint so the content between the fingers
      // stays put, which is the gesture people expect on a tablet.
      const distance = spread();
      if (pinchDistance > 0 && distance > 0) {
        const centre = midpoint();
        setView(zoomDiagramAt(view, distance / pinchDistance, centre.x, centre.y));
      }
      pinchDistance = distance;
    }
  }

  function onPointerUp(event: PointerEvent): void {
    pointers.delete(event.pointerId);
    pinchDistance = pointers.size === 2 ? spread() : 0;
    if (stage?.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
  }

  function twoPoints(): [{ x: number; y: number }, { x: number; y: number }] | null {
    const [a, b] = [...pointers.values()];
    return a && b ? [a, b] : null;
  }

  function spread(): number {
    const pair = twoPoints();
    return pair ? Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y) : 0;
  }

  function midpoint(): { x: number; y: number } {
    const pair = twoPoints();
    return pair
      ? { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 }
      : { x: 0, y: 0 };
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    const point = stagePoint(event);
    const factor = event.deltaY < 0 ? DIAGRAM_ZOOM_STEP : 1 / DIAGRAM_ZOOM_STEP;
    setView(zoomDiagramAt(view, factor, point.x, point.y));
  }

  function showError(message: string): void {
    if (!canvas || !root) {
      return;
    }
    canvas.replaceChildren();
    root.classList.add('wb-failed');
    const card = document.createElement('div');
    card.className = 'wb-error';
    const heading = document.createElement('h2');
    heading.textContent = 'This SVG cannot be shown as a whiteboard';
    const detail = document.createElement('p');
    detail.className = 'wb-error-detail';
    detail.textContent = message;
    const action = document.createElement('button');
    action.className = 'wb-error-action';
    action.textContent = 'Open as text';
    action.addEventListener('click', () => options.onOpenAsText());
    card.append(heading, detail, action);
    root.append(card);
  }

  function clearError(): void {
    root?.classList.remove('wb-failed');
    root?.querySelector('.wb-error')?.remove();
  }

  /** Render `text`; `refit` is false for external updates so the view holds. */
  function render(text: string, refit: boolean): void {
    if (!canvas) {
      return;
    }
    let parsed: SceneDoc;
    try {
      parsed = parseWhiteboard(text);
    } catch (error) {
      scene = null;
      showError(
        error instanceof WhiteboardParseError
          ? error.message
          : 'The file could not be read as SVG.',
      );
      return;
    }

    // The pure parser validated the document; the DOM renders the ORIGINAL
    // source so nothing the model doesn't understand goes missing on screen.
    const parsedDom = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = parsedDom.documentElement;
    if (svg.getElementsByTagName('parsererror').length > 0 || svg.localName !== 'svg') {
      scene = null;
      showError('The file could not be read as SVG.');
      return;
    }

    clearError();
    scene = parsed;
    // Size the node from the scene, not from whatever the file declared, so a
    // percentage or unit-suffixed width still lays out predictably.
    svg.setAttribute('width', String(parsed.width));
    svg.setAttribute('height', String(parsed.height));
    canvas.style.width = `${parsed.width}px`;
    canvas.style.height = `${parsed.height}px`;
    // A DOMParser-created node's scripts never execute on adoption, and the
    // app CSP forbids inline script regardless.
    canvas.replaceChildren(document.importNode(svg, true));
    if (refit) {
      fit();
    } else {
      applyView();
    }
  }

  function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.className = 'wb-control';
    element.type = 'button';
    element.textContent = label;
    element.title = title;
    element.addEventListener('click', onClick);
    return element;
  }

  return {
    getScene: () => scene,

    attach(host: HTMLElement, model: DocModel) {
      root = document.createElement('div');
      root.className = 'wb-root';

      stage = document.createElement('div');
      stage.className = 'wb-stage';
      stage.tabIndex = 0;

      canvas = document.createElement('div');
      canvas.className = 'wb-canvas';
      stage.append(canvas);

      zoomLabel = document.createElement('span');
      zoomLabel.className = 'wb-zoom-level';

      const controls = document.createElement('div');
      controls.className = 'wb-controls';
      controls.append(
        button('−', 'Zoom out', () => zoomByStep(1 / DIAGRAM_ZOOM_STEP)),
        zoomLabel,
        button('+', 'Zoom in', () => zoomByStep(DIAGRAM_ZOOM_STEP)),
        button('Fit', 'Fit the board to the window', () => fit()),
        button('100%', 'Actual size', () => setView({ ...view, scale: clampDiagramScale(1) })),
      );

      root.append(stage, controls);
      host.replaceChildren(root);

      stage.addEventListener('pointerdown', onPointerDown);
      stage.addEventListener('pointermove', onPointerMove);
      stage.addEventListener('pointerup', onPointerUp);
      stage.addEventListener('pointercancel', onPointerUp);
      stage.addEventListener('wheel', onWheel, { passive: false });

      render(model.getText(), true);

      // External changes only: the raw-mode editor, a file reload, a conflict
      // resolution. Phase 1 never pushes, so no echo suppression is needed yet.
      unsubscribe = model.subscribe((change) => render(change.text, false));
    },

    detach() {
      unsubscribe?.();
      unsubscribe = null;
      if (stage) {
        stage.removeEventListener('pointerdown', onPointerDown);
        stage.removeEventListener('pointermove', onPointerMove);
        stage.removeEventListener('pointerup', onPointerUp);
        stage.removeEventListener('pointercancel', onPointerUp);
        stage.removeEventListener('wheel', onWheel);
      }
      pointers.clear();
      root?.remove();
      root = null;
      stage = null;
      canvas = null;
      zoomLabel = null;
      scene = null;
    },

    focus() {
      stage?.focus();
    },
  };
}
