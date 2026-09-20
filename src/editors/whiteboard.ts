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
  ALIGN_LABELS,
  alignElements,
  canAlign,
  canDistribute,
  DISTRIBUTE_LABELS,
  distributeElements,
  reorderElements,
  Z_ORDER_LABELS,
  type AlignEdge,
  type DistributeAxis,
  type ZOrderOp,
} from '../core/whiteboard/arrange';
import {
  copyElements,
  parseFragment,
  PASTE_OFFSET,
  pasteElements,
  serializeFragment,
} from '../core/whiteboard/clipboard';
import {
  canGroup,
  canUngroup,
  expandSelection,
  groupElements,
  ungroupElements,
  withoutRefs,
} from '../core/whiteboard/groups';
import {
  attachLabel,
  canHostLabel,
  findElementById,
  hostCentre,
  hostOf,
  labelBaseline,
  labelCentreY,
  labelsOf,
  relayoutLabels,
  withLabels,
} from '../core/whiteboard/labels';
import {
  attachConnector,
  AXIS_PORTS,
  canDetach,
  canHostConnector,
  connectorTarget,
  detachElements,
  endpointOn,
  hostCentreOf,
  portPoints,
  reconnect,
  removeAndDetach,
  setConnectorEnd,
  type ConnectorTarget,
} from '../core/whiteboard/connectors';
import { getClipboard } from '../ipc/clipboard';
import { openContextMenu, type ContextMenuItem } from './whiteboard-menu';
import {
  ARROW_MARKER_ID,
  ARROW_START_MARKER_ID,
  colorModeOf,
  isThemed,
  serializeElement,
  serializeWhiteboard,
} from '../core/whiteboard/serialize';
import {
  isLineShape,
  type LineShapeElement,
  type SceneDoc,
  type SceneElement,
  type TextElement,
} from '../core/whiteboard/scene';
import { createHistory, type History } from '../core/whiteboard/history';
import { hitTest } from '../core/whiteboard/hit-test';
import {
  addElement,
  addLayer,
  addLayerWith,
  ensureDrawLayer,
  moveLayer,
  nextLayerName,
  removeElements,
  removeLayer,
  renameLayer,
  setBackground,
  setColorMode,
  setLayerLocked,
  setLayerVisible,
  targetLayerId,
  type ElementRef,
} from '../core/whiteboard/layers';
import { DEFAULT_BACKGROUND, WB_NAMESPACE } from '../core/whiteboard/scene';
import { createOneEuroFilter } from '../core/whiteboard/smoothing';
import {
  carryGrid,
  DEFAULT_GRID,
  gridOf,
  setGrid as setDocGrid,
  type GridSettings,
} from '../core/whiteboard/grid';
import {
  guidePorts,
  guideRects,
  NO_SNAP,
  snapPoint,
  snapRect,
  type GuideLine,
  type SnapContext,
} from '../core/whiteboard/snap';
import {
  constrainShapeDrag,
  ERASER_RADIUS,
  GRID_HOTKEY,
  SNAP_THRESHOLD,
  HANDLE_HIT_RADIUS,
  HANDLE_SIZE,
  isShapeTool,
  makeShape,
  makeStroke,
  makeText,
  MIN_SELECTION_SIZE,
  PALETTE,
  PORT_SNAP_RADIUS,
  ROUTE_LABELS,
  toolForHotkey,
  type DrawTool,
  type ShapeStyle,
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
  restyleElements,
  selectionStyle,
  type SelectionStyle,
  type StylePatch,
} from '../core/whiteboard/style';
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
import { padRect, type Point, type Rect } from '../core/whiteboard/geometry';
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
import {
  createScanPanel,
  type ScanDebugFile,
  type ScanPanel,
  type ScanPhoto,
  type ScanPrefs,
  type ScanResult,
  type ScanSource,
  type ScanStrokesResult,
} from './whiteboard-scan';
import { fitScanElements } from '../core/whiteboard/scan/trace';
import { SCAN_SMOOTHING } from '../core/whiteboard/scan/types';
import { applyScanOcr, type ScanRecognizeFn } from '../core/whiteboard/scan/ocr';
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
  /**
   * The style the SELECTION agrees on, or null when nothing is selected.
   *
   * The ribbon doubles as the style panel, so with a selection active its
   * swatches, nib, fill, dash and arrow-head controls have to show what is
   * selected rather than what the tool would draw next — and show nothing at
   * all where the selection disagrees with itself. Each field of
   * {@link SelectionStyle} is already "the common value, or null".
   */
  readonly selectionStyle: SelectionStyle | null;
  /**
   * This DOCUMENT's grid (`core/whiteboard/grid.ts`) — the ribbon's grid
   * button, its snap toggle and its size menu. Per tab rather than global,
   * unlike the tool, because the grid belongs to the diagram: it is stored in
   * the file and comes back with it.
   */
  readonly grid: GridSettings;
}

/**
 * What Ctrl+C put on the board clipboard. Held by the UI store (GLOBAL, like
 * the tool: copy on one board, paste on another) and reached through
 * {@link WhiteboardAdapterOptions.clipboard}. `fragment` is the serialized
 * `<svg>` that also went to the system clipboard, so a paste can tell "the
 * same thing again" (which lands a step further along) from "something new";
 * `pastes` is how many times this clipboard has landed so far.
 */
export interface WhiteboardClipboard {
  readonly fragment: string;
  readonly elements: readonly SceneElement[];
  readonly pastes: number;
}

export interface WhiteboardAdapterOptions {
  /** The error card's escape hatch — the UI switches this tab to raw source. */
  onOpenAsText: () => void;
  /**
   * A single-key tool hotkey was pressed on the focused board (V, P, H, E, T,
   * R, O, L, A — `TOOL_HOTKEYS`). The ribbon owns the tool, so the adapter
   * asks it to switch rather than switching anything itself.
   */
  onToolHotkey?: (tool: DrawTool) => void;
  /** The board clipboard — see {@link WhiteboardClipboard}. */
  clipboard?: {
    get: () => WhiteboardClipboard | null;
    set: (clipboard: WhiteboardClipboard | null) => void;
  };
  /** The ribbon's current tool/colour/width, read fresh at each gesture start. */
  getTool: () => ToolSettings;
  /** Undo availability etc., so the ribbon can disable what won't work. */
  onStateChange?: (state: WhiteboardUiState) => void;
  /**
   * The selection itself changed — Split mode's link, which points the source
   * pane at what is selected on the board. Separate from `onStateChange`
   * (whose consumer is the ribbon and which carries no refs) because the refs
   * are not something the ribbon should re-render over.
   */
  onSelectionChange?: (refs: readonly ElementRef[]) => void;
  /**
   * Split mode: "Reveal in source" in the right-click menu. Omitted (Draw
   * mode, where there is no source pane to reveal anything in) the item is not
   * offered at all — the adapter never decides what the tab's layout is.
   */
  onRevealInSource?: (refs: readonly ElementRef[]) => void;
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
  /**
   * Photo acquisition for the scan screen (phase 4). Injected rather than
   * imported: taking a photo is `ipc.capturePhoto` on Android and a native file
   * dialog on desktop, and neither of those belongs in an editor module — the
   * layering contract is `editors → core, ipc`, and dialogs live above that.
   * Omitted entirely, the Scan button is simply unavailable.
   */
  scan?: {
    /** Take a photo with the device camera; null where there is no camera. */
    capture: (() => Promise<ScanPhoto>) | null;
    /** Choose an image file; null where there is no picker. */
    pick: (() => Promise<ScanPhoto | null>) | null;
    /** Surface a message (permission denied, decode failure, size warning). */
    onNotice: (message: string) => void;
    /** This platform's text recognizer (phase 7); null where none exists —
     *  same injection rationale as capture/pick. */
    recognize: ScanRecognizeFn | null;
    /** Write the scan's intermediates beside this document for later analysis
     *  (the review screen's "Debug insert"); null hides that button. */
    saveDebug?: ((files: readonly ScanDebugFile[]) => Promise<string | null>) | null;
    /** Remembered scan tuning (preset + smoothing), backed by settings. */
    prefs?: {
      get: () => ScanPrefs;
      set: (prefs: ScanPrefs) => void;
    } | null;
  };
}

