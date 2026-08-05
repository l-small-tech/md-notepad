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
| `hit-test.ts` | the eraser's aim, and phase 3's selection base |
| `history.ts` | the snapshot undo stack |

`tool-settings.ts` is split out of `tools.ts` deliberately: the ribbon draws
the palette and lives in the eager entry bundle, so importing it from `tools.ts`
would pull smoothing, serialization and the XML reader into startup and quietly
undo invariant I8. Keep that module importing nothing but a type.

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

## Error policy

Malformed XML throws `WhiteboardParseError`, which the adapter turns into the
error card with an "Open as text" button (`setMode('raw')`). Everything else
degrades instead of throwing: a corrupt `wb:doc` JSON blob is dropped (the
strokes live in the SVG body, not the metadata), a missing viewBox falls back
to a default board, a foreign root opens as an Imported layer.
