/**
 * Diagram-viewer state — the fullscreen mermaid viewer opened by clicking a
 * rendered diagram in the preview. Transient, never persisted (same contract
 * as uiStore's overlays). The store holds the diagram's already-rendered SVG
 * markup, captured from the pane at click time — the viewer never re-renders
 * mermaid, so it always shows exactly what was clicked (theme colors baked in).
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';

export interface DiagramViewerState {
  open: boolean;
  /** The clicked diagram's SVG markup; null while the viewer is closed. */
  svg: string | null;
  openWith: (svg: string) => void;
  close: () => void;
}

export const diagramViewerStore = createStore<DiagramViewerState>()((set) => ({
  open: false,
  svg: null,

  openWith(svg) {
    set({ open: true, svg });
  },

  close() {
    set({ open: false, svg: null });
  },
}));

export const useDiagramViewer = <T>(selector: (s: DiagramViewerState) => T): T =>
  useStore(diagramViewerStore, selector);
