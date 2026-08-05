# src/core/whiteboard/ — the `.svg` whiteboard format

Pure, DOM-free, Vitest-covered. The DOM half of the feature is
`src/editors/whiteboard.ts` (a lazy-loaded adapter); everything that decides
what a whiteboard *is* lives here.

| File | Role |
| --- | --- |
| `xml.ts` | a small XML reader with SOURCE SPANS (not DOMParser — see below) |
| `scene.ts` | `SceneDoc` / `Layer` / `SceneElement` — the immutable scene model |
| `parse.ts` | SVG source → `SceneDoc` |
| `serialize.ts` | `SceneDoc` → deterministic SVG source |
| `geometry.ts` | points, rects, path flattening — "what is under this point" |
| `smoothing.ts` | 1€ filter → RDP → Catmull-Rom Béziers; the pen pipeline |
| `tool-settings.ts` | tool ids, palette, nib sizes. **A dependency-free leaf** |
| `tools.ts` | gesture → `SceneElement` (the tools themselves) |
| `layers.ts` | pure `(doc, …) → doc` layer and element operations |
| `hit-test.ts` | the eraser's aim, and selection's base |
| `select.ts` | the selected set, resize handles, and BAKING a transform in |
| `input.ts` | pointer routing and palm rejection. **A dependency-free leaf** |
| `text-wrap.ts` | greedy word wrap, with the measure injected |
| `history.ts` | the snapshot undo stack |
| `bounds.ts` | the content-fitted viewBox for infinite boards |

`tool-settings.ts` is split out of `tools.ts` deliberately: the ribbon draws
the palette and lives in the eager entry bundle, so importing it from `tools.ts`
would pull smoothing, serialization and the XML reader into startup and quietly
undo invariant I8. Keep that module importing nothing but a type. `input.ts` is
under the same constraint for the same reason — the ribbon's finger toggle
needs `fingerDrawsEnabled` and nothing else.

## Selection bakes; it never transforms

`select.ts` rewrites the elements themselves: a moved stroke gets a new `d`, a
resized rect gets new `x`/`width`. There is no `transform` attribute anywhere in
the format and there is not going to be one — hit-testing, the "renders
identically in a browser" promise and the scan pipeline's coordinate mapping all
stay simple in exchange for one careful module.

Two consequences worth knowing before editing it:

- A single `stroke-width` (or `font-size`) cannot follow two different axis
  scales, so it takes the **geometric mean** √(sx·sy). A non-uniformly stretched
  selection therefore lands within a stroke width of its box, not exactly on it.
  The tests state that as the contract rather than pretending otherwise.
- A resize **clamps** at a minimum size instead of passing through zero. Letting
  a box flip inside-out means negative scales, mirrored text, and a drag the
  user cannot undo by dragging back.

An `ElementRef` (layer id + index) survives a move or a resize, because those
REPLACE elements in place — and does not survive an add, a delete, or an undo,
which is why the adapter drops the selection on all three.

## Fingers, pens and palms

`input.ts` is a pure classifier: a pen always draws (and its eraser end always
erases), a mouse draws with the primary button, and a finger draws only when the
user asked it to — with a second finger always converting the gesture into a
pan/pinch. While a pen is down, and for 300 ms after it lifts, every touch is a
palm and is dropped; oversized contacts are dropped always; and a stroke a
finger committed in the 150 ms before a pen landed is undone, because that is
what a palm touching down just ahead of the nib looks like.

It is pure because those combinations are exactly what testing by hand on one
device fails to cover.

One thing the adapter must keep doing, learned the hard way: **cancelling
`pointerdown` costs you focus**, because focus-on-click rides on the
compatibility `mousedown` that `preventDefault()` suppresses. The stage focuses
itself explicitly on every accepted press; without that, every keyboard path
(Delete, Ctrl+Z, nudge) dies silently after the first click.

## Text carries a font STACK, and its own wrapping

`TextElement.fontFamily` is a CSS stack or null (null = inherit, and null emits
no attribute at all, which is what keeps files written before it round-tripping
byte-for-byte). `FONT_FAMILIES` in `tool-settings.ts` only offers stacks that
end in a generic family: the premise of the whole feature is that the `.svg`
renders on someone else's machine, where the named face may not exist.

**SVG does not wrap.** So the box a user drags out is an editor affordance, and
`text-wrap.ts` turns it into `<tspan>` lines at commit time — the file holds
lines that were already decided, which is exactly why it renders the same
everywhere forever. `boxWidth` (`wb:box-width`, omitted when null) records only
the width those lines came from, so reopening the text rewraps to the same box;
a foreign renderer neither needs it nor sees it.

The measure is INJECTED because the only honest width of a glyph run is the
font engine's, and that lives in the DOM — the adapter passes a canvas
`measureText`, so what the file breaks at is what the textarea showed.

Nib sizes and type sizes share a board, so they are chosen against each other:
`STROKE_WIDTHS` tops out well under `DEFAULT_FONT_SIZE`, and the default board
is small enough (in units) that a unit is roughly a screen pixel — a bigger
default board is a silent zoom-out that makes type read as fine print.

## The one big idea

**A single self-contained `.svg` file is the source of truth.** Not a project
format that exports SVG — the file the user edits is the file a browser
renders and the file `![](board.svg)` inlines in the markdown preview. That is
what makes whiteboards useful inside a notepad.

Consequences, all load-bearing:

- Anything a foreign renderer must honor is **standard SVG**: layer visibility
  is `display`, colors and widths are presentation attributes, layers are
  top-level `<g>`s. Editor-only state uses the `wb:` namespace
  (`urn:md-notepad:whiteboard`) and a `<metadata><wb:doc>` JSON blob, both of
  which every other renderer ignores.
