/**
 * whiteboard-scan.ts — the scan screen (phase 4: S0 acquire + S1 rectify).
 *
 * Photograph a physical whiteboard, correct the perspective, and drop the
 * result onto the board. Phase 4 inserts the rectified PHOTO; phases 5–7 keep
 * this same screen and replace what comes out the end of it with cleaned ink,
 * then vector strokes, then recognized text.
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
import { rotate90 } from '../core/whiteboard/scan/image-ops';
import {
  DEFAULT_SCAN_PRESET,
  type Quad,
  type RgbaImage,
  type ScanPoint,
  type ScanPreset,
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

export interface ScanPanelOptions {
  /** Take a photo with the device camera. Null where there is no camera. */
  readonly capture: (() => Promise<ScanPhoto>) | null;
  /** Choose an image file. Null where there is no picker (Android uses the
   *  camera; a file arrives by paste there instead). */
  readonly pick: (() => Promise<ScanPhoto | null>) | null;
  /** Insert the rectified board. The panel closes itself first. */
  readonly onInsert: (result: ScanResult) => void;
  /** The panel is finished with (cancelled, or inserted). */
  readonly onClose: () => void;
  /** Surface a message to the user (permission denied, decode failure, …). */
  readonly onNotice: (message: string) => void;
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

/* ================================= the panel ============================== */

type Stage = 'idle' | 'acquiring' | 'crop' | 'working' | 'review';

export function createScanPanel(options: ScanPanelOptions): ScanPanel {
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
  let quad: Quad | null = null;
  let detectedSource: 'detected' | 'frame' = 'frame';
  let preset: ScanPreset = DEFAULT_SCAN_PRESET;
  let rectified: RgbaImage | null = null;
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
  });

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

  /* ------------------------------ crop gestures --------------------------- */

  let dragging: number | null = null;

  function onPointerDown(event: PointerEvent): void {
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

  const resizeObserver = new ResizeObserver(() => {
    if (stage === 'crop') {
      renderCrop();
    }
  });
  resizeObserver.observe(viewport);

  /* ------------------------------- the stages ----------------------------- */

  function setActions(...nodes: (HTMLElement | null)[]): void {
    actions.replaceChildren(...nodes.filter((n): n is HTMLElement => n !== null));
  }

  function showAcquiring(message: string): void {
    stage = 'acquiring';
    title.textContent = 'Scan a whiteboard';
    hint.textContent = message;
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
    rectified = null;
    title.textContent = 'Frame the board';
    hint.textContent =
      detectedSource === 'detected'
        ? 'Drag the corners if the outline missed the board.'
        : 'No board edges stood out — drag the corners onto the board.';
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
    title.textContent = 'Straightening…';
    hint.textContent = `${job.plan.width} × ${job.plan.height} px`;
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
      showReview();
    };
    pumping = requestAnimationFrame(pump);
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
    title.textContent = 'Ready to insert';
    hint.textContent = `${rectified.width} × ${rectified.height} px — it lands on its own layer, so it can be moved, resized or deleted like anything else.`;
    progress.hidden = true;
    paint(photoCanvas, rectified);
    const l = (() => {
      const box = viewport.getBoundingClientRect();
      const scale = Math.min(box.width / rectified!.width, box.height / rectified!.height, 1);
      return { scale, box };
    })();
    photoCanvas.style.width = `${rectified.width * l.scale}px`;
    photoCanvas.style.height = `${rectified.height * l.scale}px`;
    photoCanvas.style.left = `${(l.box.width - rectified.width * l.scale) / 2}px`;
    photoCanvas.style.top = `${(l.box.height - rectified.height * l.scale) / 2}px`;
    overlay.innerHTML = '';
    setActions(
      button('Back', 'Adjust the crop', showCrop),
      button('Cancel', 'Discard the scan', close),
      button('Insert', 'Add the board to this whiteboard', insert, true),
    );
  }

  function insert(): void {
    if (!rectified) {
      return;
    }
    const dataUrl = encodeJpeg(rectified, OUTPUT_QUALITY);
    if (!dataUrl) {
      options.onNotice('The scan could not be encoded.');
      return;
    }
    // base64 is 4 bytes per 3; the payload is what actually lands in the file.
    if (dataUrl.length * 0.75 > LARGE_RESULT_BYTES) {
      options.onNotice('That scan is large — the whiteboard file will be a few MB.');
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
    quad = null;
    rectified = null;
    dragging = null;
    element.hidden = true;
    overlay.innerHTML = '';
    loupe.hidden = true;
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
      element.remove();
      stage = 'idle';
      photo = null;
      quad = null;
      rectified = null;
    },
  };
}
