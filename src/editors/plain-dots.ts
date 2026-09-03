/**
 * Keep `...` as three dots in the raw editor.
 *
 * Coding fonts with ligatures (Fira Code, Cascadia Code, JetBrains Mono)
 * carry a `...` ligature that squeezes three periods into one narrow glyph —
 * at editor sizes it reads as a single dot, which is wrong for prose. The
 * "font ligatures" setting stays on for the arrows and operators it exists
 * for; this decoration just wraps every run of periods in a span that opts
 * out of ligatures (see `.cm-plain-dots` in base.css).
 */

import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
  type EditorView,
} from '@codemirror/view';

const plainDots = new MatchDecorator({
  regexp: /\.{2,}/g,
  decoration: Decoration.mark({ class: 'cm-plain-dots' }),
});

export const plainDotsExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = plainDots.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.decorations = plainDots.updateDeco(update, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);
