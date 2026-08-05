/**
 * whiteboard.ts — the Draw-mode editor over a `.svg` file (phases 1–2).
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
  setLayerLocked,
  setLayerVisible,
  targetLayerId,
  type ElementRef,
} from '../core/whiteboard/layers';
import { createOneEuroFilter } from '../core/whiteboard/smoothing';
import {
  ERASER_RADIUS,
  isShapeTool,
  makeShape,
  makeStroke,
  type DrawTool,
  type ToolSettings,
} from '../core/whiteboard/tools';
import type { Point } from '../core/whiteboard/geometry';
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
}

export interface WhiteboardAdapterOptions {
  /** The error card's escape hatch — the UI switches this tab to raw source. */
  onOpenAsText: () => void;
  /** The ribbon's current tool/colour/width, read fresh at each gesture start. */
  getTool: () => ToolSettings;
  /** Undo availability etc., so the ribbon can disable what won't work. */
  onStateChange?: (state: WhiteboardUiState) => void;
}

export interface WhiteboardAdapter extends EditorAdapter {
  /** The parsed scene, or null while the document is unreadable. */
  getScene(): SceneDoc | null;
  undo(): void;
  redo(): void;
  toggleLayers(): void;
  uiState(): WhiteboardUiState;
}

/** The in-flight drag. Exactly one of `points` / `shapeEnd` is meaningful. */
interface Gesture {
  pointerId: number;
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

const SVG_NS = 'http://www.w3.org/2000/svg';

export function createWhiteboardAdapter(options: WhiteboardAdapterOptions): WhiteboardAdapter {
  let root: HTMLDivElement | null = null;
  let stage: HTMLDivElement | null = null;
  let canvas: HTMLDivElement | null = null;
  let live: SVGSVGElement | null = null;
  let previewGroup: SVGGElement | null = null;
  let zoomLabel: HTMLSpanElement | null = null;
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

  let view: DiagramView = { scale: 1, x: 0, y: 0 };
  /** False until the board has been fitted against a stage with real pixels. */
  let fitted = false;
  let resizeObserver: ResizeObserver | null = null;
  /** Live NAVIGATION pointers (touch, middle-drag), for pan / pinch. */
  const pointers = new Map<number, Point>();
  let pinchDistance = 0;
  let gesture: Gesture | null = null;
  let spaceHeld = false;

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
    activeLayerId = targetLayerId(parsed, activeLayerId);
    layersPanel?.render(parsed, activeLayerId);
    if (refit) {
      fitted = fit();
    } else {
      applyView();
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
    svg.append(defs, previewGroup);
    return svg;
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

  /**
   * Does this pointer drive a TOOL, or the view? Phase 2 is mouse + pen only:
   * a finger always pans (the "draw with finger" toggle and palm rejection are
   * phase 3), and a held space bar or a non-primary mouse button pans too —
   * the conventional escape hatch for panning without leaving the tool.
   */
  function isToolPointer(event: PointerEvent): boolean {
    if (spaceHeld || event.pointerType === 'touch') {
      return false;
    }
    return event.button === 0 || event.button === 5;
  }

  function onPointerDown(event: PointerEvent): void {
    if (!stage) {
      return;
    }
    stage.setPointerCapture(event.pointerId);
    if (!scene || !isToolPointer(event)) {
      pointers.set(event.pointerId, stagePoint(event));
      if (pointers.size === 2) {
        pinchDistance = spread();
      }
      return;
    }

    const settings = options.getTool();
    // A pen's eraser end (button 5) overrides the selected tool while it is
    // the one touching the board — the behaviour every stylus user expects.
    const tool: DrawTool = event.button === 5 ? 'eraser' : settings.tool;
    const point = scenePoint(event);
    const filter = createOneEuroFilter();
    gesture = {
      pointerId: event.pointerId,
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
    if (gesture && event.pointerId === gesture.pointerId) {
      finishGesture(scenePoint(event));
    }
    pointers.delete(event.pointerId);
    pinchDistance = pointers.size === 2 ? spread() : 0;
    if (stage?.hasPointerCapture(event.pointerId)) {
      stage.releasePointerCapture(event.pointerId);
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
    if (!gesture) {
      return;
    }
    const wasErasing = gesture.tool === 'eraser' && gesture.erased;
    gesture = null;
    setPreview(null);
    if (wasErasing && history) {
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
    if (event.key === ' ' && !spaceHeld) {
      spaceHeld = true;
      stage?.classList.add('wb-panning');
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      cancelGesture();
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) {
      return;
    }
    const key = event.key.toLowerCase();
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
        commit(history.undo(), false);
      }
    },

    redo() {
      if (history?.canRedo()) {
        commit(history.redo(), false);
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

      const controls = document.createElement('div');
      controls.className = 'wb-controls';
      controls.append(
        button('▤', 'Layers', () => adapter.toggleLayers()),
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

      render(doc.getText(), true);
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

      unsubscribe = doc.subscribe((change) => {
        if (pushingSelf) {
          return; // our own write-back echoing back through the model
        }
        // Someone else changed the document: the raw-mode editor, a file
        // reload, a conflict resolution. Their text is now the truth, so the
        // undo timeline starts over from it.
        cancelGesture();
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
      // the strokes drawn in the last 150 ms.
      cancelGesture();
      flushPush();
      unsubscribe?.();
      unsubscribe = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
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
      }
      pointers.clear();
      root?.remove();
      root = null;
      stage = null;
      canvas = null;
      live = null;
      zoomLabel = null;
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
