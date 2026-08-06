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
| `history.ts` | the snapshot undo stack |
| `bounds.ts` | the content-fitted viewBox for infinite boards |
| `scan/` | the photo→SVG pipeline (see below) |

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

## Text is a point and some lines — that is all `<text>` is

`TextElement.fontFamily` is a CSS stack or null (null = inherit, and null emits
no attribute at all, which is what keeps files written before it round-tripping
byte-for-byte). `FONT_FAMILIES` in `tool-settings.ts` only offers stacks that
end in a generic family: the premise of the whole feature is that the `.svg`
renders on someone else's machine, where the named face may not exist.

**There is no text box, and there will not be one.** SVG 1.1 `<text>` is an
anchor point plus `<tspan>`s; it has no width, no wrapping and no reflow (SVG 2
proposed one and no shipping renderer implements it). So `lines` comes from the
newlines the user typed and from nowhere else, and the editor's textarea grows
sideways rather than wrapping — what you see typed is the run of glyphs the file
will hold.

A drag-out wrapping box was built and reverted. It *can* be faked — measure the
glyphs, bake the breaks into `<tspan>`s at commit — but the result is an editor
promising a reflow the format cannot keep: the box's width becomes editor-only
state, the "wrapped" lines are frozen the moment anything about the font
resolves differently elsewhere, and resizing or restyling the text silently
invalidates breaks the user never chose. Going with the grain is cheaper and
more honest. If long text needs a column, the answer is to type the newlines,
not to teach the file a layout model it doesn't have.

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

## `scan/` — photograph a physical whiteboard

Phase 4 ships S0–S1: acquire and rectify. Phases 5–7 add the illumination,
ink-extraction, vectorizing and OCR stages beside these, in the same shape.

| File | Role |
| --- | --- |
| `types.ts` | `RgbaImage`, `Quad`, presets. **A dependency-free leaf** |
| `image-ops.ts` | downscale/resample, luminance, Otsu, connected components, bilinear sampling, `rotate90` |
| `quad.ts` | find the board: hull → decimate → maximum-area quadrilateral |
| `homography.ts` | DLT solve, Zhang & He aspect recovery, the banded inverse warp |
| `pipeline.ts` | output sizing (`planRectify`) and the resumable `createRectifier` |
| `illumination.ts` | S2: flat-field estimate (van Herk dilation) + division; glare detection |
| `distance.ts` | exact Euclidean distance transform (Felzenszwalb–Huttenlocher); stroke-width estimate |
| `binarize.ts` | S3a: Sauvola-modulated strong/weak luminance gates + free-standing chroma gates |
| `components.ts` | S3b: hysteresis, per-component stats and filters, the i-dot rule |
| `color.ts` | S4: core-pixel colour voting, hue bins, snap to the drawing `PALETTE` |
| `coverage.ts` | per-pixel ink coverage — the anti-aliasing the cleaned raster paints with |
| `clean.ts` | the resumable S2–S4 job (`createCleaner`) and the mode-switchable `composeCleaned` |

Phase 5's own decisions (beyond the table in the plan):

- **Ink is decided per component, never per pixel** — hysteresis (a weak blob
  must contain a strong pixel) plus stats filters in units of the measured
  stroke width `w`. No blanket morphology anywhere; every removal is
  surgical and explainable, and the eraser-ghost golden asserts ZERO
  surviving components.
- **Colour output defaults to `'themed'`** — each component snapped to its
  `SCAN_PALETTE` hex, which is BY CONSTRUCTION a member of the drawing
  `PALETTE` (a test pins this), so scanned ink matches drawn ink and will be
  themeable for free when phase 6 vectorizes it. `'true'` keeps the voted
  measured colour — still one colour per component; this is the colour
  VOTING output, not raw pixels. Switching modes is a cheap re-compose from
  the cached extraction, never a pipeline re-run.
