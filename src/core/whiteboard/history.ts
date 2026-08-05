/**
 * Undo/redo as a snapshot stack.
 *
 * This is only affordable because {@link SceneDoc} is immutable with structural
 * sharing: a stroke on a 2000-element board allocates one new layer array and
 * one new doc object, and every untouched layer is the SAME object in all 200
 * snapshots. An inverse-operation ("command") stack would buy nothing here and
 * would have to be kept correct for every future tool.
 *
 * Scope, per the plan: one history per ADAPTER INSTANCE, so it is lost on a
 * Draw⇄Raw switch. That matches the documented raw⇄wysiwyg limitation and is
 * the industry norm for dual-mode editors.
 */

export const DEFAULT_HISTORY_LIMIT = 200;

export interface History<T> {
  /** The current state — always defined; the stack is never empty. */
  current(): T;
  /** Record a new state. Clears the redo branch, as every editor does. */
  push(state: T): void;
  /** Step back; returns the state now current (unchanged if there is none). */
  undo(): T;
  redo(): T;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Throw the whole timeline away and restart from `state` (external reload). */
  reset(state: T): void;
}

export function createHistory<T>(initial: T, limit = DEFAULT_HISTORY_LIMIT): History<T> {
  let states: T[] = [initial];
  let index = 0;

  return {
    current: () => states[index]!,

    push(state) {
      if (Object.is(state, states[index])) {
        return; // a no-op edit must not consume an undo step
      }
      states = states.slice(0, index + 1);
      states.push(state);
      if (states.length > limit) {
        // Drop the oldest state. The board loses its earliest history, never
        // its current content.
        states.shift();
      }
      index = states.length - 1;
    },

    undo() {
      if (index > 0) {
        index--;
      }
      return states[index]!;
    },

    redo() {
      if (index < states.length - 1) {
        index++;
      }
      return states[index]!;
    },

    canUndo: () => index > 0,
    canRedo: () => index < states.length - 1,

    reset(state) {
      states = [state];
      index = 0;
    },
  };
}
