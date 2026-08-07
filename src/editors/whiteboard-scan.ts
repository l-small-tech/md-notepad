/**
 * whiteboard-scan.ts — the scan screen (phase 4: S0 acquire + S1 rectify;
 * phase 5: S2–S4 clean + colour; phase 6: S5 vectorize + S7 review).
 *
 * Photograph a physical whiteboard, correct the perspective, flat-field the
 * lighting out, extract the ink, vote its colours, then TRACE it into the
 * same editable strokes the pen draws — that is the primary insert; the
 * cleaned raster and the straightened photo stay available as fallbacks.
 * Phase 7 adds recognized text on top of the same screen.
 *
 * This file, with `whiteboard.ts` and `whiteboard-layers.ts`, is the only DOM in
 * the whiteboard stack. Everything that DECIDES anything — where the board is,
 * what shape it really is, which source pixel each output pixel comes from —
 * lives in `core/whiteboard/scan/` under Vitest. What is left here is genuinely
 * DOM-only work: decoding an image, encoding a JPEG, and a crop UI.
 *
 * ## Why the corners are always draggable
 *
 * Detection is a heuristic and will be wrong sometimes — a poster on the wall, a
 * window, a board that runs off the frame. The Drive scanner's actual trick is
 * not perfect detection, it is that correcting a bad guess costs one drag. So
 * the quad is always shown, always draggable, and `source: 'frame'` says plainly
 * when nothing board-shaped was found rather than pretending.
 *
 * ## Why the warp is banded
 *
 * A 1800 px rectify is ~3.2 M bilinear samples. Run in one loop that is a
 * second of frozen UI on a tablet and a progress bar that only ever reads 0%
 * then 100%. `createRectifier` hands back a resumable job; this file pumps it
 * from `requestAnimationFrame` and can therefore also cancel it.
 */

import { detectBoardQuad, frameQuad, orderQuad } from '../core/whiteboard/scan/quad';
import { createRectifier } from '../core/whiteboard/scan/pipeline';
import {
  DIAGRAM_ZOOM_STEP,
  fitDiagramView,
  panDiagram,
  zoomDiagramAt,
  type DiagramView,
} from '../core/diagram-zoom';
import {
  composeCleaned,
  composeRemovedDebug,
  createCleaner,
  DEFAULT_SCAN_COLOR_MODE,
  GLARE_HINT_FRACTION,
  type CleanResult,
  type ScanColorMode,
} from '../core/whiteboard/scan/clean';
import {
  SCAN_PALETTE,
  type ColorAssignment,
  type ComponentColor,
  type MarkerColor,
} from '../core/whiteboard/scan/color';
import {
  createTracer,
  fitScanElements,
  IDENTITY_TRANSFORM,
  MAX_SCAN_STROKES,
  type ScanElements,
  type TraceResult,
} from '../core/whiteboard/scan/trace';
import { PALETTE } from '../core/whiteboard/tool-settings';
import {
  attachRasterLines,
  linesFromLayout,
  ocrPlainText,
  type ScanOcrOutcome,
  type ScanRecognizeFn,
  type ScanRecognizeRequest,
  type ScanRecognizeResponse,
} from '../core/whiteboard/scan/ocr';
import {
  elementInk,
  groupTextLines,
  layoutItemsFromTrace,
} from '../core/whiteboard/scan/text-layout';
import { rotate90 } from '../core/whiteboard/scan/image-ops';
import {
  DEFAULT_SCAN_PRESET,
  DEFAULT_SCAN_SMOOTHING,
  SCAN_SMOOTHING,
  type Quad,
  type RgbaImage,
  type ScanPoint,
  type ScanPreset,
  type ScanSmoothing,
} from '../core/whiteboard/scan/types';

