/**
 * whiteboard.ts — the Draw-mode editor over a `.svg` file (phases 1–3).
 *
 * Loaded ONLY through a dynamic import from the tab's `draw` AdapterFactory
 * (invariant I8), exactly like Milkdown: a markdown-only session never pays for
 * it. Together with `whiteboard-layers.ts` this is the only DOM in the
 * whiteboard stack — the scene model, the tools, smoothing, hit-testing and
 * undo all live in `src/core/whiteboard/` under Vitest.
 *
 * ## What is on screen
 *
 * The board is rendered by handing SVG SOURCE to DOMParser and adopting the
 * result, so the pane shows exactly what the file says — the same pixels a
 * browser or `![](board.svg)` in the markdown preview would give you. Before
 * the first edit that source is the file's own bytes; after it, it is
 * `serializeWhiteboard(scene)`. There is deliberately no second rendering path
 * that could drift from the format.
 *
 * A separate transparent `<svg>` overlay carries the stroke or shape currently
 * being dragged. It is drawn with `serializeElement` — the very function that
 * will write the committed element — so the preview cannot disagree with the
 * result, and the board itself is untouched until the pointer lifts.
 *
 * ## Not rewriting files you only looked at
 *
 * `createWritebackGuard` (the Milkdown contract, I2) holds the push back until
 * a genuine edit: mount → look → close is byte-identical, so opening a
 * hand-authored or Inkscape SVG can never normalize it. The first real stroke
 * makes our serialization canonical — accepted, and the same deal markdown gets.
 *
 * ## Echo suppression
 *
 * Our own `pushText` synchronously re-enters the model subscription (see
 * `doc-model.ts`), so a reentrancy flag — not a version check — is the correct
 * filter. Without it every stroke would re-parse and re-render the board from
 * its own output and blow the undo history away.
 *
 * ## Phase 3: selection, text, and hands
 *
 * Three additions, all of whose DECISIONS live in pure modules so this file
 * stays "wire the DOM to them":
 *
 * - **Selection** (`core/whiteboard/select.ts`) is a list of element refs.
 *   Moving and resizing BAKE the transform into each element, so a dragged
 *   stroke is still an ordinary stroke and the file still has no transforms in
 *   it. The box and its handles are drawn on the same overlay the in-progress
 *   stroke uses, in scene units divided by the zoom so they stay a constant
 *   size on screen.
 * - **Text** is a `<textarea>` parented to the transformed `.wb-canvas`, which
 *   means the browser scales and pans it with the board for free and the caret
 *   sits exactly where the glyphs will land. It grows with what is typed and
 *   never wraps — one `<tspan>` per newline the user pressed — because that is
 *   the whole of what `<text>` can express. (A drag-out wrapping box was built
 *   and reverted: it made the editor promise a reflow the file cannot keep.)
 * - **Pointer routing** (`core/whiteboard/input.ts`) decides pen/finger/mouse
 *   and rejects palms. It is pure precisely because the combinations — pen down
 *   with a hand resting, second finger mid-stroke, space held — are what manual
 *   testing on one device always misses.
 */

import { parseWhiteboard, WhiteboardParseError } from '../core/whiteboard/parse';
import {
  ARROW_MARKER_ID,
  serializeElement,
  serializeWhiteboard,
} from '../core/whiteboard/serialize';
import type { SceneDoc, SceneElement } from '../core/whiteboard/scene';
import { createHistory, type History } from '../core/whiteboard/history';
import { hitTest } from '../core/whiteboard/hit-test';
import {
  addElement,
  addLayer,
  ensureDrawLayer,
  moveLayer,
  removeElements,
  removeLayer,
  renameLayer,
  setBackground,
  setLayerLocked,
  setLayerVisible,
  targetLayerId,
  type ElementRef,
} from '../core/whiteboard/layers';
import { DEFAULT_BACKGROUND } from '../core/whiteboard/scene';
import { createOneEuroFilter } from '../core/whiteboard/smoothing';
import {
  ERASER_RADIUS,
  HANDLE_HIT_RADIUS,
  HANDLE_SIZE,
  isShapeTool,
  makeShape,
  makeStroke,
  makeText,
  MIN_SELECTION_SIZE,
  PALETTE,
  type DrawTool,
  type ToolSettings,
} from '../core/whiteboard/tools';
import {
  allSelectable,
  elementsInRect,
  handleAt,
  handlePoint,
  hasRef,
  mapElements,
  marqueeRect,
  RESIZE_HANDLES,
  replaceElement,
  resizeRect,
  resolveElement,
  scaleElements,
  selectionBounds,
  toggleRef,
  translateElements,
  validRefs,
  type ResizeHandle,
} from '../core/whiteboard/select';
import {
  createInputState,
  fingerDrawsEnabled,
  notePointerDown,
  notePointerUp,
  routePointer,
  shouldUndoTouchStroke,
  type InputState,
  type PointerInfo,
} from '../core/whiteboard/input';
import type { Point, Rect } from '../core/whiteboard/geometry';
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
import { createLayersPanel, type LayersPanel } from './whiteboard-layers';
import '../styles/whiteboard.css';

/** What the ribbon needs to render its draw cluster correctly. */
export interface WhiteboardUiState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly layersOpen: boolean;
  /** Null while the document is unreadable (the error card is showing). */
  readonly activeLayerName: string | null;
  /** How many elements are selected — the Delete button's enablement. */
  readonly selectionCount: number;
}

export interface WhiteboardAdapterOptions {
  /** The error card's escape hatch — the UI switches this tab to raw source. */
  onOpenAsText: () => void;
  /** The ribbon's current tool/colour/width, read fresh at each gesture start. */
  getTool: () => ToolSettings;
  /** Undo availability etc., so the ribbon can disable what won't work. */
  onStateChange?: (state: WhiteboardUiState) => void;
  /**
   * The "draw with finger" preference: true/false when the user has chosen,
   * null while they have not (fingers draw until a pen appears — see
   * `fingerDrawsEnabled`).
   */
  getFingerDraws?: () => boolean | null;
  /** Fired once, when a pen first touches this board, so the UI can follow. */
  onPenSeen?: () => void;
  /**
   * Session viewport persistence. The view is deliberately NOT written to the
   * file: panning must never dirty a document, and "mount → look → close is
   * byte-identical" is the whole write-back contract. A file that ARRIVES with
   * a `view` in its metadata is still honoured as the opening view.
   */
  getSavedView?: () => DiagramView | null;
  onViewChange?: (view: DiagramView) => void;
}

