/**
 * Draw-mode tool state, plus the live adapter registry behind it.
 *
 * Split the way `preview-nav.ts` splits: the reactive half is what the ribbon
 * RENDERS from, the module map is what it CALLS. Keeping tools out of the tabs
 * store matters — picking a colour must not re-render the tab bar, and it fires
 * on every click of a palette swatch.
 *
 * The tool/colour/width are DELIBERATELY global rather than per-tab: a user who
 * picks the red highlighter expects it to still be the red highlighter on the
 * next board, the same way every drawing app behaves. Undo availability, which
 * is genuinely per-document, is keyed by tabId.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  DEFAULT_COLOR,
  DEFAULT_STROKE_WIDTH,
  PALETTE,
  STATIC_PALETTE,
  type DrawTool,
  type PaletteKind,
  type ToolSettings,
} from '../../core/whiteboard/tool-settings';
import type { WhiteboardAdapter, WhiteboardUiState } from '../../editors/whiteboard';

/** Per-tab draw state reported UP by the adapter (undo depth, layers panel). */
export type DrawTabState = WhiteboardUiState;

const IDLE: DrawTabState = {
  canUndo: false,
  canRedo: false,
  layersOpen: false,
  activeLayerName: null,
};

interface WhiteboardState {
  tool: DrawTool;
  color: string;
  width: number;
  /** Which swatch row the ribbon offers: themable slots or fixed named colours. */
  paletteKind: PaletteKind;
  /** tabId → what its draw adapter last reported. */
  byTab: Record<string, DrawTabState>;
  setTool: (tool: DrawTool) => void;
  setColor: (color: string) => void;
  setWidth: (width: number) => void;
  setPaletteKind: (kind: PaletteKind) => void;
  reportTabState: (tabId: string, state: DrawTabState) => void;
  clearTab: (tabId: string) => void;
}

/**
 * Switching palette kinds carries the selection across by INDEX (both rows
 * share the same hue order), so "blue pen" stays a blue pen. A colour outside
 * the departing row (e.g. a future picker's custom hex) is left alone.
 */
export function carryColor(color: string, to: PaletteKind): string {
  const [from, into] = to === 'static' ? [PALETTE, STATIC_PALETTE] : [STATIC_PALETTE, PALETTE];
  const slot = from.indexOf(color);
  return slot < 0 ? color : into[slot]!;
}

export const whiteboardStore = createStore<WhiteboardState>()((set) => ({
  tool: 'pen',
  color: DEFAULT_COLOR,
  width: DEFAULT_STROKE_WIDTH,
  paletteKind: 'themed',
  byTab: {},
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setWidth: (width) => set({ width }),
  setPaletteKind: (kind) =>
    set((s) =>
      s.paletteKind === kind ? s : { paletteKind: kind, color: carryColor(s.color, kind) },
    ),
  reportTabState(tabId, state) {
    set((s) => ({ byTab: { ...s.byTab, [tabId]: state } }));
  },
  clearTab(tabId) {
    set((s) => {
      if (!(tabId in s.byTab)) {
        return s;
      }
      const next = { ...s.byTab };
      delete next[tabId];
      return { byTab: next };
    });
  },
}));

/** What the adapter reads at the start of every gesture. */
export function currentToolSettings(): ToolSettings {
  const { tool, color, width } = whiteboardStore.getState();
  return { tool, color, width };
}

export function drawStateFor(tabId: string | null): DrawTabState {
  return (tabId !== null ? whiteboardStore.getState().byTab[tabId] : undefined) ?? IDLE;
}

/* --------------------------- the adapter registry ------------------------- */

const adapters = new Map<string, WhiteboardAdapter>();

export function registerWhiteboardAdapter(tabId: string, adapter: WhiteboardAdapter): void {
  adapters.set(tabId, adapter);
}

export function unregisterWhiteboardAdapter(tabId: string): void {
  adapters.delete(tabId);
  whiteboardStore.getState().clearTab(tabId);
}

export function getWhiteboardAdapter(tabId: string): WhiteboardAdapter | undefined {
  return adapters.get(tabId);
}

export const useWhiteboardStore = <T>(selector: (s: WhiteboardState) => T): T =>
  useStore(whiteboardStore, selector);