/** A photo handed to the scan screen: a `data:` URL and its pixel size. */
export interface ScanPhoto {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** The rectified board, ready to become an `<image>` element. */
export interface ScanResult {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The traced board, ready to become EDITABLE STROKES. Deliberately not the
 * elements themselves: the adapter knows where the current view is, so it owns
 * the pixel→scene transform and calls `fitScanElements` with it — the same
 * build (including the size guard) the preview ran, at the real destination.
 */
export interface ScanStrokesResult {
  readonly trace: TraceResult;
  readonly colors: ColorAssignment;
  /** The review's display choice — the adapter stores it as the document's
   *  `colorMode`. The elements themselves always carry BOTH colourings. */
  readonly mode: ScanColorMode;
  readonly remap: ReadonlyMap<MarkerColor, MarkerColor>;
  /** Trace simplification chosen on the review screen — the adapter's
   *  `fitScanElements` must build with the same ε the preview showed. */
  readonly smoothing: ScanSmoothing;
  /**
   * The recognition outcome, possibly still in flight — OCR NEVER blocks the
   * scan (plan S6): strokes insert first and the adapter patches the layer's
   * `<desc>` / hidden text / metadata when this resolves. Always settles
   * (unavailable platforms resolve `{ status: 'unavailable' }`).
   */
  readonly ocr: Promise<ScanOcrOutcome>;
}

/**
 * One artifact of a debug dump. Text for the SVG, base64 for the images —
 * exactly the two write primitives every storage backend has.
 */
export interface ScanDebugFile {
  readonly name: string;
  readonly kind: 'text' | 'base64';
  readonly data: string;
}

/** The scan panel's remembered tuning — preset and smoothing survive sessions. */
export interface ScanPrefs {
  readonly preset: ScanPreset;
  readonly smoothing: ScanSmoothing;
}

export interface ScanPanelOptions {
  /** Take a photo with the device camera. Null where there is no camera. */
  readonly capture: (() => Promise<ScanPhoto>) | null;
  /** Choose an image file. Null where there is no picker (Android uses the
   *  camera; a file arrives by paste there instead). */
  readonly pick: (() => Promise<ScanPhoto | null>) | null;
  /** Insert the rectified board. The panel closes itself first. */
  readonly onInsert: (result: ScanResult) => void;
  /** Insert the traced board as editable strokes (the phase-6 primary). */
  readonly onInsertStrokes: (result: ScanStrokesResult) => void;
  /**
   * What the scan produces. `'board'` (default) traces the ink and inserts
   * into the open drawing. `'image'` stops after cleaning — one less step: no
   * tracing, no OCR — and offers only the raster results, which `onInsert`
   * then saves as a standalone image file instead of embedding in a board.
   */
  readonly output?: 'board' | 'image';
  /** The panel is finished with (cancelled, or inserted). */
  readonly onClose: () => void;
  /** Surface a message to the user (permission denied, decode failure, …). */
  readonly onNotice: (message: string) => void;
  /** This platform's text recognizer (src/ui/scan-ocr.ts), or null where none
   *  exists — the scan then records `"status": "unavailable"`. */
  readonly recognize: ScanRecognizeFn | null;
  /**
   * Write the scan's intermediate artifacts (source photo, straightened photo,
   * cleaned raster, traced SVG) into a fresh folder for later analysis, and
   * resolve with that folder. Injected because choosing WHERE is a workspace
   * question, not an editor one. Null hides the Debug insert button.
   */
  readonly saveDebug: ((files: readonly ScanDebugFile[]) => Promise<string | null>) | null;
  /**
   * Last-used preset + smoothing, read on open and written on change.
   * Injected (EditorHost owns the settings store — I9 keeps editors off it);
   * null forgets between opens and falls back to the defaults.
   */
  readonly prefs?: {
    readonly get: () => ScanPrefs;
    readonly set: (prefs: ScanPrefs) => void;
  } | null;
  /**
   * The open document's current colour mode, re-read on every open, so the
   * review screen's colour select starts where the board already is (the
   * insert writes the choice back as the document's `colorMode`). Board
   * output only; omitted, the default applies.
   */
  readonly initialColorMode?: (() => ScanColorMode) | null;
}

/** How the panel is opened. A `ScanPhoto` skips acquisition (paste / drop). */
export type ScanSource = 'camera' | 'picker' | ScanPhoto;

export interface ScanPanel {
  readonly element: HTMLElement;
  open(source: ScanSource): void;
  /** True while the panel is on screen — the adapter routes Escape to it. */
  isOpen(): boolean;
  close(): void;
  destroy(): void;
}

/** Quality preset labels, in the order the picker shows them. */
const PRESET_LABELS: readonly (readonly [ScanPreset, string])[] = [
  ['fast', 'Fast'],
  ['balanced', 'Balanced'],
  ['detailed', 'Detailed'],
];

/** JPEG quality for the inserted photo. Higher is not visibly better here and
 *  the bytes land inside the `.svg`, which the session flusher then carries. */
const OUTPUT_QUALITY = 0.7;

/** Warn above this — an embedded photo inflates the document string. */
const LARGE_RESULT_BYTES = 2_000_000;

/** Corner handle radius in CSS pixels; also the grab distance. */
const HANDLE_RADIUS = 16;

/* ============================== image helpers ============================== */

/** `data:<mime>;base64,<payload>` → the bytes, without touching the network. */
function decodeDataUrl(dataUrl: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  const binary = atob(match[2]!);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return { mime: match[1]!, bytes };
}

/**
 * Decode a `data:` URL into raw RGBA.
 *
 * Via a `Blob` and `createImageBitmap`, NOT a `blob:` URL: the app CSP is
 * `default-src 'self'; img-src 'self' data:`, and fetching a `blob:` URL is a
 * connect-src request, which is blocked. An `<img src="data:…">` is the
 * fallback, and that one the CSP does permit.
 */
async function decodeImage(dataUrl: string): Promise<RgbaImage | null> {
  const decoded = decodeDataUrl(dataUrl);
  let width = 0;
  let height = 0;
  let source: CanvasImageSource | null = null;

  if (decoded && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(
        new Blob([decoded.bytes as unknown as BlobPart], { type: decoded.mime }),
      );
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    } catch {
      source = null;
    }
  }
  if (!source) {
    const image = await loadImageElement(dataUrl);
    if (!image) {
      return null;
    }
    source = image;
    width = image.naturalWidth;
    height = image.naturalHeight;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    return null;
  }
  context.drawImage(source, 0, 0);
  if (source instanceof ImageBitmap) {
    source.close();
  }
  const pixels = context.getImageData(0, 0, width, height);
  return { width, height, data: pixels.data };
}

function loadImageElement(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

/** Raw RGBA → a PNG `data:` URL — flat colour on white compresses far
 *  better as PNG than JPEG, and PNG has no ringing haloes around ink. */
function encodePng(image: RgbaImage): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.putImageData(toImageData(image), 0, 0);
  return canvas.toDataURL('image/png');
}

/** Raw RGBA → a JPEG `data:` URL. */
function encodeJpeg(image: RgbaImage, quality: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.putImageData(toImageData(image), 0, 0);
  return canvas.toDataURL('image/jpeg', quality);
}

/**
 * Wrap raw pixels as an `ImageData`. The cast is TypeScript's, not ours:
 * `Uint8ClampedArray` is generic over its buffer since TS 5.7 and `ImageData`
 * insists on a plain `ArrayBuffer`, while `getImageData` hands back the
 * `ArrayBufferLike` form. Nothing here ever sees a SharedArrayBuffer.
 */
function toImageData(image: RgbaImage): ImageData {
  return new ImageData(image.data as Uint8ClampedArray<ArrayBuffer>, image.width, image.height);
}

/** Draw an RgbaImage into a canvas, sizing the canvas to match. */
function paint(canvas: HTMLCanvasElement, image: RgbaImage): void {
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')?.putImageData(toImageData(image), 0, 0);
}

function hexTriple(hex: string): readonly [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * The RESOLVED app-theme ink colour per scan bucket. Each canonical scan hex
 * is a drawing-palette slot; the theme's actual colour for that slot lives in
 * `--wb-cN` (often a `color-mix()`, which `getPropertyValue` will not
 * resolve) — so probe it through a real element's `color`, which the browser
 * must resolve to plain rgb.
 */
function resolveThemedTriples(
  host: HTMLElement,
): Map<MarkerColor, readonly [number, number, number]> {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.append(probe);
  const resolved = new Map<MarkerColor, readonly [number, number, number]>();
  for (const [bucket, hex] of Object.entries(SCAN_PALETTE) as [MarkerColor, string][]) {
    const slot = PALETTE.indexOf(hex);
    probe.style.color = slot >= 0 ? `var(--wb-c${slot}, ${hex})` : hex;
    const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(probe).color);
    resolved.set(
      bucket,
      match ? [Number(match[1]), Number(match[2]), Number(match[3])] : hexTriple(hex),
    );
  }
  probe.remove();
  return resolved;
}

function resolveThemedInk(
  host: HTMLElement,
): (color: ComponentColor) => readonly [number, number, number] {
  const resolved = resolveThemedTriples(host);
  return (color) => resolved.get(color.bucket) ?? hexTriple(color.snapped);
}

/** Palette SLOT → the resolved app-theme CSS colour (for the canvas). */
function resolveThemedCssBySlot(host: HTMLElement): Map<number, string> {
  const out = new Map<number, string>();
  for (const [bucket, triple] of resolveThemedTriples(host)) {
    const slot = PALETTE.indexOf(SCAN_PALETTE[bucket]);
    if (slot >= 0) {
      out.set(slot, `rgb(${triple[0]}, ${triple[1]}, ${triple[2]})`);
    }
  }
  return out;
}

/* ================================= the panel ============================== */

type Stage = 'idle' | 'acquiring' | 'crop' | 'working' | 'review';

export function createScanPanel(options: ScanPanelOptions): ScanPanel {
  /** Image output: stop after cleaning and save a file — never trace. */
  const imageOutput = options.output === 'image';
  const element = document.createElement('div');
  element.className = 'wb-scan';
  element.hidden = true;
  // Focusable so the panel — not the board behind it — owns Escape while it is
  // up. The board's own keydown listener sits on the stage, which is a sibling,
  // so nothing here bubbles to it.
  element.tabIndex = -1;
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  let stage: Stage = 'idle';
  /** The photo as taken (before rotation), so Retake-less rotation is free. */
  let photo: RgbaImage | null = null;
  /** The acquired photo EXACTLY as it arrived — the camera's own JPEG, before
   *  decode, rotation or rectification. Only the debug dump wants this. */
  let sourcePhoto: ScanPhoto | null = null;
  let quad: Quad | null = null;
  let detectedSource: 'detected' | 'frame' = 'frame';
  let preset: ScanPreset = options.prefs?.get().preset ?? DEFAULT_SCAN_PRESET;
  /** Trace simplification strength; affects traced strokes, never the raster. */
  let smoothing: ScanSmoothing = options.prefs?.get().smoothing ?? DEFAULT_SCAN_SMOOTHING;
  let rectified: RgbaImage | null = null;
  /** The phase-5 pipeline output (ink components + colours), once cleaned. */
  let cleaned: CleanResult | null = null;
  /** The phase-6 pipeline output (centerlines + contours), once traced. */
  let traced: TraceResult | null = null;
  /** Review-screen colour remap: original bucket → replacement. */
  const remap = new Map<MarkerColor, MarkerColor>();
  /** The identity-transform build shown in the vector preview, cached per
   *  (mode, remap) so toggling views is free. */
  let builtCache: { key: string; built: ScanElements } | null = null;
  /** Which colours the review paints ink in — a DISPLAY choice: the build
   *  carries both colourings and the insert stores both, so this only decides
   *  the document's initial `colorMode`. Themed is the default on a board
   *  (seeded from the open document's own mode when the adapter supplies it);
   *  a standalone image file defaults to true colours — it is a document, and
   *  themed ink on a transparent sheet belongs to the theme it was saved in. */
  let colorMode: ScanColorMode = imageOutput
    ? 'true'
    : (options.initialColorMode?.() ?? DEFAULT_SCAN_COLOR_MODE);
  /** What the review screen is showing. Strokes are the deliverable, so they
   *  are what the user judges first. */
  let reviewView: 'vector' | 'cleaned' | 'photo' = 'vector';
  /** The settled recognition outcome, once it arrives (adds the Copy button). */
  let ocrOutcome: ScanOcrOutcome | null = null;
  /** The in-flight recognition — captured into the insert payload so the
   *  adapter can patch the layer when it settles, even after the panel closes. */
  let ocrPromise: Promise<ScanOcrOutcome> | null = null;
  /**
   * The review preview's zoom/pan, in the same `translate·scale` form the board
   * itself uses (`core/diagram-zoom.ts`). Inspecting whether the tracer got a
   * word right needs pixels, and the fitted preview is a 1800 px board squeezed
   * into a tablet pane — so the preview zooms, by pinch, wheel or double-tap.
   */
  let previewView: DiagramView = { scale: 1, x: 0, y: 0 };
  /** Live preview pointers (fingers / a dragging mouse), for pan + pinch. */
  const previewPointers = new Map<number, ScanPoint>();
  let previewPinch = 0;
  /** Set whenever a NEW image reaches the review screen; re-renders that merely
   *  recolour or toggle views keep whatever the user was looking at. */
  let previewNeedsFit = true;
  /** The band-pumping rAF handle, so cancel really cancels. */
  let pumping: number | null = null;
  /** Bumped on every close/retake; an in-flight acquire checks it before
   *  taking over the panel, so a cancelled capture cannot reopen it. */
  let generation = 0;

  /* ------------------------------- chrome -------------------------------- */

  const title = document.createElement('h2');
  title.className = 'wb-scan-title';

  const hint = document.createElement('p');
  hint.className = 'wb-scan-hint';

  const viewport = document.createElement('div');
  viewport.className = 'wb-scan-viewport';

  const photoCanvas = document.createElement('canvas');
  photoCanvas.className = 'wb-scan-photo';

  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlay.setAttribute('class', 'wb-scan-overlay');

  const loupe = document.createElement('canvas');
  loupe.className = 'wb-scan-loupe';
  loupe.width = 132;
  loupe.height = 132;
  loupe.hidden = true;

  const progress = document.createElement('div');
  progress.className = 'wb-scan-progress';
  const progressBar = document.createElement('div');
  progressBar.className = 'wb-scan-progress-bar';
  progress.append(progressBar);
  progress.hidden = true;

  viewport.append(photoCanvas, overlay, loupe, progress);

  const actions = document.createElement('div');
  actions.className = 'wb-scan-actions';

  element.append(title, hint, viewport, actions);

  function button(label: string, title_: string, onClick: () => void, primary = false) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = primary ? 'wb-scan-btn is-primary' : 'wb-scan-btn';
    node.textContent = label;
    node.title = title_;
    node.addEventListener('click', onClick);
    return node;
  }