export interface WhiteboardAdapter extends EditorAdapter {
  /** The parsed scene, or null while the document is unreadable. */
  getScene(): SceneDoc | null;
  undo(): void;
  redo(): void;
  toggleLayers(): void;
  /** Delete the current selection (the ribbon's bin button, and Delete). */
  deleteSelection(): void;
  selectAll(): void;
  /**
   * The ribbon changed the tool. The adapter PULLS tool settings at each
   * gesture, so this is only about what is visible between gestures: the
   * cursor, and whether the selection shows resize handles.
   */
  refreshTool(): void;
  /**
   * The ribbon changed the font or type size: restyle the box being typed in
   * AND any selected text elements, so the controls act on what you are
   * looking at rather than only on the next thing you type.
   */
  applyTextStyle(style: { fontSize?: number; fontFamily?: string }): void;
  uiState(): WhiteboardUiState;
}

/** The in-flight drag. Exactly one of `points` / `shapeEnd` is meaningful. */
interface Gesture {
  pointerId: number;
  /** Which kind of contact owns it — a pen landing cancels a touch stroke. */
  pointerType: string;
  tool: DrawTool;
  color: string;
  width: number;
  /** 1€-filtered samples in scene coordinates (freehand tools). */
  points: Point[];
  filter: (point: Point, timeMs: number) => Point;
  start: Point;
  /** Eraser only: the document with everything erased so far. */
  working: SceneDoc | null;
  /** Eraser only: whether anything has actually been removed yet. */
  erased: boolean;
}

/**
 * A select-tool drag. All three paint their result straight onto the board and
 * commit ONCE on release, so a move is one undo step however many frames it
 * took — the same deal the eraser drag already gets.
 */
type SelectDrag =
  | {
      kind: 'marquee';
      pointerId: number;
      start: Point;
      current: Point;
      /** Shift-drag adds to the selection instead of replacing it. */
      additive: boolean;
      base: readonly ElementRef[];
    }
  | {
      kind: 'move';
      pointerId: number;
      start: Point;
      /** The document as it was when the drag began — every frame re-derives. */
      base: SceneDoc;
      moved: boolean;
    }
  | {
      kind: 'resize';
      pointerId: number;
      handle: ResizeHandle;
      start: Point;
      from: Rect;
      base: SceneDoc;
      moved: boolean;
    };

/** What the text tool is currently editing. `ref` is null for new text. */
interface TextEdit {
  at: Point;
  color: string;
  fontSize: number;
  fontFamily: string | null;
  ref: ElementRef | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Arrow-key nudge directions, in SCREEN pixels (scaled by the zoom). */
const NUDGE_KEYS: Record<string, Point | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * The themable ink variables (phase 2.5). base.css defines them per app
 * light/dark and theme-plugin JSONs may override them; the adapter copies the
 * RESOLVED values onto the board `<svg>` (and the drag-preview overlay) as
 * inline style. Inline beats the file's embedded palette `<style>` block, so a
 * forced app theme renders correctly even when the OS scheme disagrees —
 * exactly the layering the plan's "themable ink" section calls for.
 */
const WB_THEME_VARS = [
  '--wb-bg',
  '--wb-c0',
  '--wb-c1',
  '--wb-c2',
  '--wb-c3',
  '--wb-c4',
  '--wb-c5',
  '--wb-c6',
  '--wb-c7',
];

export function createWhiteboardAdapter(options: WhiteboardAdapterOptions): WhiteboardAdapter {
  let root: HTMLDivElement | null = null;
  let stage: HTMLDivElement | null = null;
  let canvas: HTMLDivElement | null = null;
  let live: SVGSVGElement | null = null;
  let previewGroup: SVGGElement | null = null;
  let chromeGroup: SVGGElement | null = null;
  let zoomLabel: HTMLSpanElement | null = null;
  let pageButton: HTMLButtonElement | null = null;
  let layersPanel: LayersPanel | null = null;
  let unsubscribe: (() => void) | null = null;
  let model: DocModel | null = null;

  let scene: SceneDoc | null = null;
  let history: History<SceneDoc> | null = null;
  let activeLayerId: string | null = null;
  let layersOpen = false;
  /** The source last rendered — also what the write-back guard pushes. */
  let renderedText = '';
  /** True while WE are pushing, so the model subscription ignores the echo. */
  let pushingSelf = false;
  let pendingPush = false;

  let themeObserver: MutationObserver | null = null;

  let view: DiagramView = { scale: 1, x: 0, y: 0 };
  /** False until the board has been fitted against a stage with real pixels. */
  let fitted = false;
  let resizeObserver: ResizeObserver | null = null;
  /** Live NAVIGATION pointers (touch, middle-drag), for pan / pinch. */
  const pointers = new Map<number, Point>();
  /**
   * EVERY live pointer's stage position, drawing ones included. When a second
   * finger converts a stroke into a pinch, the first finger has to join the
   * navigation set at the position it is actually at — this is where that
   * comes from.
   */
  const stagePositions = new Map<number, Point>();
  let pinchDistance = 0;
  let gesture: Gesture | null = null;
  let spaceHeld = false;

  /* ------------------------------ phase 3 state --------------------------- */

  let selection: readonly ElementRef[] = [];
  let selectDrag: SelectDrag | null = null;
  let input: InputState = createInputState();
  /** When a FINGER last committed a stroke — the pen-takeover undo window. */
  let lastTouchCommitAt: number | null = null;
  let textArea: HTMLTextAreaElement | null = null;
  let textEdit: TextEdit | null = null;
  let viewReportTimer: ReturnType<typeof setTimeout> | null = null;

  /* ------------------------------ view plumbing --------------------------- */

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
    // Selection handles are drawn in scene units at a constant SCREEN size, so
    // every zoom change has to redraw them.
    renderChrome();
    reportViewSoon();
  }

  /**
   * Report the viewport for session persistence, coalesced — a pan fires on
   * every frame and the consumer is a store the ribbon subscribes to.
   */
  function reportViewSoon(): void {
    if (!options.onViewChange) {
      return;
    }
    if (viewReportTimer !== null) {
      clearTimeout(viewReportTimer);
    }
    viewReportTimer = setTimeout(() => {
      viewReportTimer = null;
      options.onViewChange?.(view);
    }, 400);
  }

  function reportViewNow(): void {
    if (viewReportTimer !== null) {
      clearTimeout(viewReportTimer);
      viewReportTimer = null;
    }
    if (fitted) {
      options.onViewChange?.(view);
    }
  }