- **The cleaned raster is flat colour on pure white and ships as PNG**
  (photo fallback stays JPEG): flat colour compresses far better as PNG and
  JPEG ringing would haunt phase 6's tracer.
- **Ink is painted by COVERAGE, not as a 1-bit stamp.** Extraction answers
  *whether* a pixel is ink; the normalized image still knows *how much*, and
  throwing that away made every stroke edge a staircase and every thin stroke a
  candidate for dropout when the board scales the image down. `coverage.ts`
  recovers it, extends it one pixel past the mask so a stroke does not end on a
  step, and normalizes each component against its own core so a light stroke
  reads as present rather than as a translucent smear. Coverage is measured as
  `255 − min(R,G,B)` — distance from board white, not darkness, or a yellow
  marker (found by the chroma gate, not the luminance one) would come out
  nearly transparent. This is presentation only: the mask, the components and
  the colours are untouched, so phase 6 traces exactly what it would have.
- **The i-dot rule is GENEROUS on purpose, and despeckling is phase 6's job.**
  Proximity to kept ink is the whole test; a speckle-sized component within
  2·w of confidently-kept ink stays. Two UAT rounds tried to make it
  discriminate — first a shape gate (dab `dtMax ≥ 0.3·w` or fragment spanning
  ≥ `w`), then an exemption for rescued components — and both failed the same
  way. Every property that separates residue from faint ink at the RASTER
  level (size, elongation, darkness, core thickness) also separates a fading
  stroke from its own solid part, so each tightening punched holes in
  lightly-drawn circles and arrows. **Losing ink is the worse error**: a
  surviving speck is one eraser tap away, a stroke the pipeline never emitted
  is gone for good. After tracing, a speck is a path with no length and no
  continuation — a decidable question, and phase 6's to answer.
- **A component with no core INHERITS its colour.** Below `0.4·w` half-width
  every pixel is anti-aliased edge, which is desaturated by construction, so
  the vote returns black whatever the marker was — which is how a green board
  came back with black specks and a black-dashed arrow. Such a component takes
  the answer of the nearest cored component within `3·w`; with nothing in
  reach it keeps its own vote. Donors must be cored, so fragments never chain.

Four things here are decisions, not implementation details:

- **Detection is a heuristic and says so.** `detectBoardQuad` returns
  `source: 'frame'` when nothing board-shaped stood out, and the crop screen
  always shows draggable corners regardless. The Drive scanner's trick is not
  perfect detection — it is that fixing a bad guess costs one drag.
- **The aspect ratio is RECOVERED, not measured.** A board shot at an angle
  projects to a quad whose side lengths lie about its shape;
  `quadAspectRatio` inverts the projection (Zhang & He, MSR-TR-2003-39). It
  returns null on a near-fronto-parallel shot — where there is no perspective
  to invert — and `sideLengthAspect` is exactly right in that case. A test
  projects known rectangles through a synthetic camera and asks for their
  ratios back within 3%.
- **The warp is destination→source and BANDED.** Inverse mapping because
  forward mapping leaves holes; banded because 3.2 M bilinear samples in one
  loop is a frozen tab. A test asserts a banded run is byte-identical to a
  one-shot one — banding must be invisible.
- **The output long edge is clamped to what the source resolves.** Upsampling
  a 900 px quad to 1800 px invents no detail and makes every later stage
  slower for nothing.

Fixtures are GENERATED in-test, never committed as bytes: a JPEG decoder
differs across platforms and pixel-exact goldens on photos are a maintenance
trap. Real-photo fixtures arrive in phase 5, asserted as summary statistics in
ranges.

## Error policy

Malformed XML throws `WhiteboardParseError`, which the adapter turns into the
error card with an "Open as text" button (`setMode('raw')`). Everything else
degrades instead of throwing: a corrupt `wb:doc` JSON blob is dropped (the
strokes live in the SVG body, not the metadata), a missing viewBox falls back
to a default board, a foreign root opens as an Imported layer.
