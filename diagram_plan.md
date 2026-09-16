# Diagram editor — plan

Status: agreed 2026-09-15, in progress on `feat/diagram-pro`. This is the
shared brief for the four phases below; each phase is one agent, run in
order, each building on the last. Read `src/core/whiteboard/README.md` and
the `whiteboard.ts` section of `src/editors/README.md` before touching
anything — every decision below leans on the invariants they describe.

## The point

The `.svg` whiteboard is how project diagrams for knowledge bases and Marp
slides get made. Today it is a sketching surface: pen, four shapes, text,
select/move/resize, layers. This set turns it into a diagram editor for
engineers — the Lucidchart posture — without giving up the one big idea:
**the file is a plain SVG that renders identically anywhere.** Nothing in
this plan adds a `transform`, a `<foreignObject>`, or editor-only rendering.
Editor state goes in `wb:` attributes and the `wb:doc` metadata, both of
which every other renderer ignores.

Decisions already made with the user (do not re-litigate):

- Four scopes, in this order: **(A) shape styling + more shapes → (B)
  layout ops + labels → (C) grid + snapping → (D) live connectors.**
- Styling of a selection lives in the **ribbon**: with a selection active a
  swatch / nib / fill / dash / arrow-head click restyles the selected
  elements (and still sets the tool default). No floating toolbar, no
  properties panel.
- Grid settings are **per document, in `wb:doc` metadata**, never rendered
  into the file.
- One worktree, sequential phases. Each phase leaves `pnpm run check` and
  `pnpm test` green and adds a line to `CHANGELOG.md` `[Unreleased]` only
  at the end of phase D (one user-facing entry for the whole set — phase A
  creates the line, later phases extend it).

## Ground rules for every phase

- Core stays pure (I9). Every new capability is a `(doc, …) → doc` function
  in `src/core/whiteboard/` with a colocated Vitest suite; the adapter only
  wires. React components are never unit-tested.
- The serializer stays a **fixed point** and deterministic (attribute
  order, `num` rounding). Extend the golden/round-trip tests for every new
  attribute; a pre-existing file must parse and re-serialize byte-identical.
- Elements written before this work must round-trip unchanged: a new field
  whose value is the old default emits **no attribute**.
- Keep `tool-settings.ts` and `input.ts` dependency-free leaves. New
  vocabulary the ribbon needs (shape list, dash presets, arrow-head kinds,
  grid sizes) goes in `tool-settings.ts` as data only.
- Update the READMEs (`src/core/whiteboard/README.md`, the whiteboard
  section of `src/editors/README.md`) with the decisions you make, in the
  same voice — the *why*, not a changelog.
- Run `pnpm run format` then `pnpm run check` then `pnpm test`. The three
  `core/export/__tests__/pdf.test.ts` failures (missing native canvas) are
  pre-existing and environmental.
- Commit at the end of the phase with a message of the form
  `feat(diagram): <phase> — <one line>`.

## Phase A — shape styling + more shapes

**Model.** `ShapeElement` gains:

- `dash: string | null` → `stroke-dasharray` (null = solid, no attribute).
  Offer presets in `tool-settings.ts` (solid / dashed / dotted) expressed
  relative to stroke width at construction time.
- `rx: number | null` on `rect` → the `rx` attribute (rounded corners).
  A **Rounded rect** tool is a `rect` with a default `rx` (e.g. 12), not a
  new shape kind — that keeps hit-testing and transforms shared.
