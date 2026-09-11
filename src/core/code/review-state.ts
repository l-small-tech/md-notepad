/**
 * What the Review pane shows for one tab, as pure data (review_plan.md §5):
 * which view, which filter chip, which cards have an expander open and how
 * far each card's x-ray is unfolded. `ui/stores/code-review.ts` keeps one of
 * these per tab and `preview/code-review.ts` renders it; both talk through
 * {@link ReviewAction} so the pane never imports a store (invariant I9).
 *
 * `'changes'` and `baseline` are declared now and filled by the What-changed
 * step; until then the pane keeps the chip disabled and the slot empty.
 */

export type ReviewView = 'cards' | 'calls' | 'changes';
export type ReviewFilter = 'all' | 'exported' | 'changed' | 'functions' | 'types';
/** Which expander a card has open (one at a time; the header toggles `doc`). */
export type ReviewExpander = 'doc' | 'code' | 'flow';
export type ReviewBaseline = 'branch' | 'uncommitted' | 'last-commit';

export interface ReviewState {
  view: ReviewView;
  filter: ReviewFilter;
  /** unit id → the expander open on that card. */
  expanded: Record<string, ReviewExpander>;
  /** unit id → base x-ray depth (1 = signatures + top-level control flow). */
  xrayDepth: Record<string, number>;
  /** unit id → (first line of a folded run → depth it was opened to). */
  xrayOpened: Record<string, Record<string, number>>;
  /** Calls view: the reader asked for the whole graph despite focus mode. */
  showAll: boolean;
  /** What-changed baseline; null until chosen (or when git is absent). */
  baseline: ReviewBaseline | null;
}

export const DEFAULT_REVIEW_STATE: ReviewState = {
  view: 'cards',
  filter: 'all',
  expanded: {},
  xrayDepth: {},
  xrayOpened: {},
  showAll: false,
  baseline: null,
};

/** The x-ray depth at which nothing is folded ("show everything"). */
export const XRAY_FULL = Number.POSITIVE_INFINITY;

export type ReviewAction =
  | { type: 'view'; view: ReviewView }
  | { type: 'filter'; filter: ReviewFilter }
  /** Tap an expander pill: opens it, or closes it when it is the open one. */
  | { type: 'toggle-expander'; unitId: string; expander: ReviewExpander }
  /** Tap a `⋯` marker: unfold that run (keyed by its first line) to `depth`. */
  | { type: 'open-xray'; unitId: string; line: number; depth: number }
  /** Set a card's base x-ray depth (`XRAY_FULL` = the whole body). */
  | { type: 'xray-depth'; unitId: string; depth: number }
  | { type: 'show-all'; showAll: boolean }
  | { type: 'baseline'; baseline: ReviewBaseline | null };

/** Pure: the next state for an action. Returns the SAME object for a no-op. */
export function reduceReview(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'view':
      return state.view === action.view ? state : { ...state, view: action.view };
    case 'filter':
      return state.filter === action.filter ? state : { ...state, filter: action.filter };
    case 'toggle-expander': {
      const expanded = { ...state.expanded };
      if (expanded[action.unitId] === action.expander) {
        delete expanded[action.unitId];
      } else {
        expanded[action.unitId] = action.expander;
      }
      return { ...state, expanded };
    }
    case 'open-xray': {
      const forUnit = { ...(state.xrayOpened[action.unitId] ?? {}), [action.line]: action.depth };
      return { ...state, xrayOpened: { ...state.xrayOpened, [action.unitId]: forUnit } };
    }
    case 'xray-depth': {
      if (state.xrayDepth[action.unitId] === action.depth) {
        return state;
      }
      // A new base depth supersedes the per-marker opens under it.
      const xrayOpened = { ...state.xrayOpened };
      delete xrayOpened[action.unitId];
      return {
        ...state,
        xrayDepth: { ...state.xrayDepth, [action.unitId]: action.depth },
        xrayOpened,
      };
    }
    case 'show-all':
      return state.showAll === action.showAll ? state : { ...state, showAll: action.showAll };
    case 'baseline':
      return state.baseline === action.baseline ? state : { ...state, baseline: action.baseline };
  }
}

/** The opened-runs map of a unit as the `Map` `xrayLines` takes. */
export function xrayOpenedMap(state: ReviewState, unitId: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const [line, depth] of Object.entries(state.xrayOpened[unitId] ?? {})) {
    out.set(Number(line), depth);
  }
  return out;
}