export interface WhiteboardAdapter extends EditorAdapter {
  /** The parsed scene, or null while the document is unreadable. */
  getScene(): SceneDoc | null;
  /** What is selected right now — Split mode's link reads it. */
  getSelection(): readonly ElementRef[];
  /**
   * Select these elements from OUTSIDE (the source pane's caret landed on one).
   * Refs that no longer exist are dropped, the selection still expands over
   * groups and labels like any other, and `reveal` pans the board to them if
   * they are off screen — without taking focus, because the user is typing in
   * the other pane.
   */
  selectRefs(refs: readonly ElementRef[], reveal?: boolean): void;
  undo(): void;
  redo(): void;
  toggleLayers(): void;
  /** Delete the current selection (the ribbon's bin button, and Delete). */
  deleteSelection(): void;
  selectAll(): void;
  /** Ctrl+C: the selection to the board clipboard and, as SVG, the system's. */
  copySelection(): void;
  /** Ctrl+X: copy, then delete. */
  cutSelection(): void;
  /**
   * Ctrl+V / the menu: paste the system clipboard if it holds a whiteboard
   * fragment, else the board clipboard. Each repeat lands 16 units further.
   */
  pasteClipboard(): void;
  /** Ctrl+D: a copy of the selection, 16 units along, without touching the clipboard. */
  duplicateSelection(): void;
  /** Ctrl+] / Ctrl+[ (Shift for front/back): restack within each layer. */
  reorderSelection(op: ZOrderOp): void;
  alignSelection(edge: AlignEdge): void;
  distributeSelection(axis: DistributeAxis): void;
  /** Ctrl+G / Ctrl+Shift+G: tag the selection as one group / clear the tags. */
  groupSelection(): void;
  ungroupSelection(): void;
  /** Cut every selected connector loose from its hosts; the lines stay put. */
  detachSelection(): void;
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
  /**
   * Restyle the selection — colour, fill, nib, dash, arrow heads. The ribbon
   * calls this IN ADDITION to setting the tool default, so one click both
   * changes what is selected and what the next shape will look like. One undo
   * step per click; a no-op when nothing is selected.
   */
  restyleSelection(patch: StylePatch): void;
  /**
   * Change this document's grid — show/hide (the ribbon's button and G), the
   * snap toggle, the spacing. Committed WITHOUT an undo step: showing the grid
   * is not an edit to the drawing, and a Ctrl+Z that turns the dots back on is
   * the kind of surprise that makes people stop using undo.
   */
  setGrid(patch: Partial<GridSettings>): void;
  /**
   * Open the scan screen. Defaults to the camera where there is one and the
   * file picker otherwise; a {@link ScanPhoto} skips acquisition entirely,
   * which is how paste and drag-drop arrive. No-op without `options.scan`.
   */
  startScan(source?: ScanSource): void;
  /** Whether the scan screen is available at all (the ribbon's button). */
  canScan(): boolean;
  /**
   * Throw away whatever gesture is in flight, leaving the board exactly as the
   * last commit left it. The full-screen long-press menu calls this when it
   * opens: holding still is how you summon the menu, and on a board that same
   * hold is a stroke — without this every visit to the menu would leave an ink
   * blob behind.
   */
  abortGesture(): void;
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
  /** Shape tools: the fill/dash/heads the ribbon had when the drag began. */
  shapeStyle: ShapeStyle;
  /** Shift held: the shape is constrained (square/circle, 45° line). */
  constrained: boolean;
  /**
   * Line/arrow tools: the host the press landed on, and the host under the
   * pointer right now (recomputed every frame by `elementFor`). Either end
   * that has one is attached when the line is committed.
   */
  fromTarget: ConnectorTarget | null;
  toTarget: ConnectorTarget | null;
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
      /**
       * The selection minus labels that have a live host. A resize scales
       * these and RE-CENTRES the labels on the result (`relayoutLabels`),
       * because stretching a box must not stretch the type inside it.
       */
      scaled: readonly ElementRef[];
    }
  | {
      /**
       * One end of a single selected connector, dragged by its handle. Over a
       * host it re-attaches (the candidate port lights up); over open board it
       * detaches and snaps like any point.
       */
      kind: 'endpoint';
      pointerId: number;
      ref: ElementRef;
      end: 'from' | 'to';
      start: Point;
      base: SceneDoc;
      moved: boolean;
    };

/**
 * What the text tool is currently editing. `ref` is null for new text; `host`
 * is the element a NEW label is being typed for. `at` is the first line's
 * baseline origin for start-anchored text and the block's CENTRE for a label
 * (`anchor: 'middle'`), whose baseline moves as lines are added.
 */
