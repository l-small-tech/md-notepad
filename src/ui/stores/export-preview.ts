/**
 * Export-preview state — the "Export…" dialog's document, chosen format and
 * chosen theme. Transient, never persisted (same contract as uiStore's
 * overlays). The store is DOM-free: the session controller seeds `themeId` /
 * `dark` from the app's current appearance when it opens the dialog, and the
 * dialog component drives the setters.
 *
 * `format` deliberately survives across opens — exporting three notes as PDF
 * shouldn't mean re-picking PDF three times. The theme seed is re-applied on
 * every open so the preview always starts looking like the app.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { DocSource, ExportFormat } from '../../core/export/doc-source';

export interface ExportPreviewState {
  open: boolean;
  /** The document being exported; null while the dialog is closed. */
  source: DocSource | null;
  format: ExportFormat;
  /** Theme-plugin id styling the export (an unknown id = default palette). */
  themeId: string;
  /** Which mode of the theme applies (light or dark palette). */
  dark: boolean;
  /** Open the dialog on `source`, seeding theme/mode (format is sticky). */
  openWith: (source: DocSource, seed: { themeId: string; dark: boolean }) => void;
  close: () => void;
  setFormat: (format: ExportFormat) => void;
  setThemeId: (themeId: string) => void;
  setDark: (dark: boolean) => void;
}

export const exportPreviewStore = createStore<ExportPreviewState>()((set) => ({
  open: false,
  source: null,
  format: 'pdf',
  themeId: '',
  dark: false,

  openWith(source, seed) {
    set({ open: true, source, themeId: seed.themeId, dark: seed.dark });
  },

  close() {
    // The source is cleared so a stale document can never be exported; the
    // format survives as a sticky preference.
    set({ open: false, source: null });
  },

  setFormat(format) {
    set({ format });
  },

  setThemeId(themeId) {
    set({ themeId });
  },

  setDark(dark) {
    set({ dark });
  },
}));

export const useExportPreview = <T>(selector: (s: ExportPreviewState) => T): T =>
  useStore(exportPreviewStore, selector);