  const presetSelect = document.createElement('select');
  presetSelect.className = 'wb-scan-select';
  presetSelect.title = 'Output resolution — Detailed keeps small handwriting legible';
  presetSelect.setAttribute('aria-label', 'Scan quality');
  for (const [value, label] of PRESET_LABELS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    presetSelect.append(option);
  }
  presetSelect.value = preset;
  presetSelect.addEventListener('change', () => {
    preset = (presetSelect.value as ScanPreset) ?? DEFAULT_SCAN_PRESET;
    savePrefs();
  });

  function savePrefs(): void {
    options.prefs?.set({ preset, smoothing });
  }

  /** Colour handling for the cleaned board. Themed first — it is the default. */
  const COLOR_MODE_LABELS: readonly (readonly [ScanColorMode, string])[] = [
    ['themed', 'Theme colours'],
    ['true', 'True colours'],
  ];

  const colorSelect = document.createElement('select');
  colorSelect.className = 'wb-scan-select';
  colorSelect.title =
    'How the result DISPLAYS — both colourings are always saved in the file, so this ' +
    'can be flipped later without re-scanning. Theme colours snap ink to the marker ' +
    'palette and follow themes; true colours show what the markers actually looked like.';
  colorSelect.setAttribute('aria-label', 'Ink colours');
  for (const [value, label] of COLOR_MODE_LABELS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    colorSelect.append(option);
  }
  colorSelect.value = colorMode;
  colorSelect.addEventListener('change', () => {
    colorMode = (colorSelect.value as ScanColorMode) ?? DEFAULT_SCAN_COLOR_MODE;
    // No cache invalidation: the build carries BOTH colours (measured hex +
    // theme slot); the mode only decides which one the preview paints.
    if (stage === 'review' && reviewView !== 'photo') {
      showReview();
    }
  });

  /** Trace simplification for the review's stroke build. Standard first. */
  const SMOOTHING_LABELS: readonly (readonly [ScanSmoothing, string])[] = [
    ['precise', 'Precise'],
    ['standard', 'Standard'],
    ['simplified', 'Simplified'],
  ];

  const smoothingSelect = document.createElement('select');
  smoothingSelect.className = 'wb-scan-select';
  smoothingSelect.title =
    'How much the traced strokes are simplified — Precise keeps small handwriting detail, ' +
    'Simplified straightens long diagram lines. Affects traced strokes, not the cleaned image.';
  smoothingSelect.setAttribute('aria-label', 'Stroke smoothing');
  for (const [value, label] of SMOOTHING_LABELS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    smoothingSelect.append(option);
  }
  smoothingSelect.value = smoothing;
  smoothingSelect.addEventListener('change', () => {
    smoothing = (smoothingSelect.value as ScanSmoothing) ?? DEFAULT_SCAN_SMOOTHING;
    savePrefs();
    builtCache = null;
    if (stage === 'review' && reviewView === 'vector') {
      showReview();
    }
  });

  /** The colour remap chips — one per detected colour, with its mark count. */
  const colorsRow = document.createElement('div');
  colorsRow.className = 'wb-scan-colors';
  colorsRow.hidden = true;
  element.insertBefore(colorsRow, actions);

  const BUCKET_LABELS: Readonly<Record<MarkerColor, string>> = {
    black: 'Black',
    red: 'Red',
    orange: 'Orange',
    yellow: 'Yellow',
    green: 'Green',
    teal: 'Teal',
    blue: 'Blue',
    purple: 'Purple',
  };

  /**
   * One chip per DETECTED colour: a swatch plus a select of all eight marker
   * colours. Choosing another colour remaps every mark of this one — which is
   * also how merging works ("teal → blue"), and the escape hatch when a dying
   * marker was genuinely ambiguous (plan risk 9).
   */
  function renderColorChips(): void {
    if (!cleaned || cleaned.colors.tallies.length === 0) {
      colorsRow.hidden = true;
      colorsRow.replaceChildren();
      return;
    }
    const chips: HTMLElement[] = [];
    for (const tally of cleaned.colors.tallies) {
      const chip = document.createElement('label');
      chip.className = 'wb-scan-chip';
      chip.title =
        `${tally.count} mark${tally.count === 1 ? '' : 's'} detected as ${BUCKET_LABELS[tally.bucket].toLowerCase()}` +
        ' — pick another colour to remap them';
      const swatch = document.createElement('span');
      swatch.className = 'wb-scan-chip-swatch';
      const current = remap.get(tally.bucket) ?? tally.bucket;
      swatch.style.background = SCAN_PALETTE[current];
      const count = document.createElement('span');
      count.className = 'wb-scan-chip-count';
      count.textContent = `×${tally.count}`;
      const select = document.createElement('select');
      select.className = 'wb-scan-chip-select';
      select.setAttribute('aria-label', `Colour for ${tally.count} ${tally.bucket} marks`);
      for (const [bucket, label] of Object.entries(BUCKET_LABELS) as [MarkerColor, string][]) {
        const option = document.createElement('option');
        option.value = bucket;
        option.textContent = bucket === tally.bucket ? `${label}` : label;
        select.append(option);
      }
      select.value = current;
      select.addEventListener('change', () => {
        const target = (select.value as MarkerColor) ?? tally.bucket;
        if (target === tally.bucket) {
          remap.delete(tally.bucket);
        } else {
          remap.set(tally.bucket, target);
        }
        builtCache = null;
        if (stage === 'review') {
          showReview();
        }
      });
      chip.append(swatch, select, count);
      chips.push(chip);
    }
    colorsRow.replaceChildren(...chips);
    colorsRow.hidden = false;
  }