interface TextEdit {
  at: Point;
  anchor: 'start' | 'middle';
  color: string;
  fontSize: number;
  fontFamily: string | null;
  ref: ElementRef | null;
  host: ElementRef | null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The modifier name the context menu's shortcut column shows. */
const MOD_LABEL = /mac/i.test(navigator.platform) ? '⌘' : 'Ctrl';

/** Arrow-key nudge directions, in SCREEN pixels (scaled by the zoom). */
const NUDGE_KEYS: Record<string, Point | undefined> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * The themable ink variables (phase 2.5). base.css derives them from the
 * current theme's brand trio (--brand-primary/-secondary/-tertiary) and ink
 * colors; the adapter copies the RESOLVED values onto the board `<svg>` (and
 * the drag-preview overlay) as inline style. Inline beats the file's embedded
 * palette `<style>` block, so a forced app theme renders correctly even when
 * the OS scheme disagrees — exactly the layering the plan's "themable ink"
 * section calls for.
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

/** Counts adapter instances, so each board's grid `<pattern>` ids are its own. */
let gridInstances = 0;

export function createWhiteboardAdapter(options: WhiteboardAdapterOptions): WhiteboardAdapter {
  let root: HTMLDivElement | null = null;
  let stage: HTMLDivElement | null = null;
  let canvas: HTMLDivElement | null = null;
  let live: SVGSVGElement | null = null;
  let previewGroup: SVGGElement | null = null;
  let chromeGroup: SVGGElement | null = null;
  let zoomLabel: HTMLSpanElement | null = null;
  let pageButton: HTMLButtonElement | null = null;
  let colorModeButton: HTMLButtonElement | null = null;
  let layersPanel: LayersPanel | null = null;
  /** Built on first use — a session that never scans never pays for it. */
  let scanPanel: ScanPanel | null = null;
  let unsubscribe: (() => void) | null = null;
  let model: DocModel | null = null;

  let scene: SceneDoc | null = null;
  let history: History<SceneDoc> | null = null;
  let activeLayerId: string | null = null;
  let layersOpen = false;
  /** The source last rendered — also what the write-back guard pushes. */
  let renderedText = '';
  /**
   * Why the CURRENT document text cannot be read, while an earlier version of
   * it still can — the state Split mode lives in half the time, because a
   * source editor spends every other keystroke holding invalid XML.
   *
   * The board keeps the last picture it could draw and refuses every edit
   * until the text parses again. Replacing the drawing with the error card on
   * the way through `<rec` would make the other pane useless, and committing
   * from the stale scene would throw away whatever is being typed — so it does
   * neither, and says so. A document that has NEVER parsed still gets the
   * error card: there is no last good picture to stand on.
   */
  let staleMessage: string | null = null;
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

  /* ------------------------------ phase C state --------------------------- */

  /**
   * Alt, read LIVE from every pointer event for the same reason Shift is:
   * people reach for it once they can SEE the thing being pulled somewhere
   * they didn't mean. It suppresses snapping for as long as it is held.
   */
  let snapOff = false;
  /**
   * The rectangles the gesture in flight may align to, computed ONCE when it
   * starts. They come from the drag's base document and the selection cannot
   * change mid-drag, so recomputing them per frame would buy nothing and cost
   * a pass over the board.
   */
  let gestureGuides: readonly Rect[] = [];
  /** The guides currently MATCHED — drawn as chrome, cleared on release. */
  let matchedGuides: readonly GuideLine[] = [];

  /* ------------------------------ phase D state --------------------------- */

  /** The ports the gesture in flight may land on — same lifetime as the guides. */
  let gesturePorts: readonly Point[] = [];
  /** The port a snap landed on this frame, drawn as a ring. */
  let matchedPort: Point | null = null;
  /**
   * The host a connector end is about to attach to — while drawing a line or
   * dragging an endpoint handle. Its ports are drawn with the chosen one lit,
   * so the user can see WHERE the line will land before letting go.
   */
  let hoverTarget: ConnectorTarget | null = null;
  /**
   * Pattern ids have to be unique across the DOCUMENT, not the board: every
   * tab's editor is mounted at once (I7), so two boards showing a grid would
   * otherwise both resolve `url(#wb-grid-minor)` to whichever was adopted
   * first — and paint the other board's spacing.
   */
  const gridIdSuffix = `${++gridInstances}`;

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
    // Same for the grid's dots — and an infinite board's grid rectangle is the
    // visible pane, which a pan moves.
    renderGrid();
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

  /**
   * The text no longer parses, but an earlier version did. Keep that picture
   * on screen, say why it has stopped following, and go inert — see
   * {@link staleMessage}.
   */
  function markStale(message: string): void {
    staleMessage = message;
    cancelGesture();
    cancelText();
    if (!root) {
      return;
    }
    root.classList.add('wb-stale');
    let note = root.querySelector('.wb-stale-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'wb-stale-note';
      root.append(note);
    }
    note.textContent = `Not following the source: ${message}`;
  }

  function clearStale(): void {
    staleMessage = null;
    root?.classList.remove('wb-stale');
    root?.querySelector('.wb-stale-note')?.remove();
  }

  /**
   * Render `text`; `refit` is false for external updates so the view holds.
   *
   * A failure lands one of two ways: the error card when nothing has ever been
   * drawn (there is no picture to keep), the stale strip when something has.
   */
  function render(text: string, refit: boolean): void {
    if (!canvas || !live) {
      return;
    }
    const fail = (message: string): void => {
      if (scene === null) {
        showError(message);
      } else {
        markStale(message);
      }
      notifyState();
    };
    let parsed: SceneDoc;
    try {
      parsed = parseWhiteboard(text);
    } catch (error) {
      fail(
        error instanceof WhiteboardParseError
          ? error.message
          : 'The file could not be read as SVG.',
      );
      return;
    }

    // The pure parser validated the document; the DOM renders the SOURCE so
    // nothing the model doesn't understand goes missing on screen.
    const parsedDom = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = parsedDom.documentElement;
    if (svg.getElementsByTagName('parsererror').length > 0 || svg.localName !== 'svg') {
      fail('The file could not be read as SVG.');
      return;
    }

    clearStale();
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
    // themed exactly like it will be once committed — including the fixed-mode
    // opt-out, which the palette rules honour via `:not(.wb-fixed)`.
    live.classList.toggle('wb-board', isThemed(parsed));
    live.classList.toggle('wb-fixed', isThemed(parsed) && colorModeOf(parsed) === 'fixed');
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
    if (colorModeButton) {
      // Meaningless on a `themed: false` document — there is no palette
      // machinery to switch, so the button says so instead of lying.
      const themable = isThemed(parsed);
      const fixed = themable && colorModeOf(parsed) === 'fixed';
      colorModeButton.disabled = !themable;
      colorModeButton.setAttribute('aria-pressed', String(fixed));
      colorModeButton.title = !themable
        ? 'This document opted out of theming ("themed": false)'
        : fixed
          ? 'Showing true colours — switch to theme colours'
          : 'Showing theme colours — switch to true colours';
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
    // Last: the grid is sized against the view this render settled on.
    renderGrid();
  }

  /**
   * Copy the app's resolved `--wb-*` values onto the board and overlay roots.
   * Reading computed style off <html> keeps this module ignorant of the ui
   * layer's theme plumbing (I9) while still honouring base.css, `data-theme`
   * and the selected theme's brand trio, all at once.
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

  /* ---------------------------------- grid -------------------------------- */

  /**
   * Paint the dot grid INTO the adopted board `<svg>`, after adoption.
   *
   * This is the one place the on-screen board deliberately differs from the
   * file, and the shape of it is the point: the model never learns about the
   * grid's geometry, the serializer never sees it, and `renderedText` — the
   * thing that gets written back — is produced from the scene, not from this
   * DOM. So a board with the grid showing saves exactly like the same board
   * with it hidden, minus one metadata key.
   *
   * It goes inside the board (rather than on the overlay, which would be
   * simpler) because the dots have to sit BENEATH the ink and above the page:
   * a grid painted over a drawing is a grid you have to turn off to read it.
   *
   * Two things are sized in screen pixels and therefore have to be redone on
   * every zoom: the dot radius (constant on screen, like the selection
   * handles) and — for an infinite board, whose viewBox hugs the content —
   * the rectangle the pattern fills, which is the visible pane.
   */
  function renderGrid(): void {
    const board = canvas?.firstElementChild;
    if (!(board instanceof SVGSVGElement)) {
      return;
    }
    board.querySelector('[data-wb-grid]')?.remove();
    if (!scene) {
      return;
    }
    const grid = gridOf(scene);
    if (!grid.show || grid.size <= 0) {
      return;
    }
    // A page board's grid stops at the page; an infinite one's has to cover
    // whatever is on screen, which moves with every pan and zoom.
    const area =
      scene.background === null
        ? padRect(visibleSceneRect(), grid.size * 5)
        : {
            x: scene.viewBox[0],
            y: scene.viewBox[1],
            width: scene.viewBox[2],
            height: scene.viewBox[3],
          };
    const unit = sceneUnitsPerPixel();
    const minor = `wb-grid-minor-${gridIdSuffix}`;
    const major = `wb-grid-major-${gridIdSuffix}`;
    const step = grid.size;
    // The pattern's ORIGIN is the scene origin, never the rect's corner, so
    // the dots sit on the same lines the snapping rounds to. All FOUR corners
    // are drawn because a pattern clips its tile: one circle at (0,0) would
    // paint a quarter of a dot, and the four quarters reassemble it.
    const dots = (id: string, spacing: number, radius: number, cls: string): string =>
      `<pattern id="${id}" patternUnits="userSpaceOnUse" x="0" y="0" ` +
      `width="${spacing}" height="${spacing}">` +
      `<circle class="${cls}" cx="0" cy="0" r="${radius}"/>` +
      `<circle class="${cls}" cx="${spacing}" cy="0" r="${radius}"/>` +
      `<circle class="${cls}" cx="0" cy="${spacing}" r="${radius}"/>` +
      `<circle class="${cls}" cx="${spacing}" cy="${spacing}" r="${radius}"/>` +
      `</pattern>`;
    const fill = (id: string): string =>
      `<rect x="${area.x}" y="${area.y}" width="${area.width}" height="${area.height}" ` +
      `fill="url(#${id})"/>`;
    const group = document.createElementNS(SVG_NS, 'g');
    group.setAttribute('data-wb-grid', '');
    group.setAttribute('class', 'wb-grid');
    group.innerHTML =
      `<defs>${dots(minor, step, unit, 'wb-grid-dot')}` +
      // Every fifth dot is heavier, which is what turns a field of dots into
      // something you can count squares on.
      `${dots(major, step * 5, unit * 1.75, 'wb-grid-dot wb-grid-dot-major')}</defs>` +
      fill(minor) +
      fill(major);
    // Before the first LAYER, so the dots are under the ink and over the page
    // rect, the palette style block and anything the file brought with it.
    const firstLayer = [...board.children].find(
      (child) => child.hasAttributeNS(WB_NAMESPACE, 'layer') || child.hasAttribute('wb:layer'),
    );
    board.insertBefore(group, firstLayer ?? null);
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
      `<path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker>` +
      // The reversed head, same deal: mirrored geometry with plain `auto`, so
      // the drag preview matches what the file will say (see serialize.ts).
      `<marker id="${ARROW_START_MARKER_ID}" viewBox="0 0 10 10" refX="1" refY="5" ` +
      `markerWidth="6" markerHeight="6" orient="auto">` +
      `<path d="M10,0 L0,5 L10,10 z" fill="context-stroke"/></marker>`;
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

    // Smart guides, drawn only while the gesture that matched them is live.
    // They span the matched element AND the thing being dragged, so the line
    // shows what it lined up WITH rather than crossing the whole board.
    for (const guide of matchedGuides) {
      const [x1, y1, x2, y2] =
        guide.axis === 'x'
          ? [guide.at, guide.from, guide.at, guide.to]
          : [guide.from, guide.at, guide.to, guide.at];
      parts.push(
        `<line class="wb-guide" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
          `stroke-width="${unit}"/>`,
      );
    }

    if (selectDrag?.kind === 'marquee') {
      const box = marqueeRect(selectDrag.start, selectDrag.current);
      parts.push(
        `<rect class="wb-marquee" x="${box.x}" y="${box.y}" width="${box.width}" ` +
          `height="${box.height}" stroke-width="${unit}" stroke-dasharray="${4 * unit} ${3 * unit}"/>`,
      );
    }

    const tool = options.getTool().tool;
    const selecting = tool === 'select' && selectDrag?.kind !== 'marquee';
    const connector = selecting ? singleConnector() : null;
    const box = scene && !connector ? selectionBounds(scene, selection) : null;
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
      if (selecting) {
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
    // A single connector gets its two ENDPOINT handles instead of a resize
    // box — stretching a line by its box is never what anyone means, moving
    // where it ends is. A filled handle is an attached end.
    if (connector) {
      const r = (HANDLE_SIZE * unit) / 2 + unit;
      for (const [x, y, attached] of [
        [connector.geom.x1 ?? 0, connector.geom.y1 ?? 0, connector.from !== null],
        [connector.geom.x2 ?? 0, connector.geom.y2 ?? 0, connector.to !== null],
      ] as const) {
        parts.push(
          `<circle class="wb-sel-end${attached ? ' wb-sel-end-attached' : ''}" ` +
            `cx="${x}" cy="${y}" r="${r}" stroke-width="${unit}"/>`,
        );
      }
    }
    // A single selected host shows its four ports faintly: an invitation to
    // start an arrow from one (so with the line tools in hand as well), and a
    // reminder of where one would land.
    const lineTool = tool === 'line' || tool === 'arrow';
    const host = (selecting || lineTool) && !connector ? singleHost() : null;
    if (host) {
      parts.push(...portMarkup(host, null, unit));
    }
    // The host a line end is about to attach to: every port, the chosen one
    // lit — or, for a `c` port, a ring where the end will land.
    if (hoverTarget && scene) {
      const element = resolveElement(scene, hoverTarget.ref);
      if (element) {
        parts.push(
          ...portMarkup(element, hoverTarget.port === 'c' ? null : hoverTarget.port, unit),
        );
        if (hoverTarget.port === 'c') {
          parts.push(portRing(hoverTarget.point, unit, true));
        }
      }
    }
    if (matchedPort) {
      parts.push(portRing(matchedPort, unit, true));
    }
    chromeGroup.innerHTML = parts.join('');
  }

  /** The four ports of `host`, `hot` (if any) drawn emphasised. */
  function portMarkup(host: SceneElement, hot: string | null, unit: number): string[] {
    const ports = portPoints(host);
    if (!ports) {
      return [];
    }
    return AXIS_PORTS.map((port) => portRing(ports[port], unit, port === hot));
  }

  function portRing(at: Point, unit: number, hot: boolean): string {
    const r = (hot ? 5 : 3.5) * unit;
    return (
      `<circle class="wb-port${hot ? ' wb-port-hot' : ''}" cx="${at.x}" cy="${at.y}" ` +
      `r="${r}" stroke-width="${unit}"/>`
    );
  }

  /** The one selected line/arrow, when the selection is exactly that. */
  function singleConnector(): LineShapeElement | null {
    if (!scene || selection.length !== 1) {
      return null;
    }
    const element = resolveElement(scene, selection[0]!);
    return element && isLineShape(element) ? element : null;
  }

  /** The one selected element that can host a connector, when there is exactly one. */
  function singleHost(): SceneElement | null {
    if (!scene || selection.length !== 1) {
      return null;
    }
    const element = resolveElement(scene, selection[0]!);
    return element && canHostConnector(element) ? element : null;
  }

  /**
   * The closure of `refs` over groups and label <-> host links — EVERY
   * selection the user makes passes through here (click, shift-click,
   * marquee, the context menu), which is the single mechanism that makes a
   * group move as one and a label follow its host. Connectors do NOT expand
   * (an arrow is not part of the box it points at); they follow by
   * `reconnect` instead.
   */
  function expanded(refs: readonly ElementRef[]): ElementRef[] {
    return scene ? expandSelection(scene, refs) : [...refs];
  }

  function setSelection(next: readonly ElementRef[]): void {
    selection = expanded(next);
    renderChrome();
    notifyState();
  }

  /**
   * Pan so `refs` are on screen — the board half of Split mode's link. It
   * moves NOTHING when they are already visible (`y: 'nearest'` in the source
   * pane's terms): the board must not lurch every time the caret crosses a
   * line in the other pane. Focus stays wherever it is; the user is typing.
   */
  function revealRefs(refs: readonly ElementRef[]): void {
    if (!scene || !stage || refs.length === 0) {
      return;
    }
    const bounds = selectionBounds(scene, refs);
    if (bounds === null) {
      return;
    }
    const visible = visibleSceneRect();
    if (
      bounds.x >= visible.x &&
      bounds.y >= visible.y &&
      bounds.x + bounds.width <= visible.x + visible.width &&
      bounds.y + bounds.height <= visible.y + visible.height
    ) {
      return;
    }
    const box = stage.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      return;
    }
    const centre = sceneToBoard({
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    });
    setView({
      ...view,
      x: box.width / 2 - centre.x * view.scale,
      y: box.height / 2 - centre.y * view.scale,
    });
  }

  /* -------------------------------- snapping ------------------------------ */

  /**
   * Remember what the gesture about to start may align to. Called once, at the
   * press: the candidates come from the drag's base document and the selection
   * cannot change mid-drag, so this is the only moment they can change.
   */
  function beginSnap(doc: SceneDoc | null, exclude: readonly ElementRef[]): void {
    gestureGuides = doc ? guideRects(doc, exclude) : [];
    gesturePorts = doc ? guidePorts(doc, exclude) : [];
    matchedGuides = [];
    matchedPort = null;
  }

  /**
   * The snapping rules in force right now. Alt turns them off wholesale; the
   * threshold is {@link SNAP_THRESHOLD} SCREEN pixels converted to scene units,
   * so the pull feels the same at every zoom while the grid, a property of the
   * drawing, does not.
   */
  function snapContext(): SnapContext {
    if (!scene || snapOff) {
      return NO_SNAP;
    }
    return {
      grid: gridOf(scene),
      guides: gestureGuides,
      ports: gesturePorts,
      threshold: SNAP_THRESHOLD * sceneUnitsPerPixel(),
      enabled: true,
    };
  }

  /**
   * Record what a snap matched — guide lines, a port, the host a connector end
   * is over — and redraw the chrome if any of it changed.
   */
  function showGuides(
    guides: readonly GuideLine[],
    port: Point | null = null,
    target: ConnectorTarget | null = null,
  ): void {
    const sameGuides =
      guides.length === matchedGuides.length &&
      guides.every((g, i) => {
        const was = matchedGuides[i]!;
        return g.axis === was.axis && g.at === was.at && g.from === was.from && g.to === was.to;
      });
    const samePort =
      port === matchedPort ||
      (port !== null &&
        matchedPort !== null &&
        port.x === matchedPort.x &&
        port.y === matchedPort.y);
    const sameTarget =
      target === hoverTarget ||
      (target !== null &&
        hoverTarget !== null &&
        target.port === hoverTarget.port &&
        target.ref.layerId === hoverTarget.ref.layerId &&
        target.ref.index === hoverTarget.ref.index &&
        target.point.x === hoverTarget.point.x &&
        target.point.y === hoverTarget.point.y);
    matchedGuides = guides;
    matchedPort = port;
    hoverTarget = target;
    if (!sameGuides || !samePort || !sameTarget) {
      renderChrome();
    }
  }

  /** Every gesture ends the same way: no guides, ports or candidates on screen. */
  function clearGuides(): void {
    if (matchedGuides.length > 0 || matchedPort !== null || hoverTarget !== null) {
      matchedGuides = [];
      matchedPort = null;
      hoverTarget = null;
      renderChrome();
    }
    gestureGuides = [];
    gesturePorts = [];
  }

  /* --------------------------------- editing ------------------------------ */

  /**
   * The selection last reported to {@link WhiteboardAdapterOptions.onSelectionChange}.
   * The check lives in `notifyState` rather than in `setSelection` because the
   * selection also changes without going through it — a render drops refs that
   * no longer exist, an external change clears it — and Split mode's link has
   * to hear about those too.
   */
  let notifiedSelection: readonly ElementRef[] = [];

  function notifyState(): void {
    options.onStateChange?.(publicState());
    if (options.onSelectionChange && !sameSelection(notifiedSelection, selection)) {
      notifiedSelection = selection;
      options.onSelectionChange(selection);
    }
  }

  function sameSelection(a: readonly ElementRef[], b: readonly ElementRef[]): boolean {
    return (
      a.length === b.length &&
      a.every((ref, i) => ref.layerId === b[i]!.layerId && ref.index === b[i]!.index)
    );
  }

  function publicState(): WhiteboardUiState {
    const layer = scene?.layers.find((l) => l.id === activeLayerId);
    return {
      canUndo: history?.canUndo() ?? false,
      canRedo: history?.canRedo() ?? false,
      layersOpen,
      activeLayerName: layer?.name ?? null,
      selectionCount: selection.length,
      selectionStyle: scene === null ? null : selectionStyle(scene, selection),
      grid: scene === null ? DEFAULT_GRID : gridOf(scene),
    };
  }

  /**
   * Make `next` the document: render it, and schedule the write-back. Pass
   * `record: false` for undo/redo, which move WITHIN the timeline rather than
   * extending it.
   */
  function commit(next: SceneDoc, record = true): void {
    // The scene we would serialize is a picture of text that has since been
    // edited into something we cannot read; writing it back would silently
    // discard whatever is being typed in the source pane. Refuse until the
    // text parses again — `staleMessage` on screen says why.
    if (staleMessage !== null) {
      return;
    }
    if (record) {
      next = settle(next);
      history?.push(next);
    }
    render(serializeWhiteboard(next), false);
    pendingPush = true;
    schedulePush();
    notifyState();
  }

  /**
   * The passes every RECORDED commit runs before the document becomes the
   * next snapshot: `reconnect` (re-aim every attached connector end at its
   * host's current outline) and then `relayoutLabels` (re-centre every label
   * on its host) — in that order, because a connector's label sits on its
   * routed path, which reconnect may have just moved. Each is a fixed point
   * on a document it has nothing to do to, so running them on every commit
   * costs nothing when nothing moved. Undo and redo skip this — a snapshot
   * was settled when it was recorded.
   */
  function settle(doc: SceneDoc): SceneDoc {
    return relayoutLabels(reconnect(doc));
  }

  /**
   * A snapshot on its way back out of the history, wearing the CURRENT grid.
   *
   * The stack holds whole documents, and the grid rides in the document, so a
   * plain undo would restore the grid the snapshot was taken with — turning
   * the dots back on (or off) as a side effect of undoing a stroke. Showing a
   * grid is not an edit, so it must not be undoable; carrying the live
   * settings across every restore is what makes that true. Nothing else in the
   * metadata gets this treatment, because nothing else is a view preference.
   */
  function restored(doc: SceneDoc): SceneDoc {
    return scene === null ? doc : carryGrid(doc, scene);
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
    snapOff = event.altKey;

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

    // A stale document (the source pane is mid-edit and does not parse) is
    // treated exactly like having no scene: you can still pan and zoom around
    // the last picture, but nothing may start an edit of it — see
    // `staleMessage`.
    if (!scene || staleMessage !== null || route === 'navigate') {
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
      // Text lands on the grid too — a column of labels that each start a
      // pixel off is the thing a grid exists to prevent.
      beginSnap(scene, []);
      const at = snapPoint(point, snapContext()).point;
      clearGuides();
      openTextEditor(at, null);
      event.preventDefault();
      return;
    }

    // Ink never snaps — a pen stroke pulled onto a lattice is not the stroke
    // anyone drew. Shapes do, and their guides are fixed for the whole drag.
    beginSnap(isShapeTool(tool) ? scene : null, []);
    // A line pressed on a shape starts ATTACHED to it, at the port the press
    // picked; the end is decided the same way on release (`elementFor`).
    const fromTarget =
      tool === 'line' || tool === 'arrow'
        ? connectorTarget(scene, point, PORT_SNAP_RADIUS * sceneUnitsPerPixel(), point)
        : null;
    const start = fromTarget
      ? fromTarget.point
      : isShapeTool(tool)
        ? snapPoint(point, snapContext()).point
        : point;
    const filter = createOneEuroFilter();
    gesture = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      tool,
      color: settings.color,
      width: settings.width,
      shapeStyle: {
        color: settings.color,
        width: settings.width,
        fill: settings.fill,
        dash: settings.dash,
        heads: settings.heads,
        route: settings.route,
      },
      constrained: event.shiftKey,
      fromTarget,
      toTarget: null,
      points: [filter(point, event.timeStamp)],
      filter,
      start,
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
    // Live, like Shift: Alt is reached for once you can see the snap pulling
    // something where you did not mean it to go.
    snapOff = event.altKey;

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
        gesture.constrained = event.shiftKey;
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
    snapOff = event.altKey;
    if (selectDrag && event.pointerId === selectDrag.pointerId) {
      finishSelectDrag(scenePoint(event));
    } else if (gesture && event.pointerId === gesture.pointerId) {
      gesture.constrained = event.shiftKey;
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
    // A single connector has endpoint handles, not a box: a press on one
    // starts moving that end (re-attaching it, or cutting it loose).
    const connector = singleConnector();
    if (connector) {
      const ref = selection[0]!;
      const ends = [
        ['from', { x: connector.geom.x1 ?? 0, y: connector.geom.y1 ?? 0 }],
        ['to', { x: connector.geom.x2 ?? 0, y: connector.geom.y2 ?? 0 }],
      ] as const;
      let grabbed: (typeof ends)[number] | null = null;
      let nearest = HANDLE_HIT_RADIUS * unit;
      for (const end of ends) {
        const d = Math.hypot(point.x - end[1].x, point.y - end[1].y);
        if (d <= nearest) {
          grabbed = end;
          nearest = d;
        }
      }
      if (grabbed) {
        beginSnap(scene, selection);
        selectDrag = {
          kind: 'endpoint',
          pointerId: event.pointerId,
          ref,
          end: grabbed[0],
          start: point,
          base: scene,
          moved: false,
        };
        return;
      }
    }
    const box = connector ? null : selectionBounds(scene, selection);
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
        beginSnap(scene, selection);
        selectDrag = {
          kind: 'resize',
          pointerId: event.pointerId,
          handle,
          start: point,
          from: outline,
          base: scene,
          moved: false,
          scaled: nonLabelRefs(scene, selection),
        };
        return;
      }
    }

    const hit = hitTest(scene, point, ERASER_RADIUS * unit)[0] ?? null;
    if (hit) {
      // Pressing on something already selected keeps the whole set — that is
      // what makes "drag the group" work.
      // Shift toggles the WHOLE unit the hit belongs to (its group, its
      // label or host): deselecting one member of a group would only see the
      // expansion put it straight back.
      const next = event.shiftKey
        ? hasRef(selection, hit)
          ? withoutRefs(selection, expanded([hit]))
          : toggleRef(selection, hit)
        : hasRef(selection, hit)
          ? selection
          : [hit];
      setSelection(next);
      // AFTER the selection settles: what is being dragged must never offer
      // itself as something to line up with.
      beginSnap(scene, selection);
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
      selection = expanded(
        drag.additive ? [...drag.base, ...inside.filter((ref) => !hasRef(drag.base, ref))] : inside,
      );
      renderChrome();
      notifyState();
      return;
    }
    if (selectDrag.kind === 'move') {
      const { dx, dy } = moveDelta(selectDrag, point);
      selectDrag.moved = selectDrag.moved || Math.abs(dx) > 0 || Math.abs(dy) > 0;
      // Re-derive from the drag's OWN starting document every frame, so the
      // move is one transform rather than an accumulating pile of them.
      render(serializeWhiteboard(moved(selectDrag.base, dx, dy)), false);
      return;
    }
    if (selectDrag.kind === 'endpoint') {
      selectDrag.moved = true;
      render(serializeWhiteboard(endpointFrame(selectDrag, point)), false);
      return;
    }
    const target = resizeTarget(selectDrag, point);
    selectDrag.moved = true;
    render(
      serializeWhiteboard(resized(selectDrag.base, selectDrag.scaled, selectDrag.from, target)),
      false,
    );
  }

  /**
   * How far a move drag actually moves: the raw delta, plus whatever snapping
   * adds. The SELECTION'S BOUNDS are what snaps — its edges and centre against
   * the guides, its top-left against the grid — not the pointer, because what
   * the user is lining up is the box they can see.
   */
  function moveDelta(
    drag: Extract<SelectDrag, { kind: 'move' }>,
    point: Point,
  ): { dx: number; dy: number } {
    let dx = point.x - drag.start.x;
    let dy = point.y - drag.start.y;
    const box = selectionBounds(drag.base, selection);
    if (box) {
      const snapped = snapRect({ ...box, x: box.x + dx, y: box.y + dy }, snapContext());
      dx += snapped.dx;
      dy += snapped.dy;
      showGuides(snapped.guides);
    }
    return { dx, dy };
  }

  /**
   * The box a resize drag is aiming at. The DRAGGED HANDLE is what snaps —
   * only on the axes it actually moves, so dragging the north edge cannot
   * summon a vertical guide it is not going to honour.
   */
  function resizeTarget(drag: Extract<SelectDrag, { kind: 'resize' }>, point: Point): Rect {
    const origin = handlePoint(drag.from, drag.handle);
    const raw = {
      x: origin.x + (point.x - drag.start.x),
      y: origin.y + (point.y - drag.start.y),
    };
    const horizontal = /[ew]/.test(drag.handle);
    const vertical = /[ns]/.test(drag.handle);
    const snapped = snapPoint(raw, snapContext());
    const at = {
      x: horizontal ? snapped.point.x : raw.x,
      y: vertical ? snapped.point.y : raw.y,
    };
    showGuides(snapped.guides.filter((guide) => (guide.axis === 'x' ? horizontal : vertical)));
    return resizeRect(drag.from, drag.handle, at.x - origin.x, at.y - origin.y, MIN_SELECTION_SIZE);
  }

  /**
   * A resize: scale everything but the labels, re-aim the connectors into
   * what moved, then re-centre the labels — `settle`, per frame, so arrows
   * and labels follow the box live rather than jumping on release.
   */
  function resized(base: SceneDoc, refs: readonly ElementRef[], from: Rect, to: Rect): SceneDoc {
    return settle(scaleElements(base, refs, from, to));
  }

  /** A move drag's frame: the translation, with the connectors following. */
  function moved(base: SceneDoc, dx: number, dy: number): SceneDoc {
    return reconnect(translateElements(base, selection, dx, dy));
  }

  /**
   * An endpoint drag's frame. Over a host the end attaches there (the pure
   * `setConnectorEnd` gives the host an id if it needs one and re-aims the
   * line); over open board it detaches and snaps like any other point. The
   * other end, when it is a `c` port, re-aims at wherever this one lands.
   */
  function endpointFrame(drag: Extract<SelectDrag, { kind: 'endpoint' }>, point: Point): SceneDoc {
    const element = resolveElement(drag.base, drag.ref);
    if (!element || !isLineShape(element)) {
      return drag.base;
    }
    const otherEnd = drag.end === 'from' ? element.to : element.from;
    const otherHostRef = otherEnd ? findElementById(drag.base, otherEnd.id) : null;
    const otherHost = otherHostRef ? resolveElement(drag.base, otherHostRef) : null;
    const g = element.geom;
    const otherPoint =
      drag.end === 'from' ? { x: g.x2 ?? 0, y: g.y2 ?? 0 } : { x: g.x1 ?? 0, y: g.y1 ?? 0 };
    const aim = (otherHost && hostCentreOf(otherHost)) ?? otherPoint;
    const target = connectorTarget(drag.base, point, PORT_SNAP_RADIUS * sceneUnitsPerPixel(), aim, [
      drag.ref,
    ]);
    if (target) {
      showGuides([], null, target);
      return setConnectorEnd(drag.base, drag.ref, drag.end, target);
    }
    const snapped = snapPoint(point, snapContext());
    showGuides(snapped.guides, snapped.port, null);
    return setConnectorEnd(drag.base, drag.ref, drag.end, snapped.point);
  }

  /** `refs` minus labels whose host is alive — the part of a selection a resize scales. */
  function nonLabelRefs(doc: SceneDoc, refs: readonly ElementRef[]): ElementRef[] {
    return refs.filter((ref) => {
      const element = resolveElement(doc, ref);
      return !(element?.kind === 'text' && hostOf(doc, element) !== null);
    });
  }

  function finishSelectDrag(point: Point): void {
    const drag = selectDrag;
    selectDrag = null;
    if (!drag) {
      return;
    }
    if (drag.kind === 'marquee') {
      clearGuides();
      renderChrome();
      notifyState();
      return;
    }
    if (!drag.moved || !scene) {
      clearGuides();
      renderChrome();
      return;
    }
    // The board already SHOWS the result (every frame painted it); committing
    // is what makes it one undo step and schedules the write-back. The same
    // snapping the last frame applied is recomputed here, so what lands is
    // what was on screen.
    let next: SceneDoc;
    if (drag.kind === 'move') {
      const { dx, dy } = moveDelta(drag, point);
      next = moved(drag.base, dx, dy);
    } else if (drag.kind === 'endpoint') {
      next = endpointFrame(drag, point);
    } else {
      next = resized(drag.base, drag.scaled, drag.from, resizeTarget(drag, point));
    }
    clearGuides();
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
  function openTextEditor(
    at: Point,
    existing: ElementRef | null,
    host: ElementRef | null = null,
  ): void {
    if (!canvas || !scene) {
      return;
    }
    commitText();
    const settings = options.getTool();
    const current = existing ? resolveElement(scene, existing) : null;
    const element = current?.kind === 'text' ? current : null;
    const hostElement = host ? resolveElement(scene, host) : null;
    const fontSize = element ? element.fontSize : settings.fontSize;
    // A label edits CENTRED on its host: the box sits where the block will
    // be, growing both ways, so what you see typed is where the words land.
    // An orphan label (host gone) still edits centred on its own `x` — that
    // is how it renders, `text-anchor="middle"` and all.
    let anchor: TextEdit['anchor'] = 'start';
    let origin = element ? { x: element.x, y: element.y } : at;
    const liveHost = element ? hostOf(scene, element) : null;
    const liveHostElement = liveHost ? resolveElement(scene, liveHost) : null;
    if (liveHostElement && hostCentre(liveHostElement)) {
      anchor = 'middle';
      origin = hostCentre(liveHostElement)!;
    } else if (element && element.labelOf !== null) {
      anchor = 'middle';
      origin = { x: element.x, y: labelCentreY(element.y, fontSize, element.lines.length) };
    } else if (!element && hostElement && hostCentre(hostElement)) {
      anchor = 'middle';
      origin = hostCentre(hostElement)!;
    }
    textEdit = {
      at: origin,
      anchor,
      color: element ? element.fill : settings.color,
      // Reopening existing text adopts ITS type, so editing a label does not
      // silently restyle it to whatever the ribbon happens to say.
      fontSize,
      fontFamily: element ? element.fontFamily : settings.fontFamily,
      ref: element ? existing : null,
      host: element ? null : host,
    };

    const area = document.createElement('textarea');
    area.className = 'wb-text-input';
    area.spellcheck = false;
    area.rows = 1;
    area.value = element ? element.lines.join('\n') : '';
    area.addEventListener('pointerdown', (e) => e.stopPropagation());
    area.addEventListener('keydown', onTextKeyDown);
    area.addEventListener('blur', () => commitText());
    // A centred box moves its top as lines are added (the block stays centred
    // on the host), so an input re-runs the placement, not just the sizing.
    area.addEventListener('input', () => styleTextArea());
    // Editing EXISTING text sits on top of the glyphs it came from, so the box
    // paints the board colour behind itself; a new one stays transparent so
    // you can see what you are typing over.
    area.classList.toggle('wb-editing', element !== null);
    area.classList.toggle('wb-centred', anchor === 'middle');
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
    // For a label `at` is the block's centre: the first baseline is wherever
    // `labelBaseline` puts it for the lines typed so far — the same function
    // the committed `<text y>` comes from, so the two agree on screen.
    const lineCount = area.value.split('\n').length;
    const origin = sceneToBoard(
      edit.anchor === 'middle'
        ? { x: edit.at.x, y: labelBaseline(edit.at.y, edit.fontSize, lineCount) }
        : edit.at,
    );
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
    const typed = makeText(edit.at, area.value, edit.color, edit.fontSize, edit.fontFamily);
    // A centred block's first baseline depends on how many lines it has.
    const element: TextElement | null =
      typed && edit.anchor === 'middle'
        ? { ...typed, y: labelBaseline(edit.at.y, edit.fontSize, typed.lines.length) }
        : typed;
    if (edit.ref) {
      // Editing existing text: empty means delete it. What survives is the
      // element's IDENTITY — its id, its group, and which host it labels —
      // so retyping a label keeps it a label (and `settle` re-centres it).
      const current = resolveElement(scene, edit.ref);
      const kept =
        element && current?.kind === 'text'
          ? { ...element, id: current.id, group: current.group, labelOf: current.labelOf }
          : element;
      commit(kept ? replaceElement(scene, edit.ref, kept) : removeElements(scene, [edit.ref]));
      return;
    }
    if (!element) {
      return;
    }
    if (edit.host) {
      const attached = attachLabel(scene, edit.host, element);
      if (attached) {
        commit(attached.doc);
        return;
      }
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
    // Selection hit-tests a hollow shape on its OUTLINE (so ink drawn inside a
    // box stays pickable), but the empty inside of a box is exactly where a
    // label goes — so when nothing is on the outline, fall back to the topmost
    // body under the point, the same lookup a connector uses to find a host.
    const hit =
      hitTest(scene, point, ERASER_RADIUS * sceneUnitsPerPixel())[0] ??
      connectorTarget(scene, point, 0, point)?.ref ??
      null;
    const element = hit ? resolveElement(scene, hit) : null;
    if (!hit || !element) {
      return;
    }
    if (element.kind === 'text') {
      openTextEditor(point, hit);
      return;
    }
    // A shape (or picture): edit its label if it has one, else start one —
    // the box you double-click is the box you want words in.
    if (canHostLabel(element)) {
      const existing =
        element.kind !== 'raw' && element.id !== null ? labelsOf(scene, element.id) : [];
      if (existing.length > 0) {
        openTextEditor(point, existing[0]!);
      } else {
        openTextEditor(point, null, hit);
      }
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
    if (active.tool === 'line' || active.tool === 'arrow') {
      return connectorFor(active, end);
    }
    if (isShapeTool(active.tool)) {
      // Snap FIRST, constrain second. Shift is a promise about the shape ("this
      // is a square"), snapping is a promise about where it sits; a square that
      // is not square would be the worse lie, so the constraint gets the last
      // word and the snapped corner is only where the drag was aiming.
      const snapped = snapPoint(end, snapContext());
      showGuides(active.constrained ? [] : snapped.guides, snapped.port);
      const corner = active.constrained
        ? constrainShapeDrag(active.tool, active.start, snapped.point)
        : snapped.point;
      return makeShape(active.tool, active.start, corner, active.shapeStyle);
    }
    return null;
  }

  /**
   * The line/arrow a drag would produce if it ended at `end`, with either end
   * ATTACHED where it landed on a host. The host under the pointer wins over
   * snapping (you are pointing at the box, not at a grid line); a `c` port at
   * one end aims at the other end's host centre, exactly as `reconnect` will
   * once the line is committed, so the preview is the result. The end target
   * is remembered on the gesture for `finishGesture` to attach.
   */
  function connectorFor(active: Gesture, end: Point): SceneElement | null {
    if (!scene || !(active.tool === 'line' || active.tool === 'arrow')) {
      return null;
    }
    const fromHost = active.fromTarget ? resolveElement(scene, active.fromTarget.ref) : null;
    const aimFrom = (fromHost && hostCentreOf(fromHost)) ?? active.start;
    const toTarget = connectorTarget(
      scene,
      end,
      PORT_SNAP_RADIUS * sceneUnitsPerPixel(),
      aimFrom,
      active.fromTarget ? [active.fromTarget.ref] : [],
    );
    active.toTarget = toTarget;
    let endPoint: Point;
    if (toTarget) {
      showGuides([], null, toTarget);
      endPoint = toTarget.point;
    } else {
      const snapped = snapPoint(end, snapContext());
      showGuides(active.constrained ? [] : snapped.guides, snapped.port, null);
      endPoint = active.constrained
        ? constrainShapeDrag(active.tool, active.start, snapped.point)
        : snapped.point;
    }
    const toHost = toTarget ? resolveElement(scene, toTarget.ref) : null;
    const startPoint =
      active.fromTarget && fromHost
        ? (endpointOn(
            fromHost,
            active.fromTarget.port,
            (toHost && hostCentreOf(toHost)) ?? endPoint,
          ) ?? active.start)
        : active.start;
    const shape = makeShape(active.tool, startPoint, endPoint, active.shapeStyle);
    if (!shape) {
      return null;
    }
    // The preview carries the ports (an elbow routes by them); the ids are
    // placeholders — `attachConnector` assigns the real ones at commit.
    const idOf = (host: SceneElement | null): string =>
      host && host.kind !== 'raw' && host.id !== null ? host.id : '?';
    return {
      ...shape,
      from: active.fromTarget ? { id: idOf(fromHost), port: active.fromTarget.port } : null,
      to: toTarget ? { id: idOf(toHost), port: toTarget.port } : null,
    };
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
    // A host's labels go with it: a label with nothing to label is litter.
    // Its connectors stay, detached — an arrow is content of its own.
    gesture.working = removeAndDetach(gesture.working, withLabels(gesture.working, hits));
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
      clearGuides();
      return;
    }
    // Remember when a FINGER last put something down: if a pen lands in the
    // next breath, that mark was a palm and gets undone (input.ts).
    if (active.pointerType === 'touch') {
      lastTouchCommitAt = performance.now();
    }
    if (active.tool === 'eraser') {
      clearGuides();
      if (active.erased && active.working) {
        commit(active.working);
      }
      return;
    }
    const element = elementFor(active, end);
    clearGuides();
    if (!element) {
      return;
    }
    // A foreign SVG has only its locked "Imported" layer, so the first stroke
    // creates the layer it lands on — inside the same undo step.
    const target = ensureDrawLayer(scene, activeLayerId);
    activeLayerId = target.layerId;
    if (element.kind === 'shape' && (active.fromTarget || active.toTarget)) {
      // Attached where it landed: hosts get their ids, the ends are re-aimed
      // — the same document the preview showed, now with the links in it.
      commit(
        attachConnector(target.doc, target.layerId, element, active.fromTarget, active.toTarget),
      );
      return;
    }
    commit(addElement(target.doc, target.layerId, element));
  }

  function cancelGesture(): void {
    // A select drag has also been painting straight onto the board, so it
    // needs the same restore-from-the-last-commit treatment as an erase.
    const wasDragging = selectDrag !== null && selectDrag.kind !== 'marquee' && selectDrag.moved;
    selectDrag = null;
    clearGuides();
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
      if (event.altKey || event.shiftKey) {
        return;
      }
      // Bare-letter tool hotkeys (V, P, H, E, T, R, O, L, A). The textarea's
      // own keydown handler stops propagation, so typing never reaches here.
      const tool = toolForHotkey(event.key);
      if (tool !== null) {
        event.preventDefault();
        options.onToolHotkey?.(tool);
        adapter.refreshTool();
        return;
      }
      if (event.key.toLowerCase() === GRID_HOTKEY) {
        // Not a tool hotkey — it changes the document, not the next press —
        // which is why `TOOL_HOTKEYS` leaves G out and this is its own branch.
        event.preventDefault();
        if (scene) {
          adapter.setGrid({ show: !gridOf(scene).show });
        }
      }
      return;
    }
    // Ctrl+V is NOT here: the `paste` event carries the system clipboard's
    // text, which the keydown cannot read, so `onPaste` owns it.
    if (event.code === 'BracketRight' || event.code === 'BracketLeft') {
      // `code`, not `key`: with Shift held the key reports `}` / `{` on a US
      // layout and something else entirely on others.
      event.preventDefault();
      const forward = event.code === 'BracketRight';
      adapter.reorderSelection(
        event.shiftKey ? (forward ? 'front' : 'back') : forward ? 'forward' : 'backward',
      );
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 'a') {
      event.preventDefault();
      adapter.selectAll();
      return;
    }
    if (key === 'c') {
      event.preventDefault();
      adapter.copySelection();
      return;
    }
    if (key === 'x') {
      event.preventDefault();
      adapter.cutSelection();
      return;
    }
    if (key === 'd') {
      event.preventDefault();
      adapter.duplicateSelection();
      return;
    }
    if (key === 'g') {
      event.preventDefault();
      if (event.shiftKey) {
        adapter.ungroupSelection();
      } else {
        adapter.groupSelection();
      }
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

  /* ---------------------------------- scan -------------------------------- */

  /**
   * The scene rectangle currently on screen. A scan lands inside THIS rather
   * than at the board's origin: the user is looking somewhere, and a photo that
   * arrives off-screen reads as nothing having happened.
   */
  function visibleSceneRect(): Rect {
    const fallback: Rect = scene
      ? {
          x: scene.viewBox[0],
          y: scene.viewBox[1],
          width: scene.viewBox[2],
          height: scene.viewBox[3],
        }
      : { x: 0, y: 0, width: 1000, height: 1000 };
    if (!stage || !scene) {
      return fallback;
    }
    const box = stage.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      return fallback;
    }
    const [vx, vy, vw, vh] = scene.viewBox;
    const unitX = vw / scene.width / view.scale;
    const unitY = vh / scene.height / view.scale;
    return {
      x: vx - (view.x * vw) / scene.width / view.scale,
      y: vy - (view.y * vh) / scene.height / view.scale,
      width: box.width * unitX,
      height: box.height * unitY,
    };
  }

  /** Add a scanned photo as its own layer, fitted into the current view. */
  function insertScan(result: ScanResult): void {
    if (!scene) {
      return;
    }
    const area = visibleSceneRect();
    // 84% of the view, so the board's edges stay visible and it is obvious the
    // photo is an object on the board rather than the board itself.
    const maxWidth = area.width * 0.84;
    const maxHeight = area.height * 0.84;
    const fit = Math.min(maxWidth / result.width, maxHeight / result.height);
    const width = result.width * fit;
    const height = result.height * fit;
    const element: SceneElement = {
      kind: 'image',
      id: null,
      group: null,
      x: area.x + (area.width - width) / 2,
      y: area.y + (area.height - height) / 2,
      width,
      height,
      href: result.dataUrl,
      opacity: null,
    };
    // One layer, one undo step — so a scan the user does not want is one
    // Ctrl+Z, or one "delete this layer", rather than a hunt.
    const added = addLayerWith(scene, nextLayerName(scene, 'Scan'), [element], 'scan');
    activeLayerId = added.layerId;
    selection = [];
    commit(added.doc);
  }

  /**
   * Add traced ink as EDITABLE STROKES on their own layer, fitted into the
   * current view. The transform is applied inside the element build (bake, no
   * transforms — I-format), and the size guard runs against the same geometry
   * the review previewed.
   */
  function insertScanStrokes(payload: ScanStrokesResult): void {
    if (!scene) {
      return;
    }
    const area = visibleSceneRect();
    const maxWidth = area.width * 0.84;
    const maxHeight = area.height * 0.84;
    const fit = Math.min(maxWidth / payload.trace.width, maxHeight / payload.trace.height);
    const fitted = fitScanElements(payload.trace, payload.colors, {
      remap: payload.remap,
      // The same ε the review previewed — what you saw is what lands.
      epsilonFactor: SCAN_SMOOTHING[payload.smoothing],
      transform: {
        scale: fit,
        dx: area.x + (area.width - payload.trace.width * fit) / 2,
        dy: area.y + (area.height - payload.trace.height * fit) / 2,
      },
    });
    // Strokes gain `wb:id` only inside scan layers — phase 7's OCR metadata
    // will point at these ids; drawn strokes stay id-free to keep files small.
    const elements = fitted.elements.map((element, index) => ({
      ...element,
      id: `s${index + 1}`,
    }));
    const added = addLayerWith(scene, nextLayerName(scene, 'Scan'), elements, 'scan');
    activeLayerId = added.layerId;
    selection = [];
    // Every element carries BOTH colourings (measured hex + theme slot); the
    // review's choice only sets how the DOCUMENT displays them. `themed: false`
    // documents have no mode to set and are left alone.
    const withMode = isThemed(added.doc)
      ? setColorMode(added.doc, payload.mode === 'themed' ? 'themed' : 'fixed')
      : added.doc;
    commit(withMode);
    if (fitted.reduced) {
      options.scan?.onNotice(
        'Dense board — the traced ink was simplified so the file stays a reasonable size.',
      );
    }

    // Phase 7: recognition patches in AFTER the strokes land (OCR never
    // blocks the scan). The fit transform is captured here because it cannot
    // be recomputed later — the view will have moved. The patch is
    // undo-INVISIBLE: `history.replace` swaps the current snapshot instead of
    // pushing, so undo steps over the annotation and redo restores it.
    const layerId = added.layerId;
    const transform = {
      scale: fit,
      dx: area.x + (area.width - payload.trace.width * fit) / 2,
      dy: area.y + (area.height - payload.trace.height * fit) / 2,
    };
    void payload.ocr.then((outcome) => {
      // Re-locate the layer against the CURRENT scene — the user may have
      // drawn, undone, deleted the layer, or reloaded the file meanwhile.
      if (!model || !scene) {
        return;
      }
      const patched = applyScanOcr(scene, layerId, outcome, transform);
      if (!patched) {
        return; // the scan layer is gone; drop the result
      }
      history?.replace(patched);
      commit(patched, false);
      if (outcome.status === 'ok') {
        const read = outcome.lines.filter((line) => line.text.length > 0).length;
        if (read > 0) {
          options.scan?.onNotice(
            `Recognized ${read} line${read === 1 ? '' : 's'} of text on the scan.`,
          );
        }
      }
    });
  }

  function ensureScanPanel(): ScanPanel | null {
    if (!options.scan || !root) {
      return null;
    }
    if (!scanPanel) {
      const config = options.scan;
      scanPanel = createScanPanel({
        capture: config.capture,
        pick: config.pick,
        onNotice: config.onNotice,
        onInsert: insertScan,
        onInsertStrokes: insertScanStrokes,
        onClose: () => stage?.focus({ preventScroll: true }),
        recognize: config.recognize,
        saveDebug: config.saveDebug ?? null,
        prefs: config.prefs ?? null,
        // The review's colour select starts where the open board already is —
        // re-read per open, since the mode toggle may have flipped it since.
        initialColorMode: () =>
          scene && isThemed(scene) && colorModeOf(scene) === 'fixed' ? 'true' : 'themed',
      });
      root.append(scanPanel.element);
    }
    return scanPanel;
  }

  /**
   * Paste, in priority order: a clipboard IMAGE goes to the scan screen
   * (skipping acquisition); text that parses as a whiteboard fragment lands
   * as elements; failing both, whatever the board clipboard holds — which is
   * what answers where the web view cannot read the system clipboard back.
   * Text pasted into the text editor is the textarea's own business.
   */
  function onPaste(event: ClipboardEvent): void {
    if (textArea && event.target === textArea) {
      return;
    }
    if (options.scan && !scanPanel?.isOpen()) {
      const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (file) {
        event.preventDefault();
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            adapter.startScan({ dataUrl: reader.result, width: 0, height: 0 });
          }
        };
        reader.readAsDataURL(file);
        return;
      }
    }
    if (pasteText(event.clipboardData?.getData('text/plain') ?? '')) {
      event.preventDefault();
    }
  }

  /**
   * Paste `text` if it is one of ours, else the board clipboard when `text`
   * is empty (unreadable) — but NOT when it is something else: prose copied
   * after the last board copy means the user moved on, and pasting stale
   * shapes over it would be a surprise. Returns whether anything landed.
   */
  function pasteText(text: string): boolean {
    if (!scene) {
      return false;
    }
    let clip = options.clipboard?.get() ?? null;
    if (text.trim().length > 0 && text !== clip?.fragment) {
      const parsed = parseFragment(text);
      if (parsed === null) {
        return false;
      }
      clip = { fragment: text, elements: parsed, pastes: 0 };
    }
    if (!clip) {
      return false;
    }
    commitText();
    const pastes = clip.pastes + 1;
    const placed = pasteElements(scene, clip.elements, activeLayerId, PASTE_OFFSET * pastes);
    options.clipboard?.set({ ...clip, pastes });
    activeLayerId = placed.layerId;
    // The refs are valid in the NEW document, which is what `render` checks
    // them against — set them first so the commit's render keeps them.
    selection = expandSelection(placed.doc, placed.refs);
    commit(placed.doc);
    return true;
  }

  /** The selection to both clipboards. Returns what was copied. */
  function copyToClipboards(): SceneElement[] {
    if (!scene || selection.length === 0) {
      return [];
    }
    const elements = copyElements(scene, selection);
    if (elements.length === 0) {
      return [];
    }
    const fragment = serializeFragment(elements);
    options.clipboard?.set({ fragment, elements, pastes: 0 });
    // Best effort: the system clipboard is a courtesy to other tools, and a
    // refusal (permissions, a headless view) must not make Ctrl+C fail.
    void getClipboard()
      .write(fragment)
      .catch(() => undefined);
    return elements;
  }

  /**
   * The right-click menu. Pressing on something not yet selected selects it
   * (the way every editor does), pressing on nothing clears the selection so
   * the menu is honest about what it will act on. `preventDefault` here is
   * what tells the app-wide guard that this surface owns the right-click.
   */
  function onContextMenu(event: MouseEvent): void {
    // Every item on the menu is an edit, and a stale board refuses those.
    if (!scene || staleMessage !== null) {
      return;
    }
    event.preventDefault();
    commitText();
    const point = scenePoint(event);
    const hit = hitTest(scene, point, ERASER_RADIUS * sceneUnitsPerPixel())[0] ?? null;
    if (hit && !hasRef(selection, hit)) {
      setSelection([hit]);
    } else if (!hit) {
      setSelection([]);
    }
    openContextMenu(contextMenuItems(), event.clientX, event.clientY, () =>
      stage?.focus({ preventScroll: true }),
    );
  }

  /**
   * What the menu offers, enabled from the pure predicates. THE extension
   * point for later work: the connector items (route, Detach) live here too.
   */
  function contextMenuItems(): ContextMenuItem[] {
    const doc = scene;
    const some = doc !== null && selection.length > 0;
    const chord = (keys: string): string => `${MOD_LABEL}+${keys}`;
    const items: ContextMenuItem[] = [
      { label: 'Cut', chord: chord('X'), disabled: !some, onSelect: () => adapter.cutSelection() },
      {
        label: 'Copy',
        chord: chord('C'),
        disabled: !some,
        onSelect: () => adapter.copySelection(),
      },
      { label: 'Paste', chord: chord('V'), onSelect: () => adapter.pasteClipboard() },
      {
        label: 'Duplicate',
        chord: chord('D'),
        disabled: !some,
        onSelect: () => adapter.duplicateSelection(),
      },
      'separator',
    ];
    const zChords: Record<ZOrderOp, string> = {
      front: chord('Shift+]'),
      forward: chord(']'),
      backward: chord('['),
      back: chord('Shift+['),
    };
    for (const op of ['front', 'forward', 'backward', 'back'] as const) {
      items.push({
        label: Z_ORDER_LABELS[op],
        chord: zChords[op],
        disabled: !some,
        onSelect: () => adapter.reorderSelection(op),
      });
    }
    items.push('separator');
    const alignable = doc !== null && canAlign(doc, selection);
    for (const edge of ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const) {
      items.push({
        label: ALIGN_LABELS[edge],
        disabled: !alignable,
        onSelect: () => adapter.alignSelection(edge),
      });
    }
    const distributable = doc !== null && canDistribute(doc, selection);
    for (const axis of ['horizontal', 'vertical'] as const) {
      items.push({
        label: DISTRIBUTE_LABELS[axis],
        disabled: !distributable,
        onSelect: () => adapter.distributeSelection(axis),
      });
    }
    items.push(
      'separator',
      {
        label: 'Group',
        chord: chord('G'),
        disabled: !canGroup(selection),
        onSelect: () => adapter.groupSelection(),
      },
      {
        label: 'Ungroup',
        chord: chord('Shift+G'),
        disabled: doc === null || !canUngroup(doc, selection),
        onSelect: () => adapter.ungroupSelection(),
      },
    );
    // Connectors: the route (the same choice the ribbon's style menu offers,
    // here because a right-click on an arrow is where people look for it) and
    // Detach, which cuts the links and leaves the line where it is.
    const style = doc === null ? null : selectionStyle(doc, selection);
    const lines = style?.hasLine ?? false;
    items.push('separator');
    for (const route of ['straight', 'elbow'] as const) {
      items.push({
        label: ROUTE_LABELS[route],
        disabled: !lines,
        checked: lines && style?.route === route,
        onSelect: () => adapter.restyleSelection({ route }),
      });
    }
    items.push({
      label: 'Detach connector',
      disabled: doc === null || !canDetach(doc, selection),
      onSelect: () => adapter.detachSelection(),
    });
    // Split mode only: the explicit half of the raw ⇄ draw link. The passive
    // highlight already shows where this element is written; this one takes
    // the caret and the focus there, which is what you want before editing it.
    if (options.onRevealInSource) {
      items.push('separator', {
        label: 'Reveal in source',
        disabled: !some,
        onSelect: () => options.onRevealInSource?.(selection),
      });
    }
    items.push('separator', {
      label: 'Delete',
      chord: 'Del',
      disabled: !some,
      onSelect: () => adapter.deleteSelection(),
    });
    return items;
  }

  /**
   * A file dropped onto the board. Tauri intercepts OS file drags before the
   * webview sees them (HTML5 `drop` never fires), so main.tsx hit-tests its
   * physical cursor position, finds the `data-drop-scan` stage and dispatches
   * this — the same shape the explorer's drop targets use.
   */
  function onDropPhoto(event: Event): void {
    const detail = (event as CustomEvent<{ dataUrl?: string }>).detail;
    if (typeof detail?.dataUrl === 'string') {
      adapter.startScan({ dataUrl: detail.dataUrl, width: 0, height: 0 });
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

  /* --------------------------------- adapter ------------------------------ */

  const adapter: WhiteboardAdapter = {
    getScene: () => scene,
    uiState: publicState,
    getSelection: () => selection,

    selectRefs(refs, reveal = false) {
      if (!scene) {
        return;
      }
      setSelection(validRefs(scene, refs));
      if (reveal) {
        revealRefs(selection);
      }
    },

    undo() {
      if (history?.canUndo()) {
        // Indices move under a selection when elements come back or go away,
        // so stepping through the timeline drops it rather than pointing it at
        // whatever now happens to sit at those positions.
        selection = [];
        commit(restored(history.undo()), false);
      }
    },

    redo() {
      if (history?.canRedo()) {
        selection = [];
        commit(restored(history.redo()), false);
      }
    },

    abortGesture() {
      cancelGesture();
    },

    deleteSelection() {
      if (!scene || selection.length === 0) {
        return;
      }
      // The selection is already expanded (labels ride with hosts), and
      // `withLabels` makes the promise explicit for a host whose label sits
      // on a layer expansion could not reach. Connectors into a deleted host
      // are DETACHED, not deleted: they were drawn on purpose too.
      const next = removeAndDetach(scene, withLabels(scene, selection));
      selection = [];
      commit(next);
    },

    detachSelection() {
      if (scene) {
        const next = detachElements(scene, selection);
        if (next !== scene) {
          commit(next);
        }
      }
    },

    copySelection() {
      copyToClipboards();
    },

    cutSelection() {
      if (copyToClipboards().length > 0) {
        adapter.deleteSelection();
      }
    },

    pasteClipboard() {
      // The menu path has no ClipboardEvent, so ask the system clipboard —
      // through the IPC seam, which is what works on WebKitGTK — and fall
      // back to the board clipboard when it has nothing of ours.
      void getClipboard()
        .read()
        .catch(() => '')
        .then((text) => {
          pasteText(text);
        });
    },

    duplicateSelection() {
      if (!scene || selection.length === 0) {
        return;
      }
      const placed = pasteElements(
        scene,
        copyElements(scene, selection),
        activeLayerId,
        PASTE_OFFSET,
      );
      activeLayerId = placed.layerId;
      selection = expandSelection(placed.doc, placed.refs);
      commit(placed.doc);
    },

    reorderSelection(op) {
      if (!scene || selection.length === 0) {
        return;
      }
      const result = reorderElements(scene, selection, op);
      if (result.doc === scene) {
        return;
      }
      selection = result.refs;
      commit(result.doc);
    },

    alignSelection(edge) {
      if (scene) {
        const next = alignElements(scene, selection, edge);
        if (next !== scene) {
          commit(next);
        }
      }
    },

    distributeSelection(axis) {
      if (scene) {
        const next = distributeElements(scene, selection, axis);
        if (next !== scene) {
          commit(next);
        }
      }
    },

    groupSelection() {
      if (scene) {
        const next = groupElements(scene, selection);
        if (next !== scene) {
          commit(next);
        }
      }
    },

    ungroupSelection() {
      if (scene) {
        const next = ungroupElements(scene, selection);
        if (next !== scene) {
          commit(next);
        }
      }
    },

    selectAll() {
      if (scene) {
        setSelection(allSelectable(scene));
      }
    },

    canScan: () => options.scan !== undefined,

    startScan(source) {
      const panel = ensureScanPanel();
      if (!panel) {
        return;
      }
      // Whatever was being typed or dragged is finished first: the scan screen
      // covers the board, and coming back to a half-drawn stroke is worse than
      // losing it.
      commitText();
      cancelGesture();
      panel.open(source ?? (options.scan?.capture ? 'camera' : 'picker'));
    },

    refreshTool() {
      if (stage) {
        stage.dataset.tool = options.getTool().tool;
      }
      renderChrome();
    },

    restyleSelection(patch) {
      if (!scene || selection.length === 0) {
        return;
      }
      // Refs survive a restyle (elements are replaced in place), so the
      // selection — and the box around it — stay exactly where they were, and
      // `commit`'s own re-render reports the new style back to the ribbon.
      commit(restyleElements(scene, selection, patch));
    },

    setGrid(patch) {
      if (!scene) {
        return;
      }
      const next = setDocGrid(scene, patch);
      if (next === scene) {
        return;
      }
      // `record: false` — no undo step. `history.replace` keeps the timeline's
      // CURRENT entry in step so an undo-then-redo doesn't resurrect the old
      // setting either; older snapshots are handled by `restored`.
      history?.replace(next);
      commit(next, false);
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

      // Both colourings live in every saved element; this flips which one the
      // document DISPLAYS (`colorMode` metadata + the root `wb-fixed` token) —
      // an ordinary, undoable edit that never recolours an element.
      colorModeButton = button('◐', 'Switch between theme colours and true colours', () =>
        withScene((doc) => setColorMode(doc, colorModeOf(doc) === 'fixed' ? 'themed' : 'fixed')),
      );

      const controls = document.createElement('div');
      controls.className = 'wb-controls';
      controls.append(
        button('▤', 'Layers', () => adapter.toggleLayers()),
        pageButton,
        colorModeButton,
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
      stage.addEventListener('contextmenu', onContextMenu);
      stage.addEventListener('paste', onPaste);
      if (options.scan) {
        // OS drag-drop lands a photo straight on the crop screen (paste does
        // too, via `onPaste`). `data-drop-scan` is what main.tsx hit-tests,
        // exactly like the explorer's `data-drop-dir`.
        stage.dataset.dropScan = '';
        stage.addEventListener('wb-drop-photo', onDropPhoto);
      }

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
        stage.removeEventListener('contextmenu', onContextMenu);
        stage.removeEventListener('paste', onPaste);
        stage.removeEventListener('wb-drop-photo', onDropPhoto);
      }
      scanPanel?.destroy();
      scanPanel = null;
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
      staleMessage = null;
      notifiedSelection = [];
      root?.remove();
      root = null;
      stage = null;
      canvas = null;
      live = null;
      zoomLabel = null;
      pageButton = null;
      colorModeButton = null;
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