- **No stacked transforms.** Select/move/resize bake coordinates into the
  element. Hit-testing, foreign-renderer fidelity and the scan pipeline's
  coordinate mapping all get simple in exchange.
- `SceneDoc` is **immutable with structural sharing**, so undo is a snapshot
  stack rather than an inverse-operation zoo.

## Why not DOMParser

Two reasons. Core is DOM-free (I9), so the format's golden tests must run in
the node env with no shims. And the "nothing is ever dropped" guarantee needs
**source spans**: content we don't model is re-emitted by slicing the original
text, which `XMLSerializer` cannot do — it reformats.

## Why erasing deletes elements

Whole-element erase, never `<mask>`. Masking looks nicer for about a minute and
then bloats the file with an ever-growing mask path, breaks the "renders
identically in a browser" promise, and makes selection meaningless. Deleting
the element the user touched is the honest operation — and because scanned ink
will be made of the same `<path wb:tool="pen">` elements, it works there too.

`RawElement`s are invisible to every tool by design: unmodeled content belongs
to whoever authored it, and that is what makes carrying it safe.

## The two round-trip guarantees (don't conflate them)

1. **Mount → look → close is byte-identical.** This is NOT enforced here. It
   comes from the adapter's write-back guard, which serializes only after a
   genuine user edit — the same contract Milkdown has (I2). Opening a
   hand-authored or Inkscape SVG must never rewrite it.
2. **Nothing is dropped, ever.** Enforced here, and tested in
   `__tests__/roundtrip.test.ts`:
   - top-level `<defs>`/`<style>`/`<title>`/comments → `SceneDoc.prelude`,
     verbatim;
   - unmodeled elements inside one of our layers → `RawElement`, verbatim
     (this is also how a scan layer's hidden OCR group survives);
   - renderable top-level content that isn't one of our layers → one locked
     **foreign** layer named "Imported", verbatim, keeping its z-order;
   - unknown attributes → `extras`; unknown metadata keys → `meta`.

   Serializing our own output is a **fixed point** — that is the invariant the
   tests assert, and the thing to re-check after touching either file.

## Serializer determinism

Fixed attribute order, coordinates rounded to 2 decimals (`num`), 2-space
indent, `\n` endings, one trailing newline, metadata keys in a fixed order.
Determinism is what makes goldens possible and keeps a saved whiteboard's git
diff readable. Don't introduce output that depends on iteration order or
`Math.random` — `makeLayerId` takes its randomness by injection for exactly
this reason.

## Themable ink (phase 2.5)

A saved board follows the viewer's colour scheme without ever depending on it:

- Every element keeps its **concrete light-theme hex** in the presentation
  attribute (the truth for any CSS-less renderer). An element whose colour is
  one of the 8 `PALETTE` slots additionally gains `class="wb-cN"`; the white
  background rect gains `wb-bg`. Classes are **derived from the colour at
  serialize time, never stored** — that is what keeps the fixed point trivial.
- One serializer-owned `<style wb:role="palette">` block defines
  `--wb-bg`/`--wb-c0…c7` (light defaults + a `prefers-color-scheme: dark`
  override from `PALETTE_DARK`) and maps the classes to `var(--wb-cN, <hex>)`.
  Parse recognizes the `wb:role` and DROPS the block — it is regenerated on
  every save, so a stale palette can never freeze into the prelude.
- All rules scope to `svg.wb-board` (the serializer merges that class into the
  root, in front of any foreign class; parse strips the token back out).
  Never `:root` — the file gets inlined into HTML pages.
- A custom hex gets no class and stays literal in every scheme; a custom
  background likewise. `"themed": false` in the `wb:doc` metadata turns the
  whole mechanism off for a document.
- In the app, the adapter copies the resolved app-theme `--wb-*` values onto
  the board `<svg>` as inline style (inline beats the embedded block), so a
  forced app theme wins over the OS scheme while editing. base.css DERIVES
  those values from the theme palette vars (`--wb-bg` is `--editor-bg`, the
  slots are `--fg`/`--danger`/`--accent` and blends of them), so every theme —
  built-in or user-authored — gets a matching board and ink palette with no
  `whiteboard` section; the section remains as the way to pin exact inks. The
  hexes in `tool-settings.ts` (`PALETTE`/`PALETTE_DARK`) are only what the
  saved file falls back to outside the app.
- The STATIC palette (`STATIC_PALETTE`, named SVG colours) is the opt-out made
  convenient: named colours never equal a `PALETTE` hex, so static strokes are
  literal by construction — no format machinery at all.

## Infinite vs page boards

`background: null` (the default for new boards) means **infinite**: no page
rect; the palette block paints the surface via CSS `background` on the svg
viewport, and the serializer refits the root viewBox to the content
(`bounds.ts`: +48 margin, integer-rounded, idempotent, unioning the stored
viewBox when raw/foreign content is unmeasurable). A non-null background is a
**page**: the rect is emitted, the viewBox is the page and is never touched.
`setBackground` (layers.ts) flips between the two — adding a page pins the
current content-fitted viewBox.

## Error policy

Malformed XML throws `WhiteboardParseError`, which the adapter turns into the
error card with an "Open as text" button (`setMode('raw')`). Everything else
degrades instead of throwing: a corrupt `wb:doc` JSON blob is dropped (the
strokes live in the SVG body, not the metadata), a missing viewBox falls back
to a default board, a foreign root opens as an Imported layer.