  /* ------------------------------ crop drawing ---------------------------- */

  /** Displayed size of the photo, and where it sits inside the viewport. */
  function layout(): { scale: number; left: number; top: number } | null {
    if (!photo) {
      return null;
    }
    const box = viewport.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) {
      return null;
    }
    const scale = Math.min(box.width / photo.width, box.height / photo.height);
    return {
      scale,
      left: (box.width - photo.width * scale) / 2,
      top: (box.height - photo.height * scale) / 2,
    };
  }

  /** Image coordinates → viewport CSS pixels. */
  function toDisplay(p: ScanPoint): ScanPoint {
    const l = layout();
    return l ? { x: l.left + p.x * l.scale, y: l.top + p.y * l.scale } : p;
  }

  /** Viewport CSS pixels → image coordinates, clamped to the photo. */
  function toImage(x: number, y: number): ScanPoint {
    const l = layout();
    if (!l || !photo) {
      return { x, y };
    }
    return {
      x: Math.max(0, Math.min(photo.width, (x - l.left) / l.scale)),
      y: Math.max(0, Math.min(photo.height, (y - l.top) / l.scale)),
    };
  }

  function renderCrop(): void {
    const l = layout();
    if (!l || !photo || !quad) {
      return;
    }
    // The crop screen positions the photo itself; the review screen's zoom
    // transform must not survive into it.
    photoCanvas.style.transform = '';
    photoCanvas.style.imageRendering = 'auto';
    photoCanvas.style.width = `${photo.width * l.scale}px`;
    photoCanvas.style.height = `${photo.height * l.scale}px`;
    photoCanvas.style.left = `${l.left}px`;
    photoCanvas.style.top = `${l.top}px`;

    const box = viewport.getBoundingClientRect();
    overlay.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    overlay.setAttribute('width', String(box.width));
    overlay.setAttribute('height', String(box.height));
    const points = quad.map(toDisplay);
    const path = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const handles = points
      .map(
        (p, i) =>
          `<circle class="wb-scan-handle" data-corner="${i}" cx="${p.x.toFixed(1)}" ` +
          `cy="${p.y.toFixed(1)}" r="${HANDLE_RADIUS}"/>`,
      )
      .join('');
    overlay.innerHTML = `<polygon class="wb-scan-quad" points="${path}"/>${handles}`;
  }

  /**
   * The magnifier. A finger covers the corner it is placing, which is exactly
   * the corner that needs to be placed precisely — so show the pixels under it
   * somewhere else, at 3×.
   */
  function renderLoupe(corner: ScanPoint, at: ScanPoint): void {
    if (!photo) {
      return;
    }
    const zoom = 3;
    const size = loupe.width;
    const context = loupe.getContext('2d');
    if (!context) {
      return;
    }
    const span = size / zoom;
    const sx = Math.round(corner.x - span / 2);
    const sy = Math.round(corner.y - span / 2);
    context.clearRect(0, 0, size, size);
    context.imageSmoothingEnabled = false;
    context.drawImage(photoCanvas, sx, sy, span, span, 0, 0, size, size);
    // Crosshair on the exact corner position.
    context.strokeStyle = '#ff3b30';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(size / 2, size / 2 - 12);
    context.lineTo(size / 2, size / 2 + 12);
    context.moveTo(size / 2 - 12, size / 2);
    context.lineTo(size / 2 + 12, size / 2);
    context.stroke();
    // Sit the loupe on the opposite side of the finger, and never off-screen.
    const box = viewport.getBoundingClientRect();
    const left = at.x > box.width / 2 ? at.x - size - 40 : at.x + 40;
    const top = Math.max(8, Math.min(box.height - size - 8, at.y - size / 2));
    loupe.style.left = `${Math.max(8, Math.min(box.width - size - 8, left))}px`;
    loupe.style.top = `${top}px`;
    loupe.hidden = false;
  }

  /* ---------------------------- preview zoom / pan ------------------------ */

  /**
   * Push {@link previewView} onto the canvas. The canvas keeps its natural
   * pixel size in CSS pixels and everything else is one composited transform
   * with origin 0 0 — the same shape as the board's own viewport, so a pinch
   * here behaves exactly like a pinch there, and zooming never re-rasterizes.
   */
  function applyPreviewView(): void {
    photoCanvas.style.left = '0px';
    photoCanvas.style.top = '0px';
    photoCanvas.style.width = `${photoCanvas.width}px`;
    photoCanvas.style.height = `${photoCanvas.height}px`;
    photoCanvas.style.transformOrigin = '0 0';
    // Past 1:1 the question is "what exactly did the tracer draw here", so show
    // the real pixels; below it, smoothing is what makes a fitted board legible.
    photoCanvas.style.imageRendering = previewView.scale > 1 ? 'pixelated' : 'auto';
    photoCanvas.style.transform =
      `translate(${previewView.x.toFixed(2)}px, ${previewView.y.toFixed(2)}px) ` +
      `scale(${previewView.scale.toFixed(4)})`;
  }

  /** Whole board, centered — the review screen's starting point and its
   *  double-tap reset. */
  function fitPreview(): void {
    const box = viewport.getBoundingClientRect();
    previewView = fitDiagramView(photoCanvas.width, photoCanvas.height, box.width, box.height);
    applyPreviewView();
  }

  function previewSpread(): number {
    const [a, b] = [...previewPointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  function previewMidpoint(): ScanPoint {
    const [a, b] = [...previewPointers.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : { x: 0, y: 0 };
  }

  function viewportPoint(event: PointerEvent | WheelEvent): ScanPoint {
    const box = viewport.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  function onPreviewPointerDown(event: PointerEvent): void {
    previewPointers.set(event.pointerId, viewportPoint(event));
    previewPinch = previewPointers.size === 2 ? previewSpread() : 0;
    viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function onPreviewPointerMove(event: PointerEvent): void {
    const previous = previewPointers.get(event.pointerId);
    if (!previous) {
      return;
    }
    const current = viewportPoint(event);
    previewPointers.set(event.pointerId, current);
    if (previewPointers.size === 1) {
      previewView = panDiagram(previewView, current.x - previous.x, current.y - previous.y);
    } else if (previewPointers.size === 2) {
      // Zoom about the midpoint, so whatever sits between the fingers — the
      // word being checked — stays between them.
      const distance = previewSpread();
      if (previewPinch > 0 && distance > 0) {
        const centre = previewMidpoint();
        previewView = zoomDiagramAt(previewView, distance / previewPinch, centre.x, centre.y);
      }
      previewPinch = distance;
    }
    applyPreviewView();
    event.preventDefault();
  }

  function onPreviewPointerUp(event: PointerEvent): void {
    previewPointers.delete(event.pointerId);
    previewPinch = previewPointers.size === 2 ? previewSpread() : 0;
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
  }

  function onWheel(event: WheelEvent): void {
    if (stage !== 'review' || event.deltaY === 0) {
      return;
    }
    event.preventDefault();
    const at = viewportPoint(event);
    const factor = event.deltaY < 0 ? DIAGRAM_ZOOM_STEP : 1 / DIAGRAM_ZOOM_STEP;
    previewView = zoomDiagramAt(previewView, factor, at.x, at.y);
    applyPreviewView();
  }

  function onDoubleClick(): void {
    if (stage === 'review') {
      fitPreview();
    }
  }

  /* ------------------------------ crop gestures --------------------------- */

  let dragging: number | null = null;

  function onPointerDown(event: PointerEvent): void {
    if (stage === 'review') {
      onPreviewPointerDown(event);
      return;
    }
    if (stage !== 'crop' || !quad) {
      return;
    }
    const box = viewport.getBoundingClientRect();
    const at = { x: event.clientX - box.left, y: event.clientY - box.top };
    let nearest = -1;
    let best = HANDLE_RADIUS * 2;
    quad.forEach((corner, index) => {
      const p = toDisplay(corner);
      const distance = Math.hypot(p.x - at.x, p.y - at.y);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    });
    if (nearest < 0) {
      return;
    }
    dragging = nearest;
    viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
    renderLoupe(quad[nearest]!, at);
  }

  function onPointerMove(event: PointerEvent): void {
    if (stage === 'review') {
      onPreviewPointerMove(event);
      return;
    }
    if (dragging === null || !quad) {
      return;
    }
    const box = viewport.getBoundingClientRect();
    const at = { x: event.clientX - box.left, y: event.clientY - box.top };
    const moved = toImage(at.x, at.y);
    const next = [...quad] as unknown as ScanPoint[];
    next[dragging] = moved;
    quad = next as unknown as Quad;
    renderCrop();
    renderLoupe(moved, at);
    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent): void {
    // Unconditional: a pointer that went down on the review screen must be
    // released even if the panel has since moved on to another stage.
    if (previewPointers.size > 0) {
      onPreviewPointerUp(event);
    }
    if (dragging === null) {
      return;
    }
    dragging = null;
    loupe.hidden = true;
    if (viewport.hasPointerCapture(event.pointerId)) {
      viewport.releasePointerCapture(event.pointerId);
    }
    // Re-canonicalize once the drag ENDS, not during it: reordering mid-drag
    // would swap which corner the finger is holding out from under it.
    if (quad) {
      quad = orderQuad(quad);
      renderCrop();
    }
  }

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerUp);
  // Not passive: wheel-zoom has to stop the gesture from scrolling the pane.
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('dblclick', onDoubleClick);

  const resizeObserver = new ResizeObserver(() => {
    if (stage === 'crop') {
      renderCrop();
    } else if (stage === 'review') {
      // A rotated tablet gets the whole board back rather than a view that
      // now points at the wrong part of it.
      fitPreview();
    }
  });
  resizeObserver.observe(viewport);

  /* ------------------------------- the stages ----------------------------- */

  function setActions(...nodes: (HTMLElement | null)[]): void {
    actions.replaceChildren(...nodes.filter((n): n is HTMLElement => n !== null));
  }

  /**
   * The panel's heading. Passing `null` hides it entirely — which is what the
   * review screen does when there is nothing wrong: on a tablet those two
   * paragraphs cost a fifth of the pane, and the pane is the whole point of
   * the review screen. Warnings still get to speak.
   */
  function setHeader(titleText: string | null, hintText: string | null): void {
    title.hidden = titleText === null;
    title.textContent = titleText ?? '';
    hint.hidden = hintText === null;
    hint.textContent = hintText ?? '';
  }

  function showAcquiring(message: string): void {
    stage = 'acquiring';
    setHeader('Scan a whiteboard', message);
    photoCanvas.hidden = true;
    overlay.innerHTML = '';
    progress.hidden = true;
    loupe.hidden = true;
    setActions(button('Cancel', 'Cancel the scan', close));
  }

  function showCrop(): void {
    if (!photo) {
      return;
    }
    stage = 'crop';
    previewNeedsFit = true;
    previewPointers.clear();
    previewPinch = 0;
    rectified = null;
    cleaned = null;
    traced = null;
    builtCache = null;
    remap.clear();
    colorsRow.hidden = true;
    setHeader(
      'Frame the board',
      detectedSource === 'detected'
        ? 'Drag the corners if the outline missed the board.'
        : 'No board edges stood out — drag the corners onto the board.',
    );
    viewport.title = '';
    photoCanvas.hidden = false;
    progress.hidden = true;
    paint(photoCanvas, photo);
    renderCrop();
    setActions(
      button('Rotate', 'Rotate the photo a quarter turn', rotatePhoto),
      button('Whole image', 'Use the entire photo, uncropped', useWholeImage),
      options.capture || options.pick
        ? button('Retake', 'Take or choose another photo', retake)
        : null,
      presetSelect,
      button('Cancel', 'Cancel the scan', close),
      button('Continue', 'Straighten the board', startRectify, true),
    );
  }

  function rotatePhoto(): void {
    if (!photo) {
      return;
    }
    photo = rotate90(photo);
    // Re-detect rather than rotating the quad: a fresh detection on the
    // upright image is both simpler and usually better than the old guess.
    const detection = detectBoardQuad(photo);
    quad = detection.quad;
    detectedSource = detection.source;
    showCrop();
  }

  function useWholeImage(): void {
    if (!photo) {
      return;
    }
    quad = frameQuad(photo.width, photo.height);
    renderCrop();
  }

  function retake(): void {
    const source: ScanSource = options.capture ? 'camera' : 'picker';
    photo = null;
    quad = null;
    open(source);
  }

  function startRectify(): void {
    if (!photo || !quad) {
      return;
    }
    const job = createRectifier(photo, quad, preset);
    if (!job) {
      options.onNotice('Those corners do not make a quadrilateral — drag them apart.');
      return;
    }
    stage = 'working';
    setHeader('Straightening…', `${job.plan.width} × ${job.plan.height} px`);
    overlay.innerHTML = '';
    loupe.hidden = true;
    progress.hidden = false;
    progressBar.style.width = '0%';
    setActions(button('Cancel', 'Stop and go back to the crop', cancelRectify));

    const pump = () => {
      pumping = null;
      if (stage !== 'working') {
        return;
      }
      // One band per frame: enough work to finish a 1800 px board in about a
      // second, little enough that the cancel button still responds.
      const start = performance.now();
      while (!job.done && performance.now() - start < 12) {
        job.step();
      }
      progressBar.style.width = `${Math.round((job.progress / job.plan.height) * 100)}%`;
      if (!job.done) {
        pumping = requestAnimationFrame(pump);
        return;
      }
      rectified = job.result();
      startClean();
    };
    pumping = requestAnimationFrame(pump);
  }

  /**
   * Phase 5: flat-field the light out, extract the ink, vote the colours.
   * One pipeline stage per frame — each stage is a bounded pass over typed
   * arrays, so the bar advances honestly and Cancel lands between stages.
   */
  function startClean(): void {
    if (!rectified) {
      showCrop();
      return;
    }
    const job = createCleaner(rectified);
    stage = 'working';
    setHeader('Cleaning…', 'Removing shadows, glare and eraser ghosts');
    progress.hidden = false;
    progressBar.style.width = '0%';
    setActions(button('Cancel', 'Stop and go back to the crop', cancelRectify));

    const pump = () => {
      pumping = null;
      if (stage !== 'working') {
        return;
      }
      job.step();
      progressBar.style.width = `${Math.round(job.progress * 100)}%`;
      if (!job.done) {
        pumping = requestAnimationFrame(pump);
        return;
      }
      cleaned = job.result();
      if (imageOutput) {
        // Image output stops here — one less step: no tracing, no OCR. The
        // review offers the cleaned board and the straightened photo only.
        reviewView = (cleaned?.extraction.components.length ?? 0) > 0 ? 'cleaned' : 'photo';
        showReview();
      } else {
        startTrace();
      }
    };
    pumping = requestAnimationFrame(pump);
  }

  /**
   * Phase 6: thin, walk and fit every ink component into editable strokes.
   * Same pump shape as the rectifier — a step is one bounded batch of
   * components, so the bar moves and Cancel lands between batches.
   */
  function startTrace(): void {
    if (!cleaned || cleaned.extraction.components.length === 0) {
      reviewView = cleaned ? 'cleaned' : 'photo';
      showReview();
      return;
    }
    const job = createTracer(cleaned);
    stage = 'working';
    setHeader('Tracing…', 'Turning the ink into editable strokes');
    progress.hidden = false;
    progressBar.style.width = '0%';
    setActions(button('Cancel', 'Stop and go back to the crop', cancelRectify));

    const pump = () => {
      pumping = null;
      if (stage !== 'working') {
        return;
      }
      const start = performance.now();
      while (!job.done && performance.now() - start < 12) {
        job.step();
      }
      progressBar.style.width = `${Math.round(job.progress * 100)}%`;
      if (!job.done) {
        pumping = requestAnimationFrame(pump);
        return;
      }
      traced = job.result();
      builtCache = null;
      reviewView = 'vector';
      startOcr();
      showReview();
    };
    pumping = requestAnimationFrame(pump);
  }

  /**
   * Phase 7: kick recognition off the moment the trace exists — it runs
   * while the user reviews, so "Copy text" is usually ready by the time they
   * look for it, and an insert that beats it still patches in later (the
   * promise rides the payload). Everything that DECIDES here — line grouping,
   * zipping engine answers back onto geometry — is core (`text-layout.ts`,
   * `ocr.ts`); this function only wires it to the injected engine.
   */
  function startOcr(): void {
    ocrOutcome = null;
    ocrPromise = null;
    if (!traced || !cleaned) {
      return;
    }
    const recognize = options.recognize;
    if (!recognize) {
      ocrOutcome = { status: 'unavailable' };
      ocrPromise = Promise.resolve(ocrOutcome);
      return;
    }
    const mine = generation;
    const clean = cleaned;
    const items = layoutItemsFromTrace(traced);
    const layout = groupTextLines(items, traced.strokeWidth);
    const ink = elementInk(traced);
    const round1 = (value: number): number => Math.round(value * 10) / 10;
    const request: ScanRecognizeRequest = {
      lines: layout.lines.map((line) => ({
        strokes: line.items.flatMap((index) =>
          (ink[index] ?? []).map((path) => path.map((p) => [round1(p.x), round1(p.y)] as const)),
        ),
        area: {
          width: Math.max(1, Math.round(line.bbox.width)),
          height: Math.max(1, Math.round(line.bbox.height)),
        },
      })),
      // Black ink on white for the raster engines — maximum contrast, and the
      // engine's boxes come back in this image's own (rectified) pixels.
      png: async () => {
        const composed = composeCleaned(clean, 'true', {
          background: 'white',
          inkFor: () => [0, 0, 0],
        });
        const dataUrl = encodePng(composed);
        return dataUrl ? dataUrl.slice(dataUrl.indexOf(',') + 1) : null;
      },
    };
    ocrPromise = (async (): Promise<ScanOcrOutcome> => {
      const response = await recognize(request).catch((error): ScanRecognizeResponse => ({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      }));
      const timestamp = new Date().toISOString();
      let outcome: ScanOcrOutcome;
      switch (response.kind) {
        case 'ink':
          outcome = {
            status: 'ok',
            engine: response.engine,
            timestamp,
            lines: linesFromLayout(layout.lines, response.texts),
          };
          break;
        case 'raster':
          outcome = {
            status: 'ok',
            engine: response.engine,
            timestamp,
            lines: attachRasterLines(response.lines, items),
          };
          break;
        case 'unavailable':
          outcome = { status: 'unavailable' };
          break;
        case 'error':
          outcome = { status: 'error', message: response.message };
          break;
      }
      if (mine === generation) {
        ocrOutcome = outcome;
        if (stage === 'review') {
          showReview(); // the Copy button appears in place
        }
      }
      return outcome;
    })();
  }

  function copyRecognizedText(): void {
    if (ocrOutcome?.status !== 'ok') {
      return;
    }
    void navigator.clipboard.writeText(ocrPlainText(ocrOutcome.lines)).then(
      () => options.onNotice('Recognized text copied to the clipboard.'),
      () => options.onNotice('Could not access the clipboard.'),
    );
  }

  /** The identity-space build the preview shows — cached per (smoothing,
   *  remap). Colour is DUAL-EMITTED by the build (measured hex + theme slot),
   *  so the colour-mode toggle repaints without rebuilding. */
  function ensureBuilt(): ScanElements | null {
    if (!traced || !cleaned) {
      return null;
    }
    const key = `${smoothing}|${[...remap.entries()]
      .map(([from, to]) => `${from}>${to}`)
      .sort()
      .join(',')}`;
    if (builtCache?.key !== key) {
      builtCache = {
        key,
        built: fitScanElements(traced, cleaned.colors, {
          remap,
          transform: IDENTITY_TRANSFORM,
          epsilonFactor: SCAN_SMOOTHING[smoothing],
        }),
      };
    }
    return builtCache.built;
  }

  /**
   * Paint the traced strokes onto the review canvas. `Path2D` accepts the
   * elements' own `d` verbatim, so the preview IS the geometry that will land
   * in the file; themed ink resolves through the app palette exactly like the
   * board it will sit on.
   */
  function renderVectorPreview(built: ScanElements): void {
    if (!rectified) {
      return;
    }
    photoCanvas.width = rectified.width;
    photoCanvas.height = rectified.height;
    const context = photoCanvas.getContext('2d');
    if (!context) {
      return;
    }
    context.clearRect(0, 0, photoCanvas.width, photoCanvas.height);
    const themed = colorMode === 'themed';
    if (!themed) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, photoCanvas.width, photoCanvas.height);
    }
    const resolved = themed ? resolveThemedCssBySlot(element) : null;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const stroke of built.elements) {
      const path = new Path2D(stroke.d);
      // Dual colours: `stroke.stroke` is the measured (true) hex; the theme
      // identity is the stored slot, or derived when the hex IS a palette one.
      const slot = stroke.slot ?? PALETTE.indexOf(stroke.stroke);
      const css = (slot >= 0 ? resolved?.get(slot) : undefined) ?? stroke.stroke;
      if (stroke.tool === 'scanfill') {
        context.fillStyle = css;
        context.fill(path, 'evenodd');
      } else {
        context.strokeStyle = css;
        context.lineWidth = stroke.strokeWidth;
        context.stroke(path);
      }
    }
  }

  function cancelRectify(): void {
    if (pumping !== null) {
      cancelAnimationFrame(pumping);
      pumping = null;
    }
    showCrop();
  }

  function showReview(): void {
    if (!rectified) {
      showCrop();
      return;
    }
    stage = 'review';
    progress.hidden = true;
    overlay.innerHTML = '';

    // Only offer what exists: no trace → no vector view; no ink → photo only.
    if (reviewView === 'vector' && traced === null) {
      reviewView =
        cleaned !== null && cleaned.extraction.components.length > 0 ? 'cleaned' : 'photo';
    }
    if (reviewView === 'cleaned' && cleaned === null) {
      reviewView = 'photo';
    }

    const built = reviewView === 'vector' ? ensureBuilt() : null;
    if (built !== null) {
      renderVectorPreview(built);
    } else {
      paint(
        photoCanvas,
        reviewView === 'cleaned' && cleaned !== null ? composeCleanedForDisplay() : rectified,
      );
    }
    // Themed ink sits on a TRANSPARENT sheet; showing the board surface
    // behind it is what makes the preview honest.
    photoCanvas.style.background =
      reviewView !== 'photo' && colorMode === 'themed' ? 'var(--wb-bg, #ffffff)' : '';
    // A new image fits; a recolour or a view toggle keeps the zoom the user
    // set — they are usually comparing the same detail across views.
    if (previewNeedsFit) {
      previewNeedsFit = false;
      fitPreview();
    } else {
      applyPreviewView();
    }
    viewport.title = 'Pinch or scroll to zoom, drag to pan, double-tap to fit';

    // No heading here: the buttons say what they do and the warnings, when
    // there are any, say the rest. The pane belongs to the board.
    const warnings = reviewWarnings(built);
    setHeader(warnings.length > 0 ? 'Check the scan' : null, warnings.join(' — ') || null);
    if (reviewView !== 'photo' && cleaned !== null) {
      renderColorChips();
    } else {
      colorsRow.hidden = true;
    }

    const hasInk = cleaned !== null && cleaned.extraction.components.length > 0;
    const hasStrokes = traced !== null && traced.components.length > 0;
    const VIEW_LABELS = { vector: 'strokes', cleaned: 'cleaned', photo: 'photo' } as const;
    const order: (typeof reviewView)[] = ['vector', 'cleaned', 'photo'];
    const available = order.filter(
      (view) =>
        view === 'photo' || (view === 'cleaned' && hasInk) || (view === 'vector' && hasStrokes),
    );
    const next = available[(available.indexOf(reviewView) + 1) % available.length]!;
    const summary = reviewSummary(built);

    setActions(
      button('Back', 'Adjust the crop', showCrop),
      available.length > 1
        ? button(
            `Show ${VIEW_LABELS[next]}`,
            imageOutput
              ? 'Compare the cleaned board and the straightened photo'
              : 'Compare the traced strokes, the cleaned board and the straightened photo',
            () => {
              reviewView = next;
              showReview();
            },
          )
        : null,
      reviewView !== 'photo' ? colorSelect : null,
      reviewView === 'vector' ? smoothingSelect : null,
      ocrOutcome?.status === 'ok' && ocrPlainText(ocrOutcome.lines).length > 0
        ? button('Copy text', 'Copy the recognized handwriting as plain text', copyRecognizedText)
        : null,
      button('Cancel', 'Discard the scan', close),
      options.saveDebug !== null
        ? button(
            'Debug insert',
            'Insert as usual, and also save the source photo, the straightened photo, ' +
              'the cleaned board and the traced SVG into a folder beside this drawing',
            () => void debugInsert(),
          )
        : null,
      button(
        imageOutput ? 'Save photo' : 'Insert photo',
        imageOutput
          ? `Save the straightened photo as an image file in this folder. ${summary}`
          : `Add the straightened photo to this drawing. ${summary}`,
        () => insert('photo'),
        !hasInk,
      ),
      hasInk
        ? button(
            imageOutput ? 'Save image' : 'Insert image',
            imageOutput
              ? `Save the cleaned board as a PNG image file in this folder. ${summary}`
              : `Add the cleaned board as a picture instead. ${summary}`,
            () => insert('cleaned'),
            imageOutput,
          )
        : null,
      hasStrokes
        ? button(
            'Insert strokes',
            'Add the traced ink as editable strokes — erase, move and recolour them like ' +
              `drawn ink. ${summary}`,
            () => insert('strokes'),
            true,
          )
        : null,
    );
  }

  /**
   * ONLY what is wrong. The counts-and-colours summary the review screen used
   * to print above the board was true and useless — the board itself shows it,
   * and on a tablet the paragraph cost more than it said. It now rides the
   * Insert button's tooltip; this returns the things a user could act on.
   */
  function reviewWarnings(built: ScanElements | null): string[] {
    const parts: string[] = [];
    if (cleaned === null) {
      return parts;
    }
    if (cleaned.extraction.components.length === 0) {
      parts.push('no ink stood out — only the straightened photo can be inserted');
    }
    if (cleaned.glareFraction > GLARE_HINT_FRACTION) {
      parts.push('glare detected — some ink may be lost; try shooting from off-axis');
    }
    if (built !== null && built.reduced) {
      parts.push('dense board — the geometry was simplified to keep the file small');
    }
    if (built !== null && built.strokes > MAX_SCAN_STROKES) {
      parts.push('a very dense board; expect the editor to feel it');
    }
    return parts;
  }

  /** The counts, for the Insert button's tooltip — available on demand rather
   *  than permanently occupying the pane. */
  function reviewSummary(built: ScanElements | null): string {
    const parts: string[] = [];
    if (rectified !== null) {
      parts.push(`${rectified.width} × ${rectified.height} px`);
    }
    if (built !== null) {
      // In theme mode distinct SLOTS are what the eye sees; in true-colour
      // mode the measured hexes are.
      const colours = new Set(
        built.elements.map((e) =>
          colorMode === 'themed' ? `s${e.slot ?? PALETTE.indexOf(e.stroke)}` : e.stroke,
        ),
      ).size;
      parts.push(
        `${built.strokes} editable stroke${built.strokes === 1 ? '' : 's'} in ` +
          `${colours} colour${colours === 1 ? '' : 's'}`,
      );
    } else if (cleaned !== null) {
      const marks = cleaned.extraction.components.length;
      parts.push(
        `${marks} ink mark${marks === 1 ? '' : 's'} in ` +
          `${cleaned.colors.tallies.length} colour${cleaned.colors.tallies.length === 1 ? '' : 's'}`,
      );
    }
    if (ocrOutcome?.status === 'ok') {
      const read = ocrOutcome.lines.filter((line) => line.text.length > 0).length;
      if (read > 0) {
        parts.push(`${read} line${read === 1 ? '' : 's'} of text recognized`);
      }
    }
    parts.push(
      imageOutput
        ? 'it becomes a new image file in this folder, ready to link into notes'
        : 'it lands on its own layer, so it can be moved, resized or deleted like anything else',
    );
    return parts.join(' — ') + '.';
  }

  /**
   * The cleaned raster as shown AND as inserted (one code path — what you see
   * is what lands). Themed: ink in the resolved app-theme palette on a
   * TRANSPARENT sheet, so the scan sits directly on the board surface and a
   * dark theme shows dark-board ink, not a white card. True colours: the
   * measured ink on white — the fidelity mode is a document, and measured
   * colours need the white they were measured against.
   */
  function composeCleanedForDisplay(): RgbaImage {
    // The remap applies to the raster views too — one truth for every mode.
    const remapped = (color: ComponentColor): ComponentColor => {
      const target = remap.get(color.bucket);
      return target === undefined || target === color.bucket
        ? color
        : {
            ...color,
            bucket: target,
            snapped: SCAN_PALETTE[target],
            measured: SCAN_PALETTE[target],
          };
    };
    if (colorMode === 'themed') {
      const ink = resolveThemedInk(element);
      return composeCleaned(cleaned!, 'themed', {
        background: 'transparent',
        inkFor: (color) => ink(remapped(color)),
      });
    }
    return composeCleaned(cleaned!, 'true', {
      inkFor: (color) => hexTriple(remapped(color).measured),
    });
  }

  /* ------------------------------- debug dump ----------------------------- */

  /** XML text escape — the debug SVG carries recognized text verbatim. */
  function escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * The traced board as a STANDALONE `.svg` — the same `d` strings that will
   * land in the whiteboard, in rectified-image pixels, on a white sheet so the
   * file opens legibly in any viewer. This is the artifact worth diffing when
   * a trace comes out wrong.
   */
  function debugSvg(built: ScanElements, size: RgbaImage): string {
    const body = built.elements
      .map((stroke) =>
        stroke.tool === 'scanfill'
          ? `  <path d="${stroke.d}" fill="${stroke.stroke}" fill-rule="evenodd"/>`
          : `  <path d="${stroke.d}" fill="none" stroke="${stroke.stroke}" ` +
            `stroke-width="${stroke.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
      .join('\n');
    const text =
      ocrOutcome?.status === 'ok' && ocrPlainText(ocrOutcome.lines).length > 0
        ? `  <desc>${escapeXml(ocrPlainText(ocrOutcome.lines))}</desc>\n`
        : '';
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.width} ${size.height}" ` +
      `width="${size.width}" height="${size.height}">\n` +
      text +
      `  <rect width="100%" height="100%" fill="#ffffff"/>\n${body}\n</svg>\n`
    );
  }

  /** `data:image/jpeg;base64,AAA` → `AAA` (the write primitive takes payloads). */
  function base64Payload(dataUrl: string): string {
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  }

  /**
   * "Debug insert": everything a normal insert does, plus the intermediates
   * written to disk. Deliberately the SAME insert path rather than a parallel
   * one — a debugging button that exercises different code proves nothing.
   */
  async function debugInsert(): Promise<void> {
    const save = options.saveDebug;
    if (!save || !rectified) {
      return;
    }
    // A debug button must never fail SILENTLY — if assembling any artifact
    // throws, say which one and still insert; a partial dump beats nothing.
    const files: ScanDebugFile[] = [];
    let buildError: string | null = null;
    const tryBuild = (name: string, build: () => ScanDebugFile | null): void => {
      try {
        const file = build();
        if (file) {
          files.push(file);
        }
      } catch (error) {
        buildError = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    if (sourcePhoto) {
      tryBuild('1-source', () => {
        const decoded = decodeDataUrl(sourcePhoto!.dataUrl);
        const ext = decoded?.mime === 'image/png' ? 'png' : 'jpg';
        return {
          name: `1-source.${ext}`,
          kind: 'base64',
          data: base64Payload(sourcePhoto!.dataUrl),
        };
      });
    }
    tryBuild('2-straightened', () => {
      const straightened = encodeJpeg(rectified!, 0.92);
      return straightened
        ? { name: '2-straightened.jpg', kind: 'base64', data: base64Payload(straightened) }
        : null;
    });
    if (cleaned) {
      tryBuild('3-cleaned', () => {
        const png = encodePng(composeCleanedForDisplay());
        return png ? { name: '3-cleaned.png', kind: 'base64', data: base64Payload(png) } : null;
      });
      // What the filters dropped, tinted by reason (see REMOVAL_TINTS) — the
      // artifact to open when ink is missing from 3-cleaned.
      tryBuild('3b-removed', () => {
        const removedPng = encodePng(composeRemovedDebug(cleaned!));
        return removedPng
          ? { name: '3b-removed.png', kind: 'base64', data: base64Payload(removedPng) }
          : null;
      });
    }
    tryBuild('4-traced', () => {
      const built = ensureBuilt();
      return built
        ? { name: '4-traced.svg', kind: 'text', data: debugSvg(built, rectified!) }
        : null;
    });
    if (buildError !== null) {
      options.onNotice(`A debug artifact could not be built (${buildError}).`);
    }

    // Insert FIRST — the write is the side errand, and the user should not be
    // waiting on a disk round-trip to see their board.
    const hasStrokes = traced !== null && traced.components.length > 0;
    try {
      insert(hasStrokes ? 'strokes' : 'photo');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onNotice(`The scan could not be inserted (${message}).`);
      return;
    }
    try {
      const folder = await save(files);
      options.onNotice(
        folder === null
          ? 'The scan debug files could not be saved.'
          : `Scan debug files saved to "${folder}".`,
      );
    } catch (error) {
      // Name the failure — "could not be saved" with no reason sends whoever
      // is debugging the debugger straight to the devtools console.
      const message = error instanceof Error ? error.message : String(error);
      options.onNotice(`The scan debug files could not be saved (${message}).`);
    }
  }

  function insert(kind: 'strokes' | 'cleaned' | 'photo'): void {
    if (!rectified) {
      return;
    }
    if (kind === 'strokes') {
      if (!traced || !cleaned) {
        return;
      }
      const payload: ScanStrokesResult = {
        trace: traced,
        colors: cleaned.colors,
        mode: colorMode,
        remap: new Map(remap),
        smoothing,
        // Captured BEFORE close() wipes the panel — the promise is the only
        // thing that carries a still-running recognition to the adapter.
        ocr: ocrPromise ?? Promise.resolve({ status: 'unavailable' }),
      };
      close();
      options.onInsertStrokes(payload);
      return;
    }
    // The cleaned board is flat colour — PNG both compresses that far better
    // than JPEG, avoids ringing haloes around the ink, and carries the themed
    // sheet's alpha. The photo keeps JPEG, which is what photographs want.
    const dataUrl =
      kind === 'cleaned' && cleaned !== null
        ? encodePng(composeCleanedForDisplay())
        : encodeJpeg(rectified, OUTPUT_QUALITY);
    if (!dataUrl) {
      options.onNotice('The scan could not be encoded.');
      return;
    }
    // base64 is 4 bytes per 3; the payload is what actually lands in the file.
    // A standalone image file is its own bytes on disk — only an EMBEDDED
    // result inflates the drawing's document string, so only that warns.
    if (!imageOutput && dataUrl.length * 0.75 > LARGE_RESULT_BYTES) {
      options.onNotice('That scan is large — the drawing file will be a few MB.');
    }
    const result: ScanResult = {
      dataUrl,
      width: rectified.width,
      height: rectified.height,
    };
    close();
    options.onInsert(result);
  }

  /* -------------------------------- lifecycle ----------------------------- */

  async function acquire(source: ScanSource): Promise<ScanPhoto | null> {
    if (typeof source === 'object') {
      return source;
    }
    if (source === 'camera') {
      if (!options.capture) {
        options.onNotice('No camera is available on this device.');
        return null;
      }
      return await options.capture();
    }
    if (!options.pick) {
      options.onNotice('No file picker is available here.');
      return null;
    }
    return await options.pick();
  }

  function open(source: ScanSource): void {
    const mine = ++generation;
    // Re-read remembered tuning on every open — another scan (or another
    // window) may have changed it since this panel was constructed.
    const prefs = options.prefs?.get();
    if (prefs) {
      preset = prefs.preset;
      presetSelect.value = preset;
      smoothing = prefs.smoothing;
      smoothingSelect.value = smoothing;
    }
    // The board's mode may have been toggled since the panel was built.
    if (!imageOutput && options.initialColorMode) {
      colorMode = options.initialColorMode();
      colorSelect.value = colorMode;
    }
    element.hidden = false;
    element.focus({ preventScroll: true });
    showAcquiring(
      source === 'camera'
        ? 'Opening the camera…'
        : source === 'picker'
          ? 'Choosing a photo…'
          : 'Reading the photo…',
    );
    void (async () => {
      let acquired: ScanPhoto | null;
      try {
        acquired = await acquire(source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (mine === generation) {
          // "cancelled" is the user pressing back in the camera app; that is
          // not a failure and does not deserve a notice.
          if (!/cancel/i.test(message)) {
            options.onNotice(
              /PERMISSION_DENIED/.test(message)
                ? 'Camera permission was declined — the scan needs it to take a photo.'
                : /NO_CAMERA/.test(message)
                  ? 'This device has no camera app to take the photo with.'
                  : `The photo could not be taken: ${message}`,
            );
          }
          close();
        }
        return;
      }
      if (mine !== generation) {
        return; // the panel moved on (cancelled, or reopened) while we waited
      }
      if (!acquired) {
        close();
        return;
      }
      const decoded = await decodeImage(acquired.dataUrl);
      if (mine !== generation) {
        return;
      }
      if (!decoded) {
        options.onNotice('That image could not be read.');
        close();
        return;
      }
      photo = decoded;
      sourcePhoto = acquired;
      const detection = detectBoardQuad(decoded);
      quad = detection.quad;
      detectedSource = detection.source;
      showCrop();
    })();
  }

  function close(): void {
    generation++;
    if (pumping !== null) {
      cancelAnimationFrame(pumping);
      pumping = null;
    }
    stage = 'idle';
    photo = null;
    sourcePhoto = null;
    quad = null;
    rectified = null;
    cleaned = null;
    traced = null;
    builtCache = null;
    ocrOutcome = null;
    ocrPromise = null;
    remap.clear();
    reviewView = 'vector';
    dragging = null;
    previewPointers.clear();
    previewPinch = 0;
    previewNeedsFit = true;
    element.hidden = true;
    overlay.innerHTML = '';
    loupe.hidden = true;
    colorsRow.hidden = true;
    colorsRow.replaceChildren();
    actions.replaceChildren();
    options.onClose();
  }

  return {
    element,
    open,
    isOpen: () => stage !== 'idle',
    close,
    destroy() {
      generation++;
      if (pumping !== null) {
        cancelAnimationFrame(pumping);
        pumping = null;
      }
      resizeObserver.disconnect();
      viewport.removeEventListener('pointerdown', onPointerDown);
      viewport.removeEventListener('pointermove', onPointerMove);
      viewport.removeEventListener('pointerup', onPointerUp);
      viewport.removeEventListener('pointercancel', onPointerUp);
      viewport.removeEventListener('wheel', onWheel);
      viewport.removeEventListener('dblclick', onDoubleClick);
      element.remove();
      stage = 'idle';
      photo = null;
      sourcePhoto = null;
      quad = null;
      rectified = null;
      cleaned = null;
      traced = null;
      builtCache = null;
    },
  };
}