- Arrow heads. Today `arrow` is a `<line marker-end>`. Add `markerStart:
  boolean` (a `marker-start` pointing at a second marker def with the
  reversed orientation, or `orient="auto-start-reverse"` if you can prove
  it renders in WebView2, Chromium and Firefox — check, don't assume).
  Heads are a property of `line`/`arrow`: the kinds stay for
  compatibility; the ribbon offers none / end / both.
- Fill. `fill` already exists (`'none'` or a colour). Make it themable:
  a shape whose fill is a `PALETTE` hex needs a `wb-fN` class **alongside**
  its stroke's `wb-cN` — extend the class derivation so an element can
  carry both, and extend the palette `<style>` rules so `.wb-fN` applies to
  shapes (today the fill rule exists for scanfill blobs; check what
  `:not(text)` / `.wb-fN` scoping needs). Also offer **Paper** — fill with
  the board background (`--wb-bg`, class `wb-bg`-like rule) so a box hides
  the lines behind it on both light and dark themes. Optional
  `fillOpacity`? Only if trivial; otherwise skip.

**New shapes.** `diamond`, `triangle`, `parallelogram`, `hexagon`,
`cylinder`. All keep a bbox geometry (`x/y/width/height`) so
`transformElement`, `elementBounds` and resize need one new branch, not
five. Serialize polygons as `<polygon points="…" wb:shape="diamond">` and
the cylinder as a `<path wb:shape="cylinder">` with a fixed template.
**Parse must recover the bbox from the element itself** — polygon vertices
touch the bbox edges by construction; for the cylinder either derive from
the template's numbers or emit `wb:box="x y w h"` (your call; document it).
A `<polygon>` without `wb:shape` stays a `RawElement`. Add outlines to
`geometry.ts` / `hit-test.ts` so hit-testing follows the actual edges, not
the bbox.

**Tools.** Ribbon shape picker: the shape buttons become a compact
dropdown/popover (rect, rounded rect, ellipse, diamond, triangle,
parallelogram, hexagon, cylinder, line, arrow) — the ribbon must not grow
past its current width class. Keep the four originals one click away
(the picker's button shows the last-used shape). Shift-drag constrains a
shape to square/circle and a line to 45° steps.

**Restyle the selection.** New pure ops in `select.ts` (or a `style.ts`):
`restyleElements(doc, refs, patch)` where patch is a partial of
`{ stroke, fill, strokeWidth, dash, markerStart, markerEnd, fontSize,
fontFamily }` applied per kind (a stroke ignores `fill`, text maps `stroke`
→ `fill`, etc.). The adapter exposes `restyleSelection(patch)`; the ribbon
calls it when `selectionCount > 0` *and* updates the tool default. The
ribbon's swatches should reflect the selection's current colour when a
selection exists (mixed → none highlighted). Undoable, one step per click.

## Phase B — layout ops + labels

**Clipboard.** Ctrl+C / Ctrl+X / Ctrl+V / Ctrl+D. Internal clipboard in
`ui/stores/whiteboard.ts` (global, so copy on one board → paste on
another). Paste lands offset (+16, +16 scene units, cumulative per repeat)
on the active layer and becomes the selection. Also write the serialized
`<svg>` fragment as `text/plain` to the system clipboard so it can be pasted
into other tools; the existing `onPaste` (which handles images) must keep
working — text that parses as our fragment pastes elements, anything else
falls through.

**Z-order.** `reorderElements(doc, refs, 'front' | 'back' | 'forward' |
'backward')` within each element's own layer, returning the new refs.
Ctrl+] / Ctrl+[ (and Shift for front/back), plus a ribbon control or
context menu — a right-click context menu on the selection is acceptable
here (align/distribute/z-order/group/duplicate/delete), built in the
adapter, styled like the existing panels.

**Align + distribute.** Pure functions over the selection's bounds:
left/center/right/top/middle/bottom, distribute horizontally/vertically.
Two or more elements required (distribute: three).

**Group / ungroup — flat, by tag.** No nested `<g>`: elements gain
`group: string | null` (`wb:group="id"`). Selecting any member (click or
marquee) expands the selection to the whole group; ungroup clears the tag.
Groups never nest. Document why in the README: a nested model would ripple
through refs, hit-testing, transforms, serialization and the scan pipeline
for a feature diagrams rarely need beyond one level.

**Labels.** Text centred in a shape that follows it. `TextElement` gains
`labelOf: string | null` (`wb:label-of="<shape wb:id>"`); shapes get a
`wb:id` when first labelled (`freshElementId`, injectable randomness like
`makeLayerId`). A label is `text-anchor="middle"` with its lines stacked
around the shape's centre (compute the block height from `fontSize` and a
1.2 line height; `<tspan x dy>`). Double-click a shape → the text editor
opens centred (editing an existing label edits it in place). Moving a
shape moves its labels (selection expansion again — same mechanism as
groups); **resizing re-centres the label, it does not scale it**; deleting
a shape deletes its labels. A label with no host (host deleted externally,
or a hand-edited file) is just text. Labels on `line`/`arrow` sit at the
midpoint.

**Hotkeys** (stage focused, no modifier): V select, P pen, H highlighter,
E eraser, T text, R rect, O ellipse, L line, A arrow, G toggles grid once
phase C exists. Document them in `docs/keyboard-shortcuts.md`.

## Phase C — grid + snapping

**Settings** live in `wb:doc` metadata under `grid`: `{ show, size, snap }`
(defaults: hidden, 20, snap on when shown). Typed accessors in a new
`grid.ts`; the doc's `meta` already round-trips unknown keys, so a file
from before this work is unaffected. **Grid changes are not undo steps**,
and undo/redo carry the *current* grid settings over the restored snapshot
— toggling the grid must never come back with Ctrl+Z.

**Rendering.** The adapter injects a `<pattern>`-based dot grid into the
adopted board `<svg>` DOM *after* adoption (never into the source): dots at
the grid size, a stronger dot every 5. It must sit beneath the content and
above the page/background, scale with zoom, and use a theme-derived colour
(`--fg-muted` at low alpha). The overlay's `background: none !important`
contract stays.

**Snapping** is pure (`snap.ts`): `snapPoint(point, size)`, `snapRect`,
and **smart guides** — candidate x/y lines from the edges and centres of
every visible element not in the selection, matched within a threshold
given in screen pixels (÷ zoom). Applied to: shape drawing (start and end),
moves (the delta), resizes (the dragged handle), text placement. Grid snap
and guide snap combine (guides win within their threshold). The adapter
draws matched guides as thin accent lines in the chrome group during the
drag and clears them on release. **Holding Alt disables snapping** for the
gesture. Pen strokes never snap.

**Ribbon.** Grid toggle (G), snap toggle, and a size choice (8 / 10 / 16 /
20 / 25 / 32 / 50) in the draw controls. State flows up through
`WhiteboardUiState` like the layers panel does.

## Phase D — live connectors

**Model.** `line`/`arrow` shapes gain `from` and `to`: `{ id, port } |
null`, serialized as `wb:from="<id>:<port>"` / `wb:to`. Ports are
`n | e | s | w | c` where `c` means "aim at the centre, end on the
outline". Attaching gives the host shape a `wb:id` (same
`freshElementId` as labels). A `route: 'straight' | 'elbow'` field
(`wb:route`, straight is the default and emits nothing): elbow connectors
serialize as `<path d="M … L … L …">` with `wb:shape="elbow"`, geometry
still `x1/y1/x2/y2` plus the waypoints derived at serialize time by a pure
router (one or two bends, leave the host by the port's normal). Parse
recovers `x1/y1/x2/y2` from the path's first and last point.

**Following.** `reconnect(doc)` in a new `connectors.ts`: for every
connector with an attached end, recompute that endpoint from the host's
current outline (use the phase A outlines — an ellipse or diamond end lands
on the edge, not the bbox). The adapter runs it after every commit that
moved, resized, aligned, pasted or restyled shapes. Deleting a host
**detaches** its connectors (they keep their last coordinates) rather than
deleting them; copying a shape and its connector together keeps them
attached (ids are remapped on paste).

**Gestures.** Drawing a line/arrow: when the press lands on a shape the
start attaches (port chosen by where on the outline you pressed, snapped to
n/e/s/w when near an axis, else `c`); the same on release. Selecting a
single connector shows its two endpoint handles instead of the resize box;
dragging one over a shape re-attaches (the candidate port highlights).
Selecting a shape highlights its four ports faintly so an arrow can be
started from one. Snapping (phase C) treats ports as strong guides.

## Verification at the end (the orchestrator does this)

`pnpm run build`, `cargo check` in `src-tauri` (short `CARGO_TARGET_DIR`,
see CLAUDE.md), then a `tauri:dev` smoke run driven over CDP if possible,
and a manual QA checklist for the user covering what only a human can
judge: feel of snapping, handle sizes with a pen, connectors surviving a
Raw-mode edit, a board embedded in a Marp slide.
