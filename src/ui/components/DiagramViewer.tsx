/**
 * DiagramViewer — fullscreen viewer for a mermaid diagram clicked in the
 * preview. Overlay pattern follows ExportPreviewDialog (custom-DOM modal,
 * store-driven open flag, Esc handled by the global keydown listener in
 * main.tsx); the body is a separate component so zoom/pan state mounts fresh
 * on every open.
 *
 * Zoom/pan: the math lives in core/diagram-zoom.ts (pure, tested); this
 * component keeps the current view in a ref and applies it as a CSS transform
 * directly — pointermove/wheel never trigger a React re-render (same
 * ref-not-state convention as the split divider drag). Only the percentage
 * readout is React state, updated when the scale actually changes. Wheel zoom
 * uses a native non-passive listener (React's synthetic wheel handler is
 * passive, so it can't preventDefault the page scroll).
 */

import { useEffect, useRef, useState } from 'react';
import {
  DIAGRAM_ZOOM_STEP,
  fitDiagramView,
  panDiagram,
  zoomDiagramAt,
  type DiagramView,
} from '../../core/diagram-zoom';
import { diagramViewerStore, useDiagramViewer } from '../stores/diagram-viewer';

export function DiagramViewer() {
  const open = useDiagramViewer((s) => s.open);
  if (!open) {
    return null;
  }
  return <DiagramViewerBody />;
}

function DiagramViewerBody() {
  const svg = useDiagramViewer((s) => s.svg);
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<DiagramView>({ scale: 1, x: 0, y: 0 });
  // The fit view is the Reset target — recomputed on open (content measured
  // after first paint) and kept when the window resizes while open.
  const fitRef = useRef<DiagramView>({ scale: 1, x: 0, y: 0 });
  const [percent, setPercent] = useState(100);

  const close = () => diagramViewerStore.getState().close();

  const apply = (view: DiagramView) => {
    viewRef.current = view;
    const el = contentRef.current;
    if (el) {
      el.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    }
    setPercent(Math.round(view.scale * 100));
  };

  /** Zoom by `factor` about the stage center (the buttons' anchor point). */
  const zoomCentered = (factor: number) => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    apply(zoomDiagramAt(viewRef.current, factor, stage.clientWidth / 2, stage.clientHeight / 2));
  };

  useEffect(() => {
    const stage = stageRef.current;
    const content = contentRef.current;
    if (!stage || !content) {
      return;
    }

    const fit = () => {
      // The SVG's laid-out size at scale 1 — measure the child, not the
      // transformed wrapper.
      const rect = content.firstElementChild?.getBoundingClientRect();
      const scale = viewRef.current.scale;
      fitRef.current = fitDiagramView(
        rect ? rect.width / scale : 0,
        rect ? rect.height / scale : 0,
        stage.clientWidth,
        stage.clientHeight,
      );
      apply(fitRef.current);
    };
    fit();

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = stage.getBoundingClientRect();
      const factor = event.deltaY < 0 ? DIAGRAM_ZOOM_STEP : 1 / DIAGRAM_ZOOM_STEP;
      apply(
        zoomDiagramAt(
          viewRef.current,
          factor,
          event.clientX - bounds.left,
          event.clientY - bounds.top,
        ),
      );
    };
    stage.addEventListener('wheel', onWheel, { passive: false });

    // Drag-to-pan: state in module-scope refs, listeners on the window for the
    // duration of the drag only (split-divider convention).
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      stage.setPointerCapture(event.pointerId);
      stage.classList.add('diagram-viewer-panning');
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) {
        return;
      }
      apply(panDiagram(viewRef.current, event.clientX - lastX, event.clientY - lastY));
      lastX = event.clientX;
      lastY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      stage.releasePointerCapture(event.pointerId);
      stage.classList.remove('diagram-viewer-panning');
    };
    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);

    window.addEventListener('resize', fit);
    return () => {
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerup', onPointerUp);
      stage.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('resize', fit);
    };
    // Mount-once per open (the body remounts on every open; svg never changes
    // while open — openWith replaces the whole body via the open flag).
  }, []);

  if (!svg) {
    return null;
  }

  return (
    <div className="diagram-viewer" role="dialog" aria-modal="true" aria-label="Diagram viewer">
      <div ref={stageRef} className="diagram-viewer-stage">
        <div
          ref={contentRef}
          className="diagram-viewer-content"
          // Safe: this markup is the SVG mermaid itself rendered into the
          // preview pane — it never contains user-authored raw HTML.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="diagram-viewer-controls">
        <button
          className="diagram-viewer-button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomCentered(1 / DIAGRAM_ZOOM_STEP)}
        >
          −
        </button>
        <span className="diagram-viewer-readout" aria-live="polite">
          {percent}%
        </span>
        <button
          className="diagram-viewer-button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomCentered(DIAGRAM_ZOOM_STEP)}
        >
          +
        </button>
        <button
          className="diagram-viewer-button diagram-viewer-fit"
          title="Fit to window"
          onClick={() => apply(fitRef.current)}
        >
          Fit
        </button>
        <button
          className="diagram-viewer-button"
          aria-label="Close"
          title="Close (Esc)"
          onClick={close}
        >
          ×
        </button>
      </div>
    </div>
  );
}