  /**
   * Fit the board to the stage. Returns false when the stage has no size yet —
   * every tab's editor is built while INACTIVE (EditorHost mounts them all and
   * hides the inactive ones with `display:none`, invariant I7), so the first
   * attempt measures 0×0. The ResizeObserver retries once real pixels arrive.
   */
  function fit(): boolean {
    if (!stage || !scene) {
      return false;
    }
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
    setView(fitDiagramView(scene.width, scene.height, rect.width, rect.height));
    return true;
  }

  function zoomByStep(factor: number): void {
    if (!stage) {
      return;
    }
    const rect = stage.getBoundingClientRect();
    setView(zoomDiagramAt(view, factor, rect.width / 2, rect.height / 2));
  }

  function stagePoint(event: { clientX: number; clientY: number }): Point {
    const rect = stage!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /**
   * Stage pixels → scene units. Two mappings compose: the pan/zoom transform on
   * `.wb-canvas`, then the board's own viewBox scale (a file may declare a
   * viewBox that differs from its width/height).
   */
  function scenePoint(event: { clientX: number; clientY: number }): Point {
    const p = stagePoint(event);
    const board = { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale };
    if (!scene) {
      return board;
    }
    const [vx, vy, vw, vh] = scene.viewBox;
    return { x: vx + board.x * (vw / scene.width), y: vy + board.y * (vh / scene.height) };
  }

  /** How many scene units one stage pixel covers — the nib's screen size. */
  function sceneUnitsPerPixel(): number {
    if (!scene) {
      return 1;
    }
    return scene.viewBox[2] / scene.width / view.scale;
  }

  /**
   * Scene units → `.wb-canvas` pixels. The canvas carries the pan/zoom
   * transform, so anything positioned in these coordinates (the text
   * textarea) is moved and scaled by the browser for free.
   */
  function sceneToBoard(p: Point): Point {
    if (!scene) {
      return p;
    }
    const [vx, vy, vw, vh] = scene.viewBox;
    return { x: ((p.x - vx) * scene.width) / vw, y: ((p.y - vy) * scene.height) / vh };
  }

  /** Board pixels per scene unit — the text overlay's font scale. */
  function boardScale(): number {
    return scene ? scene.width / scene.viewBox[2] : 1;
  }

  /* -------------------------------- rendering ----------------------------- */

  function showError(message: string): void {
    if (!canvas || !root) {
      return;
    }
    canvas.replaceChildren();
    root.classList.add('wb-failed');
    root.querySelector('.wb-error')?.remove();
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
    if (!canvas || !live) {
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
      notifyState();
      return;
    }

    // The pure parser validated the document; the DOM renders the SOURCE so
    // nothing the model doesn't understand goes missing on screen.
    const parsedDom = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = parsedDom.documentElement;
    if (svg.getElementsByTagName('parsererror').length > 0 || svg.localName !== 'svg') {
      scene = null;
      showError('The file could not be read as SVG.');
      notifyState();
      return;
    }

    clearError();
    const previous = scene;
    scene = parsed;
    renderedText = text;
    // Size the node from the scene, not from whatever the file declared, so a
    // percentage or unit-suffixed width still lays out predictably.
    svg.setAttribute('width', String(parsed.width));
    svg.setAttribute('height', String(parsed.height));
    canvas.style.width = `${parsed.width}px`;
    canvas.style.height = `${parsed.height}px`;
    live.setAttribute('width', String(parsed.width));
    live.setAttribute('height', String(parsed.height));
    live.setAttribute('viewBox', parsed.viewBox.join(' '));
    // A DOMParser-created node's scripts never execute on adoption, and the
    // app CSP forbids inline script regardless.
    canvas.replaceChildren(document.importNode(svg, true), live);
    // The overlay joins the board's palette scope so an in-flight stroke is
    // themed exactly like it will be once committed.
    live.classList.toggle('wb-board', parsed.meta.themed !== false);
    applyInkTheme();
    // Infinite boards: the stage IS the surface (no page edge, no clipping),
    // and the Page control flips its meaning.
    const infinite = parsed.background === null;
    root?.classList.toggle('wb-infinite', infinite);
    if (pageButton) {
      pageButton.setAttribute('aria-pressed', String(!infinite));
      pageButton.title = infinite
        ? 'Add a background page around the content'
        : 'Remove the background page (infinite board)';
    }
    activeLayerId = targetLayerId(parsed, activeLayerId);
    layersPanel?.render(parsed, activeLayerId);
    // A ref survives a move or a resize (those replace elements in place) but
    // not an add or a delete, so every render re-checks what is still there.
    selection = validRefs(parsed, selection);
    renderChrome();
    if (refit) {
      fitted = fit();
    } else {
      // An infinite board's viewBox refits to the content on every commit, so
      // its origin can move mid-session. Shift the pan by the same amount to
      // keep the ink pinned to its screen position.
      if (previous) {
        const k = previous.width / previous.viewBox[2];
        if (Math.abs(k - parsed.width / parsed.viewBox[2]) < 1e-6) {
          view = {
            ...view,
            x: view.x + (parsed.viewBox[0] - previous.viewBox[0]) * k * view.scale,
            y: view.y + (parsed.viewBox[1] - previous.viewBox[1]) * k * view.scale,
          };
        }
      }
      applyView();
    }
  }

  /**
   * Copy the app's resolved `--wb-*` values onto the board and overlay roots.
   * Reading computed style off <html> keeps this module ignorant of the ui
   * layer's theme plumbing (I9) while still honouring base.css, `data-theme`
   * and any theme-plugin `whiteboard` override, all at once.
   */
  function applyInkTheme(): void {
    const resolved = getComputedStyle(document.documentElement);
    for (const target of [canvas?.firstElementChild, live]) {
      if (!(target instanceof SVGSVGElement)) {
        continue;
      }
      for (const name of WB_THEME_VARS) {
        const value = resolved.getPropertyValue(name).trim();
        if (value.length > 0) {
          target.style.setProperty(name, value);
        } else {
          target.style.removeProperty(name);
        }
      }
    }
  }

  /** Draw (or clear) the element being dragged, on the transparent overlay. */
  function setPreview(element: SceneElement | null): void {
    if (!previewGroup) {
      return;
    }
    previewGroup.innerHTML = element === null ? '' : serializeElement(element);
  }

  /**
   * The overlay carries its own copy of the arrow marker: the board's `<defs>`
   * only exists once a file HAS an arrow, so without this the very first arrow
   * would drag around headless. Duplicate ids are harmless — the board comes
   * first in document order and its identical marker wins once it appears.
   */
  function buildOverlay(): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'wb-live');
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.innerHTML =
      `<marker id="${ARROW_MARKER_ID}" viewBox="0 0 10 10" refX="9" refY="5" ` +
      `markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
      `<path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>`;
    previewGroup = document.createElementNS(SVG_NS, 'g');
    // Selection chrome rides ABOVE the stroke preview: the box and its handles
    // are UI, not ink, and must never be hidden by what is being drawn.
    chromeGroup = document.createElementNS(SVG_NS, 'g');
    chromeGroup.setAttribute('class', 'wb-chrome');
    svg.append(defs, previewGroup, chromeGroup);
    return svg;
  }

  /* ------------------------------- selection ------------------------------ */

  /**
   * Draw the selection box, its handles and the marquee.
   *
   * Everything is sized in SCENE units divided by the current zoom, so a handle
   * is the same number of screen pixels whether the board is at 30% or 400% —
   * handles that scale with the drawing are unusable at both extremes. The
   * chrome is markup rather than DOM building for the same reason the stroke
   * preview is: one string, one assignment, no incremental-update bugs.
   */
  function renderChrome(): void {
    if (!chromeGroup) {
      return;
    }
    const unit = sceneUnitsPerPixel();
    const parts: string[] = [];

    if (selectDrag?.kind === 'marquee') {
      const box = marqueeRect(selectDrag.start, selectDrag.current);
      parts.push(
        `<rect class="wb-marquee" x="${box.x}" y="${box.y}" width="${box.width}" ` +
          `height="${box.height}" stroke-width="${unit}" stroke-dasharray="${4 * unit} ${3 * unit}"/>`,
      );
    }

    const box = scene ? selectionBounds(scene, selection) : null;
    if (box) {
      const pad = 3 * unit;
      const outline = {
        x: box.x - pad,
        y: box.y - pad,
        width: box.width + pad * 2,
        height: box.height + pad * 2,
      };
      parts.push(
        `<rect class="wb-sel-box" x="${outline.x}" y="${outline.y}" ` +
          `width="${outline.width}" height="${outline.height}" stroke-width="${unit}" ` +
          `stroke-dasharray="${5 * unit} ${4 * unit}"/>`,
      );
      // Handles only make sense while the SELECT tool is live; with the pen in
      // hand the box is just a reminder of what Delete would take.
      if (options.getTool().tool === 'select' && selectDrag?.kind !== 'marquee') {
        const size = HANDLE_SIZE * unit;
        for (const handle of RESIZE_HANDLES) {
          const p = handlePoint(outline, handle);
          parts.push(
            `<rect class="wb-sel-handle" x="${p.x - size / 2}" y="${p.y - size / 2}" ` +
              `width="${size}" height="${size}" stroke-width="${unit}"/>`,
          );
        }
      }
    }
    chromeGroup.innerHTML = parts.join('');
  }

  function setSelection(next: readonly ElementRef[]): void {
    selection = next;
    renderChrome();
    notifyState();
  }

  /* --------------------------------- editing ------------------------------ */

  function notifyState(): void {
    options.onStateChange?.(publicState());
  }

  function publicState(): WhiteboardUiState {
    const layer = scene?.layers.find((l) => l.id === activeLayerId);
    return {
      canUndo: history?.canUndo() ?? false,
      canRedo: history?.canRedo() ?? false,
      layersOpen,
      activeLayerName: layer?.name ?? null,
      selectionCount: selection.length,
    };
  }

  /**
   * Make `next` the document: render it, and schedule the write-back. Pass
   * `record: false` for undo/redo, which move WITHIN the timeline rather than
   * extending it.
   */
  function commit(next: SceneDoc, record = true): void {
    if (record) {
      history?.push(next);
    }
    render(serializeWhiteboard(next), false);
    pendingPush = true;
    schedulePush();
    notifyState();
  }

  /**
   * Push on a 150 ms trailing debounce (the plan's figure): a long eraser drag
   * removes a dozen strokes in a second, and each one would otherwise re-run
   * the session flusher's dirty comparison over the whole SVG string.
   */
  let pushTimer: ReturnType<typeof setTimeout> | null = null;

  function schedulePush(): void {
    if (pushTimer !== null) {
      clearTimeout(pushTimer);
    }
    pushTimer = setTimeout(flushPush, 150);
  }

  function flushPush(): void {
    if (pushTimer !== null) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    if (!pendingPush || !model) {
      return;
    }
    pendingPush = false;
    pushingSelf = true;
    try {
      model.pushText(renderedText, 'programmatic');
    } finally {
      pushingSelf = false;
    }
  }

  /* --------------------------------- gestures ----------------------------- */

  function pointerInfo(event: PointerEvent): PointerInfo {
    return {
      pointerType: event.pointerType,
      button: event.button,
      width: event.width,
      height: event.height,
      timeMs: event.timeStamp,
    };
  }

  /** The routing context, assembled from what the adapter currently knows. */
  function routeContext() {
    return {
      fingerDraws: fingerDrawsEnabled(options.getFingerDraws?.() ?? null, input.penSeen),
      spaceHeld,
      touchDrawing: gesture?.pointerType === 'touch' || selectDrag !== null,
    };
  }

  /**
   * A pen has landed. Anything a hand did in the last instant was the hand:
   * discard a touch stroke still in flight, and UNDO one that just committed
   * (the palm touches down a fraction ahead of the nib and leaves a worm).
   */
  function penTakeover(at: number): void {
    if (gesture?.pointerType === 'touch' || selectDrag !== null) {
      cancelGesture();
    }
    if (shouldUndoTouchStroke(lastTouchCommitAt, at)) {
      lastTouchCommitAt = null;
      adapter.undo();
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (!stage) {
      return;
    }
    // A pointer landing anywhere commits whatever was being typed, before it
    // can start a gesture that would make the caret's position meaningless.
    commitText();

    const info = pointerInfo(event);
    if (info.pointerType === 'pen') {
      if (!input.penSeen) {
        options.onPenSeen?.();
      }
      penTakeover(info.timeMs);
    }
    input = notePointerDown(input, info);
    const route = routePointer(input, info, routeContext());
    if (route === 'ignore') {
      return; // a palm: no capture, no mark, no trace it was ever here
    }

    stagePositions.set(event.pointerId, stagePoint(event));
    stage.setPointerCapture(event.pointerId);
    // Focus EXPLICITLY. Every gesture below calls preventDefault(), which
    // suppresses the compatibility mousedown — and focus-on-click rides on
    // mousedown, so without this the stage never becomes the keyboard target
    // and Delete, Ctrl+Z and the arrow-key nudge all silently do nothing.
    stage.focus({ preventScroll: true });

    if (!scene || route === 'navigate') {
      // A second finger arriving mid-stroke turns the whole thing into a
      // pinch, so the finger that WAS drawing joins the navigation set.
      if (gesture?.pointerType === 'touch') {
        // Read the id BEFORE cancelling — `cancelGesture` clears `gesture`,
        // and reading it afterwards is the exact bug that made phase 2's
        // strokes vanish on release.
        const drawingId = gesture.pointerId;
        const drawingAt = stagePositions.get(drawingId);
        cancelGesture();
        if (drawingAt) {
          pointers.set(drawingId, drawingAt);
        }
      }
      pointers.set(event.pointerId, stagePoint(event));
      if (pointers.size === 2) {
        pinchDistance = spread();
      }
      return;
    }

    const settings = options.getTool();
    // The pen's eraser end overrides the selected tool while IT is the end
    // touching the board — the behaviour every stylus user expects.
    const tool: DrawTool = route === 'erase' ? 'eraser' : settings.tool;
    const point = scenePoint(event);

    if (tool === 'select') {
      beginSelectDrag(event, point);
      event.preventDefault();
      return;
    }
    if (tool === 'text') {
      openTextEditor(point, null);
      event.preventDefault();
      return;
    }

    const filter = createOneEuroFilter();
    gesture = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      tool,
      color: settings.color,
      width: settings.width,
      points: [filter(point, event.timeStamp)],
      filter,
      start: point,
      working: tool === 'eraser' ? scene : null,
      erased: false,
    };
    if (tool === 'eraser') {
      eraseAt(point);
    } else {
      updatePreview();
    }
    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent): void {
    stagePositions.set(event.pointerId, stagePoint(event));

    if (selectDrag && event.pointerId === selectDrag.pointerId) {
      updateSelectDrag(scenePoint(event));
      return;
    }

    if (gesture && event.pointerId === gesture.pointerId) {
      // Coalesced events recover the samples the browser batched between
      // frames — on a 240 Hz digitizer that is most of the stroke.
      const samples = event.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length > 0 ? samples : [event]) {
        const point = scenePoint(sample);
        if (gesture.tool === 'eraser') {
          eraseAt(point);
        } else {
          gesture.points.push(gesture.filter(point, sample.timeStamp));
        }
      }
      if (gesture.tool !== 'eraser') {
        updatePreview(scenePoint(event));
      }
      return;
    }

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
    if (selectDrag && event.pointerId === selectDrag.pointerId) {
      finishSelectDrag(scenePoint(event));
    } else if (gesture && event.pointerId === gesture.pointerId) {
      finishGesture(scenePoint(event));
    }
    input = notePointerUp(input, pointerInfo(event));
    pointers.delete(event.pointerId);
    stagePositions.delete(event.pointerId);
    pinchDistance = pointers.size === 2 ? spread() : 0;
    if (stage?.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
    }
  }

  /* ---------------------------- the select tool --------------------------- */

  /**
   * Which of the three select gestures a press starts, in priority order:
   * a handle resizes, an element (already selected or not) moves, empty board
   * marquees. Shift adds to the set instead of replacing it.
   */
  function beginSelectDrag(event: PointerEvent, point: Point): void {
    if (!scene) {
      return;
    }
    const unit = sceneUnitsPerPixel();
    const box = selectionBounds(scene, selection);
    if (box) {
      const pad = 3 * unit;
      const outline = {
        x: box.x - pad,
        y: box.y - pad,
        width: box.width + pad * 2,
        height: box.height + pad * 2,
      };
      const handle = handleAt(outline, point, HANDLE_HIT_RADIUS * unit);
      if (handle) {
        selectDrag = {
          kind: 'resize',
          pointerId: event.pointerId,
          handle,
          start: point,
          from: outline,
          base: scene,
          moved: false,
        };
        return;
      }
    }

    const hit = hitTest(scene, point, ERASER_RADIUS * unit)[0] ?? null;
    if (hit) {
      // Pressing on something already selected keeps the whole set — that is
      // what makes "drag the group" work.
      const next = event.shiftKey
        ? toggleRef(selection, hit)
        : hasRef(selection, hit)
          ? selection
          : [hit];
      setSelection(next);
      selectDrag = {
        kind: 'move',
        pointerId: event.pointerId,
        start: point,
        base: scene,
        moved: false,
      };
      return;
    }

    selectDrag = {
      kind: 'marquee',
      pointerId: event.pointerId,
      start: point,
      current: point,
      additive: event.shiftKey,
      base: event.shiftKey ? selection : [],
    };
    if (!event.shiftKey) {
      setSelection([]);
    }
    renderChrome();
  }

  function updateSelectDrag(point: Point): void {
    if (!selectDrag) {
      return;
    }
    if (selectDrag.kind === 'marquee') {
      const drag = selectDrag;
      drag.current = point;
      const inside = scene ? elementsInRect(scene, marqueeRect(drag.start, point)) : [];
      selection = drag.additive
        ? [...drag.base, ...inside.filter((ref) => !hasRef(drag.base, ref))]
        : inside;
      renderChrome();
      notifyState();
      return;
    }
    if (selectDrag.kind === 'move') {
      const dx = point.x - selectDrag.start.x;
      const dy = point.y - selectDrag.start.y;
      selectDrag.moved = selectDrag.moved || Math.abs(dx) > 0 || Math.abs(dy) > 0;
      // Re-derive from the drag's OWN starting document every frame, so the
      // move is one transform rather than an accumulating pile of them.
      render(serializeWhiteboard(translateElements(selectDrag.base, selection, dx, dy)), false);
      return;
    }
    const target = resizeRect(
      selectDrag.from,
      selectDrag.handle,
      point.x - selectDrag.start.x,
      point.y - selectDrag.start.y,
      MIN_SELECTION_SIZE,
    );
    selectDrag.moved = true;
    render(
      serializeWhiteboard(scaleElements(selectDrag.base, selection, selectDrag.from, target)),
      false,
    );
  }

  function finishSelectDrag(point: Point): void {
    const drag = selectDrag;
    selectDrag = null;
    if (!drag) {
      return;
    }
    if (drag.kind === 'marquee') {
      renderChrome();
      notifyState();
      return;
    }
    if (!drag.moved || !scene) {
      renderChrome();
      return;
    }
    // The board already SHOWS the result (every frame painted it); committing
    // is what makes it one undo step and schedules the write-back.
    const next =
      drag.kind === 'move'
        ? translateElements(drag.base, selection, point.x - drag.start.x, point.y - drag.start.y)
        : scaleElements(
            drag.base,
            selection,
            drag.from,
            resizeRect(
              drag.from,
              drag.handle,
              point.x - drag.start.x,
              point.y - drag.start.y,
              MIN_SELECTION_SIZE,
            ),
          );
    if (next === drag.base) {
      render(serializeWhiteboard(drag.base), false);
      return;
    }
    commit(next);
  }

  /* ------------------------------- the text tool -------------------------- */

  /**
   * A `<textarea>` parented to the transformed `.wb-canvas`, positioned in
   * board pixels. Living inside the transform means the browser pans and zooms
   * it with the board, and the type size matches the ink it is about to
   * become — you edit text where the text will be, not in a floating box.
   *
   * It grows with what is typed and NEVER wraps, because `<text>` never wraps:
   * the box the user sees is exactly the run of glyphs the file will hold. A
   * fixed-width wrapping box was tried and reverted — it made the editor
   * promise a reflow the format cannot keep.
   */
  function openTextEditor(at: Point, existing: ElementRef | null): void {
    if (!canvas || !scene) {
      return;
    }
    commitText();
    const settings = options.getTool();
    const current = existing ? resolveElement(scene, existing) : null;
    const element = current?.kind === 'text' ? current : null;
    textEdit = {
      at: element ? { x: element.x, y: element.y } : at,
      color: element ? element.fill : settings.color,
      // Reopening existing text adopts ITS type, so editing a label does not
      // silently restyle it to whatever the ribbon happens to say.
      fontSize: element ? element.fontSize : settings.fontSize,
      fontFamily: element ? element.fontFamily : settings.fontFamily,
      ref: element ? existing : null,
    };

    const area = document.createElement('textarea');
    area.className = 'wb-text-input';
    area.spellcheck = false;
    area.rows = 1;
    area.value = element ? element.lines.join('\n') : '';
    area.addEventListener('pointerdown', (e) => e.stopPropagation());
    area.addEventListener('keydown', onTextKeyDown);
    area.addEventListener('blur', () => commitText());
    area.addEventListener('input', () => autoSizeText(area));
    // Editing EXISTING text sits on top of the glyphs it came from, so the box
    // paints the board colour behind itself; a new one stays transparent so
    // you can see what you are typing over.
    area.classList.toggle('wb-editing', element !== null);
    canvas.append(area);
    textArea = area;
    styleTextArea();
    // Focus after layout so the caret lands in a box that already has a size.
    requestAnimationFrame(() => area.focus());
    notifyState();
  }

  /**
   * Put the current type on the open box. Separate from opening it because the
   * ribbon can change font or size WHILE typing, and the box has to follow —
   * including its top, since `<text y>` is a baseline and the offset from the
   * box's top edge is a fraction of the type size.
   */
  function styleTextArea(): void {
    const area = textArea;
    const edit = textEdit;
    if (!area || !edit) {
      return;
    }
    const scale = boardScale();
    const origin = sceneToBoard(edit.at);
    area.style.left = `${origin.x}px`;
    // A textarea's first line sits about 0.8em above its own baseline at
    // line-height 1.2; line the two up so the caret is where the glyphs land.
    area.style.top = `${origin.y - edit.fontSize * scale * 0.8}px`;
    area.style.fontSize = `${edit.fontSize * scale}px`;
    area.style.fontFamily = edit.fontFamily ?? '';
    area.style.color = inkColor(edit.color);
    autoSizeText(area);
  }

  /**
   * Grow the box with its content; a fixed-size textarea hides what you type.
   * It grows in BOTH directions — sideways with the longest line, because the
   * CSS keeps `white-space: pre` and a line that would wrap on screen would be
   * lying about the single unwrapped `<tspan>` it is going to become.
   */
  function autoSizeText(area: HTMLTextAreaElement): void {
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight}px`;
    const longest = area.value.split('\n').reduce((n, line) => Math.max(n, line.length), 0);
    area.style.width = `${Math.max(6, longest + 2)}ch`;
  }

  function onTextKeyDown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelText();
      stage?.focus();
      return;
    }
    // Enter is a newline (this is a text BOX); Ctrl/Cmd+Enter finishes, which
    // is the same "done" chord the app's other multi-line inputs use.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commitText();
      stage?.focus();
    }
  }

  function cancelText(): void {
    textArea?.remove();
    textArea = null;
    textEdit = null;
    notifyState();
  }

  /** Fold the textarea back into the document. Empty input leaves nothing. */
  function commitText(): void {
    const area = textArea;
    const edit = textEdit;
    textArea = null;
    textEdit = null;
    area?.remove();
    if (!area || !edit || !scene) {
      return;
    }
    const element = makeText(edit.at, area.value, edit.color, edit.fontSize, edit.fontFamily);
    if (edit.ref) {
      // Editing existing text: empty means delete it.
      commit(
        element ? replaceElement(scene, edit.ref, element) : removeElements(scene, [edit.ref]),
      );
      return;
    }
    if (!element) {
      return;
    }
    const target = ensureDrawLayer(scene, activeLayerId);
    activeLayerId = target.layerId;
    commit(addElement(target.doc, target.layerId, element));
  }

  /**
   * The colour a swatch actually paints in the current theme. The stored value
   * is the canonical light hex (the slot's identity); the board renders it
   * through `--wb-cN`, and the textarea has to agree or typing looks like one
   * colour and committing gives another.
   */
  function inkColor(color: string): string {
    const slot = PALETTE.indexOf(color);
    if (slot < 0) {
      return color;
    }
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue(`--wb-c${slot}`)
      .trim();
    return resolved.length > 0 ? resolved : color;
  }

  /** Double-click with the select tool opens the text under the pointer. */
  function onDoubleClick(event: MouseEvent): void {
    if (!scene || options.getTool().tool !== 'select') {
      return;
    }
    const point = scenePoint(event);
    const hit = hitTest(scene, point, ERASER_RADIUS * sceneUnitsPerPixel())[0];
    if (hit && resolveElement(scene, hit)?.kind === 'text') {
      openTextEditor(point, hit);
    }
  }

  /**
   * The element `active` would produce if it ended at `end`.
   *
   * The gesture is an explicit ARGUMENT, not read from the closure: `commit` on
   * pointer-up has to happen after the gesture is cleared (so a stray event
   * can't extend a finished stroke), and reading `gesture` here meant that call
   * always saw null — every stroke drew, then vanished on release.
   */
  function elementFor(active: Gesture, end: Point): SceneElement | null {
    if (active.tool === 'pen' || active.tool === 'highlighter') {
      return makeStroke(active.tool, active.points, active.color, active.width);
    }
    if (isShapeTool(active.tool)) {
      return makeShape(active.tool, active.start, end, active.color, active.width);
    }
    return null;
  }

  /** Redraw the overlay for the gesture in flight. No-op when there is none. */
  function updatePreview(end?: Point): void {
    setPreview(gesture ? elementFor(gesture, end ?? gesture.start) : null);
  }

  /** Remove everything under `point` from the gesture's working document. */
  function eraseAt(point: Point): void {
    if (!gesture?.working) {
      return;
    }
    const radius = ERASER_RADIUS * sceneUnitsPerPixel();
    const hits: readonly ElementRef[] = hitTest(gesture.working, point, radius);
    if (hits.length === 0) {
      return;
    }
    gesture.working = removeElements(gesture.working, hits);
    gesture.erased = true;
    // Show the removal immediately; the whole drag lands as ONE undo step when
    // the pointer lifts.
    render(serializeWhiteboard(gesture.working), false);
  }

  function finishGesture(end: Point): void {
    const active = gesture;
    gesture = null;
    setPreview(null);
    if (!active || !scene) {
      return;
    }
    // Remember when a FINGER last put something down: if a pen lands in the
    // next breath, that mark was a palm and gets undone (input.ts).
    if (active.pointerType === 'touch') {
      lastTouchCommitAt = performance.now();
    }
    if (active.tool === 'eraser') {
      if (active.erased && active.working) {
        commit(active.working);
      }
      return;
    }
    const element = elementFor(active, end);
    if (!element) {
      return;
    }
    // A foreign SVG has only its locked "Imported" layer, so the first stroke
    // creates the layer it lands on — inside the same undo step.
    const target = ensureDrawLayer(scene, activeLayerId);
    activeLayerId = target.layerId;
    commit(addElement(target.doc, target.layerId, element));
  }

  function cancelGesture(): void {
    // A select drag has also been painting straight onto the board, so it
    // needs the same restore-from-the-last-commit treatment as an erase.
    const wasDragging = selectDrag !== null && selectDrag.kind !== 'marquee' && selectDrag.moved;
    selectDrag = null;
    if (!gesture) {
      if (wasDragging && history) {
        render(serializeWhiteboard(history.current()), false);
      } else {
        renderChrome();
      }
      return;
    }
    const wasErasing = gesture.tool === 'eraser' && gesture.erased;
    gesture = null;
    setPreview(null);
    if ((wasErasing || wasDragging) && history) {
      // An erase drag paints its removals straight onto the board (and so onto
      // `renderedText`) before it commits. Escape has to come back from the
      // last COMMITTED state, not from what is currently on screen.
      render(serializeWhiteboard(history.current()), false);
    }
  }

  function twoPoints(): [Point, Point] | null {
    const [a, b] = [...pointers.values()];
    return a && b ? [a, b] : null;
  }

  function spread(): number {
    const pair = twoPoints();
    return pair ? Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y) : 0;
  }

  function midpoint(): Point {
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

  function onKeyDown(event: KeyboardEvent): void {
    if (textArea && event.target === textArea) {
      return; // typing; the textarea's own handler owns Escape and Ctrl+Enter
    }
    if (event.key === ' ' && !spaceHeld) {
      spaceHeld = true;
      stage?.classList.add('wb-panning');
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      cancelGesture();
      setSelection([]);
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selection.length > 0) {
        event.preventDefault();
        adapter.deleteSelection();
      }
      return;
    }
    // Nudge: the keyboard's answer to "one pixel to the left", and the reason
    // a mouse-less resize is not the only way to align things.
    const nudge = NUDGE_KEYS[event.key];
    if (nudge && selection.length > 0 && scene) {
      event.preventDefault();
      const step = (event.shiftKey ? 10 : 1) * sceneUnitsPerPixel();
      commit(translateElements(scene, selection, nudge.x * step, nudge.y * step));
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'a') {
      event.preventDefault();
      adapter.selectAll();
      return;
    }
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        adapter.redo();
      } else {
        adapter.undo();
      }
    } else if (key === 'y') {
      event.preventDefault();
      adapter.redo();
    }
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === ' ') {
      spaceHeld = false;
      stage?.classList.remove('wb-panning');
    }
  }

  /* --------------------------------- layers ------------------------------- */

  function withScene(update: (doc: SceneDoc) => SceneDoc): void {
    if (scene) {
      commit(update(scene));
    }
  }

  function buildLayersPanel(): LayersPanel {
    return createLayersPanel({
      onSelect: (id) => {
        activeLayerId = id;
        if (scene) {
          layersPanel?.render(scene, activeLayerId);
        }
        notifyState();
      },
      onToggleVisible: (id, visible) => withScene((doc) => setLayerVisible(doc, id, visible)),
      onToggleLocked: (id, locked) => withScene((doc) => setLayerLocked(doc, id, locked)),
      onRename: (id, name) => withScene((doc) => renameLayer(doc, id, name)),
      onMove: (id, delta) => withScene((doc) => moveLayer(doc, id, delta)),
      onAdd: () =>
        withScene((doc) => {
          const next = addLayer(doc);
          activeLayerId = next.layers[next.layers.length - 1]!.id;
          return next;
        }),
      onDelete: (id) => withScene((doc) => removeLayer(doc, id)),
      onClose: () => adapter.toggleLayers(),
    });
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

  /* --------------------------------- adapter ------------------------------ */

  const adapter: WhiteboardAdapter = {
    getScene: () => scene,
    uiState: publicState,

    undo() {
      if (history?.canUndo()) {
        // Indices move under a selection when elements come back or go away,
        // so stepping through the timeline drops it rather than pointing it at
        // whatever now happens to sit at those positions.
        selection = [];
        commit(history.undo(), false);
      }
    },

    redo() {
      if (history?.canRedo()) {
        selection = [];
        commit(history.redo(), false);
      }
    },

    deleteSelection() {
      if (!scene || selection.length === 0) {
        return;
      }
      const next = removeElements(scene, selection);
      selection = [];
      commit(next);
    },

    selectAll() {
      if (scene) {
        setSelection(allSelectable(scene));
      }
    },

    refreshTool() {
      if (stage) {
        stage.dataset.tool = options.getTool().tool;
      }
      renderChrome();
    },

    applyTextStyle(style) {
      if (textEdit) {
        textEdit = { ...textEdit, ...style };
        styleTextArea();
        return;
      }
      if (!scene) {
        return;
      }
      // Only the text in the selection is affected; a mixed selection restyles
      // its text and leaves the ink alone.
      const texts = selection.filter((ref) => resolveElement(scene!, ref)?.kind === 'text');
      if (texts.length === 0) {
        return;
      }
      const next = mapElements(scene, texts, (element) =>
        element.kind === 'text'
          ? {
              ...element,
              fontSize: style.fontSize ?? element.fontSize,
              fontFamily: style.fontFamily ?? element.fontFamily,
            }
          : element,
      );
      if (next !== scene) {
        commit(next);
      }
    },

    toggleLayers() {
      layersOpen = !layersOpen;
      root?.classList.toggle('wb-layers-open', layersOpen);
      if (layersOpen && scene) {
        layersPanel?.render(scene, activeLayerId);
      }
      notifyState();
    },

    attach(host: HTMLElement, doc: DocModel) {
      model = doc;
      root = document.createElement('div');
      root.className = 'wb-root';
      root.classList.toggle('wb-layers-open', layersOpen);

      stage = document.createElement('div');
      stage.className = 'wb-stage';
      stage.tabIndex = 0;

      canvas = document.createElement('div');
      canvas.className = 'wb-canvas';
      live = buildOverlay();
      stage.append(canvas);

      zoomLabel = document.createElement('span');
      zoomLabel.className = 'wb-zoom-level';

      pageButton = button('▢', 'Add a background page around the content', () =>
        withScene((doc) => setBackground(doc, doc.background === null ? DEFAULT_BACKGROUND : null)),
      );

      const controls = document.createElement('div');
      controls.className = 'wb-controls';
      controls.append(
        button('▤', 'Layers', () => adapter.toggleLayers()),
        pageButton,
        button('−', 'Zoom out', () => zoomByStep(1 / DIAGRAM_ZOOM_STEP)),
        zoomLabel,
        button('+', 'Zoom in', () => zoomByStep(DIAGRAM_ZOOM_STEP)),
        button('Fit', 'Fit the board to the window', () => {
          fitted = fit();
        }),
        button('100%', 'Actual size', () => setView({ ...view, scale: clampDiagramScale(1) })),
      );

      layersPanel = buildLayersPanel();
      root.append(stage, controls, layersPanel.element);
      host.replaceChildren(root);

      stage.addEventListener('pointerdown', onPointerDown);
      stage.addEventListener('pointermove', onPointerMove);
      stage.addEventListener('pointerup', onPointerUp);
      stage.addEventListener('pointercancel', onPointerUp);
      stage.addEventListener('wheel', onWheel, { passive: false });
      stage.addEventListener('keydown', onKeyDown);
      stage.addEventListener('keyup', onKeyUp);
      stage.addEventListener('dblclick', onDoubleClick);

      adapter.refreshTool();
      render(doc.getText(), true);
      // A view carried over from this session (a tab switch, a Draw→Raw→Draw
      // round trip) wins; failing that, one the FILE arrived with; failing
      // that, the fit `render` just did.
      const restored = options.getSavedView?.() ?? viewFromMeta(scene);
      if (restored) {
        setView(restored);
        fitted = true;
      }
      // Re-attach (a Raw→Draw switch back) starts a fresh timeline, matching
      // the documented per-adapter-instance history scope.
      history = createHistory(scene ?? parseFallback(doc.getText()));
      notifyState();

      // The tab was almost certainly hidden when the editor was built, so the
      // fit above measured nothing. Retry the moment the stage has real size —
      // without this the board sits unscaled at the top-left on first view.
      resizeObserver = new ResizeObserver(() => {
        if (!fitted) {
          fitted = fit();
        }
      });
      resizeObserver.observe(stage);

      // main.tsx reflects every theme change (setting, OS flip on 'system',
      // scheme switch) into these <html> attributes — re-resolve the ink vars
      // when they move so an open board recolours live.
      themeObserver = new MutationObserver(applyInkTheme);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-color-scheme'],
      });

      unsubscribe = doc.subscribe((change) => {
        if (pushingSelf) {
          return; // our own write-back echoing back through the model
        }
        // Someone else changed the document: the raw-mode editor, a file
        // reload, a conflict resolution. Their text is now the truth, so the
        // undo timeline starts over from it.
        cancelGesture();
        cancelText();
        selection = [];
        render(change.text, false);
        if (scene) {
          history?.reset(scene);
        }
        pendingPush = false;
        notifyState();
      });
    },

    detach() {
      // MUST be synchronous (mode-sync contract): a Draw→Raw switch has to see
      // the strokes drawn in the last 150 ms — and text still in the box.
      cancelGesture();
      commitText();
      flushPush();
      reportViewNow();
      unsubscribe?.();
      unsubscribe = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      themeObserver?.disconnect();
      themeObserver = null;
      fitted = false;
      spaceHeld = false;
      if (stage) {
        stage.removeEventListener('pointerdown', onPointerDown);
        stage.removeEventListener('pointermove', onPointerMove);
        stage.removeEventListener('pointerup', onPointerUp);
        stage.removeEventListener('pointercancel', onPointerUp);
        stage.removeEventListener('wheel', onWheel);
        stage.removeEventListener('keydown', onKeyDown);
        stage.removeEventListener('keyup', onKeyUp);
        stage.removeEventListener('dblclick', onDoubleClick);
      }
      pointers.clear();
      stagePositions.clear();
      selection = [];
      selectDrag = null;
      lastTouchCommitAt = null;
      // `penSeen` is intentionally NOT reset: the device still has a pen after
      // a mode switch, and re-arming finger-draw would smear the next board.
      input = { ...createInputState(), penSeen: input.penSeen };
      chromeGroup = null;
      previewGroup = null;
      root?.remove();
      root = null;
      stage = null;
      canvas = null;
      live = null;
      zoomLabel = null;
      pageButton = null;
      layersPanel = null;
      scene = null;
      history = null;
      model = null;
    },

    focus() {
      stage?.focus();
    },
  };

  return adapter;
}

/**
 * The opening view a FILE asked for, via `"view"` in its `wb:doc` metadata.
 *
 * Read-only on purpose: the editor never writes it back, because panning a
 * board must not dirty the document (the write-back guard's whole point). It
 * exists so a generated or hand-authored board can say "open here".
 */
function viewFromMeta(doc: SceneDoc | null): DiagramView | null {
  const raw = doc?.meta.view;
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const { scale, x, y } = raw as Record<string, unknown>;
  if (typeof scale !== 'number' || typeof x !== 'number' || typeof y !== 'number') {
    return null;
  }
  return Number.isFinite(scale) && Number.isFinite(x) && Number.isFinite(y)
    ? { scale: clampDiagramScale(scale), x, y }
    : null;
}

/**
 * A stand-in scene for the history stack when the document failed to parse, so
 * the adapter has no null-history special case. It is never rendered: the error
 * card is showing, and any edit needs a scene to start from.
 */
function parseFallback(text: string): SceneDoc {
  try {
    return parseWhiteboard(text);
  } catch {
    return parseWhiteboard('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
  }
}
