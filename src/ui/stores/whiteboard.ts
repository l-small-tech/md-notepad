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
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_STROKE_WIDTH,
  PALETTE,
  STATIC_PALETTE,
  type DrawTool,
  type PaletteKind,
  type ToolSettings,
} from '../../core/whiteboard/tool-settings';
import type { DiagramView } from '../../core/diagram-zoom';
import type { WhiteboardAdapter, WhiteboardUiState } from '../../editors/whiteboard';

/** Per-tab draw state reported UP by the adapter (undo depth, layers panel). */
export type DrawTabState = WhiteboardUiState;

const IDLE: DrawTabState = {
  canUndo: false,
  canRedo: false,
  layersOpen: false,
  activeLayerName: null,
  selectionCount: 0,
};

interface WhiteboardState {
  tool: DrawTool;
  color: string;
  width: number;
  /** Text tool: kept beside the nib because type size is not a nib size. */
  fontSize: number;
  fontFamily: string;
  /** Which swatch row the ribbon offers: themable slots or fixed named colours. */
  paletteKind: PaletteKind;
  /**
   * "Draw with finger": true/false once the user has chosen, null while they
   * have not — see `fingerDrawsEnabled` in `core/whiteboard/input.ts`, which
   * resolves null to "yes, until this device proves it has a pen".
   */
  fingerDraws: boolean | null;
  /** Set the first time a stylus touches a board; the toggle's auto label. */
  penSeen: boolean;
  /**
   * tabId → the last viewport its board had. SESSION state, deliberately not
   * written to the file: panning must never dirty a document. Survives tab
   * switches and Draw⇄Raw round trips, which is where losing your place
   * actually hurts.
   */
  viewByTab: Record<string, DiagramView>;
  /** tabId → what its draw adapter last reported. */
  byTab: Record<string, DrawTabState>;
  setTool: (tool: DrawTool) => void;
  setColor: (color: string) => void;
  setWidth: (width: number) => void;
  setFontSize: (size: number) => void;
  setFontFamily: (stack: string) => void;
  setPaletteKind: (kind: PaletteKind) => void;
  setFingerDraws: (value: boolean | null) => void;
  notePenSeen: () => void;
  saveView: (tabId: string, view: DiagramView) => void;
  reportTabState: (tabId: string, state: DrawTabState) => void;
  clearTab: (tabId: string) => void;
}

/**
 * Switching palette kinds carries the selection across by INDEX — the Nth
 * marker stays the Nth marker. (The rows no longer share hues: the themed row
 * is theme-derived, the static row is the fixed hue wheel.) A colour outside
 * the departing row (e.g. a future picker's custom hex) is left alone.
 */
export function carryColor(color: string, to: PaletteKind): string {
  const [from, into] = to === 'static' ? [PALETTE, STATIC_PALETTE] : [STATIC_PALETTE, PALETTE];
  const slot = from.indexOf(color);
  return slot < 0 ? color : into[slot]!;
}

export const whiteboardStore = createStore<WhiteboardState>()((set) => ({
  // Select, not pen: opening a board should not put a live nib under the first
  // touch. Landing in select lets you read, pan and pick up what is already
  // there without risking a stray stroke — you reach for the pen when you mean
  // to draw. (Still global, so the tool you pick carries to the next board.)
  tool: 'select',
  color: DEFAULT_COLOR,
  width: DEFAULT_STROKE_WIDTH,
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: DEFAULT_FONT_FAMILY,
  paletteKind: 'themed',
  fingerDraws: null,
  penSeen: false,
  viewByTab: {},
  byTab: {},
  setTool: (tool) => set({ tool }),
  setColor: (color) => set({ color }),
  setWidth: (width) => set({ width }),
  setFontSize: (fontSize) => set({ fontSize }),
  setFontFamily: (fontFamily) => set({ fontFamily }),
  setPaletteKind: (kind) =>
    set((s) =>
      s.paletteKind === kind ? s : { paletteKind: kind, color: carryColor(s.color, kind) },
    ),
  setFingerDraws: (value) => set({ fingerDraws: value }),
  notePenSeen: () => set((s) => (s.penSeen ? s : { penSeen: true })),
  saveView(tabId, view) {
    set((s) => ({ viewByTab: { ...s.viewByTab, [tabId]: view } }));
  },
  reportTabState(tabId, state) {
    set((s) => ({ byTab: { ...s.byTab, [tabId]: state } }));
  },
  clearTab(tabId) {
    set((s) => {
      if (!(tabId in s.byTab) && !(tabId in s.viewByTab)) {
        return s;
      }
      const byTab = { ...s.byTab };
      const viewByTab = { ...s.viewByTab };
      delete byTab[tabId];
      delete viewByTab[tabId];
      return { byTab, viewByTab };
    });
  },
}));

/** What the adapter reads at the start of every gesture. */
export function currentToolSettings(): ToolSettings {
  const { tool, color, width, fontSize, fontFamily } = whiteboardStore.getState();
  return { tool, color, width, fontSize, fontFamily };
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
