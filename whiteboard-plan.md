# Whiteboard tool for md-notepad — implementation plan

> Living plan document — updated as phases complete.

## Context

The user wants a whiteboarding tool inside md-notepad: opening an `.svg` file shows a touch-first drawing editor in the editor region, with layer support and a "photograph a physical whiteboard → vectorize to SVG" pipeline. Decisions already made with the user:

- **Custom-built SVG editor** — no Excalidraw/tldraw (fits the project's dependency-freeze culture; tldraw's license is paid anyway).
- **A single self-contained `.svg` file is the source of truth** — layers are top-level `<g>` elements; editor-only state rides in a `wb:` namespace; the file renders in any browser and in markdown preview via `![](x.svg)`.
- **Touch/tablet first** (pen + finger on Android tablet), works on phone and desktop too.
- **In-app Android camera capture ships in v1**; desktop uses picker/paste/drop.

**Does this belong in md-notepad?** Yes, with more confidence than expected: `.svg` is already a first-class listed file type (it currently opens as a read-only image tab), drawings embed directly into notes via markdown image syntax with the existing preview inlining, and the app's whole premise is "your workspace folder, plain files". A standalone app would lose the note-embedding loop that makes whiteboards useful here. The one honest counterpoint — scope creep on a notepad — is mitigated by the editor being a lazy-loaded chunk (like Milkdown) that costs nothing when unused.

**Photo→SVG feasibility: confirmed, and better than first scoped.** The pipeline is rectify → flat-field normalize → hysteresis binarize → component filter → colour vote → **centerline** trace, all pure client-side TS. Centerline (skeleton) tracing rather than contour tracing means scanned content arrives as ordinary `<path wb:tool="pen">` strokes — the same elements the pen tool emits — so the traced layer is **editable, not locked**. Full spec in [Photo → SVG pipeline](#photo--svg-pipeline-scan).

## Architecture: the adapter route (verified feasible)

Open `.svg` as a normal `kind:'file'` tab whose DocModel text **is** the SVG source. Add `EditorMode 'draw'` + `AdapterKind 'draw'`. Verified against code:

- `parseManifest` (src/core/session/plan-flush.ts:151-156) hard-validates `kind` (a new TabKind would make old builds self-heal-wipe sessions) but **never validates `mode`** — a `mode:'draw'` file tab round-trips through old builds, where `kindFor` (src/core/mode-sync.ts:92) degrades it harmlessly to the CM6 source view. No schema bump.
- File-tab plumbing gives dirty tracking, session buffering, Ctrl+S/liveSave, mtime conflict detection, tear-off windows for free; **raw mode is a free CM6 SVG-source editor**.
- `createModeSync` already serializes adapter switches with sync flush-on-detach (the Milkdown precedent), and `createWritebackGuard` solves "opening a file must not rewrite it".

### File-touch list

| File | Change |
|---|---|
| `src/core/types.ts` | `EditorMode` += `'draw'` |
| `src/core/mode-sync.ts` | `AdapterKind` += `'draw'`; `kindFor` maps it; `adapters` becomes `Partial<Record<…>>` (missing factory → `onError` revert) |
| `src/core/doc-family.ts` (new) | `docFamilyFor(path)`, `allowedModesFor(family)` (`svg → ['draw','raw']`), `defaultModeFor` |
| `src/core/whiteboard/` (new) | all pure logic + colocated tests: `scene.ts`, `parse.ts`, `serialize.ts`, `geometry.ts`, `smoothing.ts`, `hit-test.ts`, `layers.ts`, `history.ts`, `input.ts`, `trace/` |
| `src/editors/whiteboard.ts` (new) | the `EditorAdapter`, lazy-loaded like Milkdown (I8); only DOM-touching code (DOMParser walk, canvas getImageData, render) |
| `src/editors/whiteboard-toolbar.ts`, `src/styles/whiteboard.css` (new) | toolbar + layers panel |
| `src/ui/components/EditorHost.tsx` (~:101) | supply `draw` factory only when `docFamilyFor === 'svg'` |
| `src/ui/components/StatusBar.tsx` (:16-21, :79-85) | mode segments from `allowedModesFor` (svg tabs: Draw \| Raw) |
| `src/ui/components/Ribbon.tsx` | gate markdown formatting in draw mode (mirror wysiwyg branches at :68, :108) |
| `src/ui/stores/tabs.ts` (~:741) | `setMode` validates via `allowedModesFor`; `openFileTab` takes initial mode |
| `src/ui/session/open-save.ts` (:107-170) | route `.svg` → file tab `mode:'draw'` **before** the `isImagePath` branch (read-only workspaces keep image-tab behavior) |
| `src/ui/session/windows.ts` (:182) | restore inference: `.svg` → `'file'` |
| `src/core/whiteboard/scan/` (new, phases 4–7) | pure scan pipeline + colocated tests: `types.ts`, `quad.ts`, `homography.ts`, `illumination.ts`, `binarize.ts`, `components.ts`, `color.ts`, `distance.ts`, `thin.ts`, `skeleton-graph.ts`, `contour.ts`, `text-layout.ts`, `ocr.ts`, `pipeline.ts` |
| `src/editors/whiteboard/scan-ui.ts` (new) | image decode/encode (`createImageBitmap`, canvas `getImageData`, JPEG re-encode), crop screen, review dialog — the only DOM in the scan path |
| Phases 4 + 7: `AndroidfsPlugin.kt`, plugin `AndroidManifest.xml`, plugin `android/build.gradle.kts`, plugin `src/mobile.rs`, `src-tauri/src/commands/android.rs`, `src-tauri/src/lib.rs`, `src/ipc/commands.ts` | `capturePhoto` + `recognizeInk` chains — both copy the existing `stt_*` bridge shape verbatim (`src-tauri/src/commands/android.rs:212-256`, `src/ipc/commands.ts:190-204`) |

Untouched: `parseManifest`, flush planner, Rust `fs.rs`, `IMAGE_MIME`/`IMAGE_EXTENSIONS` (`.svg` stays an image type for preview inlining).

**Core purity:** `src/core` is DOM-free. The plan originally had the adapter do a DOMParser walk into plain records; Phase 1 replaced that with a ~250-line pure XML reader (`core/whiteboard/xml.ts`) that yields **source spans**. Two reasons, both load-bearing: the format's goldens must run in the node test env with no shims, and "nothing is ever dropped" needs to re-emit unmodeled content by slicing the ORIGINAL text — which `XMLSerializer` cannot do, because it reformats. `parse.ts` and `serialize.ts` (deterministic: fixed attr order, 2-decimal coords) sit on top and are golden-tested. The adapter still uses DOMParser, but only to *render* the source text.

## SVG format spec

```xml
<svg xmlns="http://www.w3.org/2000/svg" xmlns:wb="urn:md-notepad:whiteboard"
     viewBox="0 0 1600 1000" width="1600" height="1000">
  <metadata><wb:doc>{"schema":1,"background":"#ffffff","view":{…}}</wb:doc></metadata>
  <defs>…arrow marker…</defs>
  <g wb:layer="a1B2" wb:name="Layer 1">…strokes/shapes/text…</g>
  <g wb:layer="c3D4" wb:name="Photo" wb:locked="true" display="none">…</g>
</svg>
```

A scanned layer is a normal (unlocked) layer that additionally carries its recognized text:

```xml
<g wb:layer="e5F6" wb:name="Scan 1" wb:kind="scan">
  <title>Sprint planning board</title>
  <desc>ARCHITECTURE
api gateway -&gt; auth service
cache?</desc>
  <g wb:ocr="text" opacity="0" font-family="sans-serif">
    <text x="120" y="86" font-size="34" textLength="212" lengthAdjust="spacingAndGlyphs">ARCHITECTURE</text>
    …one &lt;text&gt; per recognized line, positioned on the ink…
  </g>
  <path wb:id="s1" wb:tool="pen" d="M…C…" fill="none" stroke="#1f6fd0" stroke-width="4.2" stroke-linecap="round"/>
</g>
```

**Why this shape for OCR output** (the "easy for AI to use" requirement):
- `<desc>` is standard SVG and is the first thing any consumer — a screen reader, a grep, an LLM handed the raw file — sees. Full plain text, reading order, no custom parsing.
- The `opacity="0"` `<text>` group is the PDF-scanner trick: renders nothing anywhere, stays selectable/copyable in a browser, and preserves **spatial** layout, so a consumer knows *which label sits on which box*. `textLength`/`lengthAdjust` pin each line to the exact width of the ink it came from.
- Structured detail (per-line confidence, boxes, engine + version, timestamp, and the `wb:id`s of the strokes each line came from) goes in the doc metadata JSON under `ocr[layerId]`. Confidence is not optional: a consumer must be able to tell 0.95 from 0.4.
- The OCR group is invisible to the editor's tools — excluded from hit-test, not listed in the layers panel, regenerated wholesale when OCR re-runs. Strokes gain `wb:id` only inside scan layers (drawn strokes stay id-free to keep files small).

- Anything a foreign renderer must honor uses **standard SVG** (layer visibility = `display`, colors/widths = presentation attributes); editor-only state uses `wb:` attrs + the metadata JSON. Root viewBox recomputed on save to cover content.
- `SceneDoc` is immutable (structural sharing) → snapshot undo is trivial.

**Round-trip guarantees:**
1. Mount → look → close is **byte-identical** (`createWritebackGuard`; serialize only after a genuine user edit — same accepted normalize-on-first-edit contract as Milkdown).
2. Nothing dropped: `<defs>`/`<style>`/comments re-emitted verbatim in a `prelude`; unrecognized top-level content becomes a **foreign layer** — rendered live, listed as "Imported", locked (toggle/reorder/delete as a whole only), re-emitted byte-for-byte.
3. Foreign SVGs (Inkscape, hand-authored) open in draw mode with content as a locked foreign layer; user draws on layers above. Malformed XML → error card with an "Open as text" button (`setMode('raw')`).

## V1 feature set → SVG mapping

| Feature | Mapping |
|---|---|
| Pen / highlighter | `<path wb:tool="pen" d="M…C…" fill="none" stroke-linecap="round">` — one-euro filter + Catmull-Rom→Bézier, **hand-rolled (~90 lines), no perfect-freehand dep** (its filled-outline output breaks stroke semantics; revisit later as a separate "brush" tool). Pressure captured into memory from day 1, constant-width rendering in v1. |
| Eraser | whole-stroke delete via hit-test on cached flattened polylines (no masking — bloats files); pen eraser-end auto-switches |
| Rect/ellipse/line/arrow | native elements; arrow = `marker-end` with a `<marker>` ensured in defs |
| Text | `<text>` + `<tspan>` per line; edited via positioned textarea overlay |
| Select/move/resize | **bake coordinates** (rewrite points/x/y/w/h), no stacked transforms; foreign elements not selectable |
| Undo/redo | snapshot stack of immutable `SceneDoc`s, cap 200; per-adapter-instance (lost on Draw⇄Raw switch — matches documented raw⇄wysiwyg history limitation); each op → serialize (150 ms debounce) → `model.pushText` |
| Layers panel | add/rename/reorder/toggle/lock/delete as pure `(doc, …) → doc` ops |
| Pan/zoom | reuse `src/core/diagram-zoom.ts` (`zoomDiagramAt`, `panDiagram`, `fitDiagramView`) unchanged |

**Toolbar placement — revised after Phase 1 QA.** The original plan put the draw tools in a dedicated left rail (≥700 px) or bottom bar. The user's call instead: **the existing top ribbon becomes the draw toolbar in Draw mode** — the same strip that shows bold/italic/etc. for markdown swaps to pen/highlighter/eraser/shapes/text/colors. That is one toolbar to learn, not two, and it keeps the full pane for the board. The phone/tablet layout can still collapse it to a bottom bar (Phase 3); the desktop shape is now the ribbon. Phase 1 gates the markdown formatting actions out of Draw mode; Phase 2 replaces them.

Phase 2 shipped the ribbon toolbar: tool buttons latch (`data-active`), the eight-colour palette and four nib sizes are inline swatch groups, and undo/redo/layers sit at the right. Phase 3 owns the phone/tablet collapse to a bottom bar.

**Touch UX:** pointer events, `touch-action:none`, `setPointerCapture`, `getCoalescedEvents`. Pure `routePointer` classifier in `core/whiteboard/input.ts`: pen = tool, 1-finger = pan, 2-finger = pinch, mouse = tool (+wheel zoom, space/middle pan); "draw with finger" toolbar toggle (default on until first pen seen). Palm rejection: ignore touches while pen down +300 ms, oversized contacts, and cancel-undo a touch stroke if pen lands within 150 ms. Toolbar: left rail ≥700 px, bottom bar on phones; ≥44 px targets.

## Photo → SVG pipeline ("Scan")

Target: point a camera at a physical whiteboard from anywhere in the room and get back clean, straight, **editable** ink — Google-Drive-scan ergonomics with a vectorizer on the end.

### Design commitments

These four decisions drive every detail below; they are the answers to the four hard requirements.

1. **Output editable strokes, not a locked blob.** Centerline (skeleton) tracing emits the same `<path wb:tool="pen">` elements the pen tool emits, through the same `smoothing.ts`. So eraser, select/move, recolour, undo all work on scanned content — any artifact that survives the filters is two taps from gone, which is the real answer to "noise must not ruin the SVG". Contour-fill tracing survives only as a per-component fallback for genuinely blobby ink.
2. **Normalize illumination before deciding what is ink.** Every lighting failure — side light, cast shadow, vignette, warm/cool colour cast — is a smooth *multiplicative* field over a board that is white by definition. Estimate that field and divide it out. Everything downstream (thresholds, colour bins) then works with fixed constants instead of per-photo tuning.
3. **Decide ink per connected component, never per pixel.** Per-pixel adaptive thresholds are exactly what turn eraser ghosting into speckle: they force a light/dark split even inside a window that is uniformly blank. Strong/weak hysteresis plus component statistics remove ghosting without eating the dot of an *i*.
4. **Every stage is a pure function over typed arrays**, in `src/core/whiteboard/scan/`, deterministic, taking a progress callback and a cancellation token. The adapter only decodes images, encodes JPEG, and draws UI. Determinism is what makes the goldens possible.

Reference for the whole approach: Zhang & He, *Whiteboard Scanning and Image Enhancement* (Microsoft Research, MSR-TR-2003-39) — the paper is about precisely this problem and supplies both the rectangle-aspect recovery and the background-whitening idea used below.

### S0 — Acquire

- **Android:** `capturePhoto` in `AndroidfsPlugin.kt`, copying existing patterns — permission alias (like `"microphone"`), `ACTION_IMAGE_CAPTURE` + `EXTRA_OUTPUT` FileProvider temp URI (FileProvider already declared), `@ActivityCallback` (like `onTreePicked`, :362-411), resolve to base64 (like `readContentUri`). `CAMERA` in the plugin manifest. Rust: `run_mobile_plugin` binding → `capture_photo` command (`Result<String,String>`) → `generate_handler!` under `cfg(android)` → `ipc.capturePhoto()`. **Kotlin must normalize orientation (`ExifInterface`) and downscale to ≤2600 px long edge, re-encoding at q≈0.9, before base64.** A raw 12 MP JPEG is ~8 MB of base64 string crossing IPC and then sitting in a JS string — unacceptable on a tablet, and it buys nothing the pipeline uses.
- **Desktop:** open dialog + `read_file_base64`, clipboard paste (pattern: `src/editors/image-paste.ts`), drag-drop. EXIF via `createImageBitmap(blob, { imageOrientation: 'from-image' })`.
- Everything flows as base64 `data:` URLs — CSP is `default-src 'self'; img-src 'self' data:`, so `blob:` URLs are unusable. Decode with `createImageBitmap` on an in-memory `Blob` (not a `blob:` URL — that is a CSP fetch and is blocked) → offscreen canvas → `getImageData`. Fallback `<img src="data:…">`, which `img-src` permits.

### S1 — Detect the board and rectify it

Auto-detect, then **always show the quad and let the user drag the corners** — auto-detection will sometimes be wrong, and the Drive scanner's whole trick is that correcting it costs one drag.

| Step | Method |
|---|---|
| Detect at low res | Downscale to ~480 px long edge — detection does not need pixels |
| Find the board | Otsu on luminance → largest bright 8-connected component → convex hull. A whiteboard is a big bright quad on a darker wall; this beats Hough lines for both robustness and code size |
| Hull → 4 corners | RDP-simplify hull to ≤12 vertices, then brute-force the maximum-area quadrilateral over all 4-subsets (C(12,4)=495 — free). Seed/validate with the four extremes of ±x±y |
| No board found | If the bright component touches all four image borders (board fills frame) or covers <15% / >98% of the frame, fall back to the full frame with a manual quad |
| True aspect ratio | Zhang & He's closed form: from the quad's homogeneous corners derive `k2`,`k3`, then `n2`,`n3`, solve for focal length `f²` assuming the principal point is the image centre, and recover `(w/h)²`. Degenerate when the shot is near fronto-parallel (`f² ≤ 0`) → fall back to the mean of the two opposite-side-length ratios |
| Warp | 8×8 DLT solve (Gaussian elimination with partial pivoting) for the homography, then **inverse**-map every destination pixel with bilinear sampling |

Output long edge = the quality preset (Fast 1200 / **Balanced 1800** / Detailed 2400 px), clamped to the source's resolution. Cost at 1800 px ≈ 3.2 M samples, roughly 0.2–0.5 s on a mid tablet, chunked by row-bands with yielding.

Why resolution matters: legible handwriting needs the marker stroke to survive as ≥5–6 px so the skeleton is stable, and OCR wants ≥25 px x-height. 1800 px across a 2 m board puts a 1 cm marker stroke at ~9 px and 3 cm letters at ~27 px. 1200 px is the "it's a diagram, not prose" preset.

### S2 — Kill the lighting (the flat-field stage)

This is the stage that makes "wide variety of lighting situations" a solved problem rather than a tuning exercise.

1. Downscale the rectified image ×⅛.
2. Grayscale **dilation** (running-max, van Herk/Gil-Werman, O(1) per pixel per axis, separable) with a window ≈ 1/8 of the image width. The window is far wider than any stroke, so the local max recovers *board*, not ink → this is an estimate of the illumination field per channel.
3. Light box-blur, then bilinear upsample back to full resolution.
4. `normalized = clamp(255 × pixel / background)` — **per channel**.

Per-channel division does three jobs at once: shadow/gradient removal, vignette removal, and **automatic white balance** (the board is neutral by definition, so dividing by its measured colour removes the tungsten yellow or daylight blue cast). That last one is why colour classification downstream can use fixed hue bins.

**Glare** is the one thing division cannot fix: blown highlights have no information left. Detect them (background ≥ ~250 *and* local variance ≈ 0 over a wide window), mask them out of all downstream stages so they cannot manufacture ink, and if they exceed ~4% of the board area show a "glare detected — try shooting from off-axis" hint in the review screen. Honest degradation beats silent garbage.

### S3 — Extract ink without extracting ghosts

Post-normalization the image is "white board, coloured ink, near-uniform light". Ink is now anything dark **or** anything saturated (light markers — yellow, orange, pink — are bright but chromatic, so a luminance-only test loses them):

```
chroma = max(R,G,B) − min(R,G,B)
strong = L < 0.62 || (chroma > 0.28 && L < 0.88)
weak   = L < 0.80 || (chroma > 0.14 && L < 0.94)
```

Both gates are additionally modulated by **Sauvola** (`T = m·(1 + k·(s/R − 1))`, k≈0.2, window ≈ 24 px) rather than Bradley. Sauvola's dynamic-range term is the point: in a low-variance window it *declines* to threshold, so blank board stays blank. Bradley has no such term and is a speckle generator on empty regions.

Then, in order:

1. **Hysteresis.** Label the `weak` mask's components; keep a component only if it contains at least one `strong` pixel (Canny's rule applied to blobs). Faint eraser smear never reaches `strong` anywhere along its length and dies wholesale; a genuinely light stroke that touches solid ink survives intact. This single rule does most of the artifact removal.
2. **Estimate the stroke width** `w` for the page: exact Euclidean distance transform (Felzenszwalb–Huttenlocher, O(n), ~40 lines) over the kept mask, take the median of local maxima → `w` px. Every threshold below is expressed in units of `w`, never in absolute pixels, so the filters behave the same at every preset and camera distance.
3. **Component filters** (each computed once into a stats record: area, bbox, perimeter, solidity, thinness `P²/A`, mean strong-ratio, mean chroma, distance-transform max):

   | Reject | Rule | Kills |
   |---|---|---|
   | Speckle | `area < 0.5·w²` | sensor noise, dust, dry-erase residue dots |
   | Faint smear | `strongRatio < 0.15` | eraser ghosting, shadow edges |
   | Diffuse blob | `thinness < 20` **and** `strongRatio < 0.5` **and** `area > 40·w²` | smudges, hand shadow, wall texture. The `strongRatio` conjunct is what spares an intentionally filled-in shape, which is blobby but *dark* |
   | Frame / furniture | touches image border **and** `area > 200·w²` | board tray, marker rail, window frame left in the crop |
   | Glare | ≥60% of pixels inside the glare mask | blown-highlight edges |

4. **The i-dot rule.** Before dropping a speckle-sized component, spare it if a kept component lies within `2·w` — that is what preserves i-dots, accent marks, colons, dashed lines and arrowheads while still removing isolated grit. Without this rule, an aggressive despeckle silently makes handwriting unreadable.
5. **No blanket morphology.** No global open/close, no 3×3 median: at these stroke widths they erode thin diagonals and cost real legibility. All removal is component-level and therefore surgical and explainable.

### S4 — Colour

Basic marker colours, done at component level so a stroke is never a rainbow.

- Convert each ink pixel of a component to hue/chroma/value from the **white-balanced** RGB of S2.
- Vote using **core pixels only** — pixels whose distance-transform value ≥ 0.6·(component max). Anti-aliased stroke edges are desaturated and hue-shifted, and black strokes routinely show blue/purple fringing from demosaicing; core-only voting removes both effects.
- `chroma < 0.12` → **black**. Otherwise bin the median core hue: red (<20° or >340°), orange (20–45), yellow (45–70), green (70–165), teal (165–200), blue (200–260), purple (260–340). Eight buckets covers every standard marker pack.
- Snap to a canonical palette (`#1a1a1a`, `#d02f2f`, `#e07b00`, `#c9a400`, `#1f9d55`, `#0f8f8f`, `#1f6fd0`, `#8a3fd1`) so output is clean, consistent and themeable (snapped strokes pick up the palette-slot classes of [Themable ink](#themable-ink-palette-slots-as-css-variables) for free); "preserve measured colour" is an option in the review dialog and opts those strokes out of theming. Both the snapped and the measured colour go in the metadata.
- The review dialog lists detected colours with stroke counts and lets the user remap or merge any of them (e.g. "teal → blue", "everything → black"), which is also the escape hatch when a marker is genuinely ambiguous.

### S5 — Vectorize

**Per component**, choose the representation from the shape (the same stats S3 already computed):

- **Stroke-like** (thinness ≥ 20, or `area ≈ skeletonLength · w` within ~2×) → **centerline**.
- **Blob-like** → **contour fill**: marching squares + RDP → `<path fill="…" wb:tool="scanfill">`.

Centerline path, per component, inside its bbox only:

1. **Thin** to a 1-px 8-connected skeleton — Zhang–Suen, with an active-border queue so cost is O(ink pixels) rather than O(image) per iteration. Ink coverage is typically 2–6% of the board.
2. **Graph.** Classify skeleton pixels by neighbour count: 1 = endpoint, 2 = path, ≥3 = junction. Walk edges between nodes into polylines.
3. **Prune spurs** shorter than `1.2·w` — thinning always grows little barbs at stroke ends and crossings.
4. **Continue through junctions.** At a junction, pair incoming edges by angle continuity (smallest turn) so an "X" becomes two smooth strokes rather than four stubs, and a crossed-out word stays readable. This step is most of what makes traced handwriting look hand-drawn instead of shattered.
5. **Width.** Sample the distance transform along each centerline; emit `stroke-width = 2 × median`. Store the per-vertex widths in a `wb:widths` attribute — costs nothing now, and is exactly what a future variable-width brush needs (matching the plan's "pressure captured from day 1" stance).
6. **Fit.** RDP with **ε = 0.35·w** (scaled to stroke width, *not* a constant — a constant ε is what destroys small handwriting while barely touching big shapes), then Catmull-Rom → cubic Bézier through the **same `core/whiteboard/smoothing.ts`** the pen tool uses. Traced strokes are therefore format-identical to drawn ones.
7. Map from rectified-image pixels to scene coordinates with one affine (fit to board width, preserve aspect), rounded by the existing serializer.

**Size guard:** a dense board can yield thousands of strokes. If the result exceeds ~4000 strokes or ~1.5 MB serialized, raise ε and re-fit (geometry only — no re-tracing) until it fits, and say so in the review dialog. This keeps multi-MB strings out of the session flusher (risk 4).

**Budget** at Balanced/1800 px on a mid-range tablet: rectify ~0.4 s, normalize ~0.2 s, binarize+CC ~0.4 s, EDT+thin ~0.6 s, graph+fit ~0.3 s → **≈2 s**, chunked with yielding and a staged progress bar (`decode → detect → rectify → light → ink → colour → trace`). Main thread, not a worker: a same-origin bundled worker *is* CSP-legal (`worker-src` falls back to `default-src 'self'`), but for a 2 s job with progress it is not worth the structured-clone plumbing. Note it as an optimization, not a requirement.

### S6 — OCR

Handwriting recognition in dependency-free TS is not a thing; be honest about that and make it a **port** — `TextRecognizer` in `core/whiteboard/scan/ocr.ts` — with platform implementations behind it, so the SVG representation is fixed even where no engine exists.

First, a pure prerequisite that pays off regardless: **`text-layout.ts`** groups traced strokes into words and lines (y-band overlap, then x-gap < ~1.5× median gap) and classifies clusters as text-ish vs diagram-ish (height consistency + horizontal runs). It gates what gets sent to OCR (don't ask an engine to read an arrow) and it positions the hidden `<text>` elements. Pure, table-testable.

| Platform | Engine | Notes |
|---|---|---|
| **Android (primary)** | ML Kit **Digital Ink Recognition** | Built for handwriting, on-device, offline, per-language downloadable models. It takes *strokes* — which S5 just produced for free. Risk: it expects roughly written order; mitigate by submitting one ink per detected **line** in reading order with a writing-area hint. Bridge is the `stt_*` shape: `ink_recognize_available` / `ink_recognize` |
| **Android (fallback)** | ML Kit **Text Recognition v2** on the cleaned raster | Printed-text model; decent on block capitals, weak on cursive. Used when the ink model is unavailable or returns low confidence |
| **Desktop** | none by default | Metadata records `"status":"unavailable"`. tesseract.js was considered and rejected: it needs a CSP `wasm-unsafe-eval` grant, 2–15 MB of assets against a dependency-freeze culture, and it is a *printed*-text engine — poor value for handwriting |
| **Optional, opt-in** | cloud vision API, user-supplied key | Off by default, explicit consent, and the dialog must state plainly that the image leaves the device. The port makes it a drop-in |

Gradle: `com.google.mlkit:*` goes in the plugin's `android/build.gradle.kts` `dependencies {}` block. Prefer the Play-Services-delivered variant (no APK size cost) with the bundled variant as a build flag.

**OCR never blocks the scan.** Strokes insert first; recognition runs after and patches the metadata + hidden text group asynchronously, with its own undo-invisible edit. Output format is specified in [SVG format spec](#svg-format-spec) above. The review dialog gets a "Copy recognized text" button — and "insert recognized text into the current note" is the obvious v1.5 follow-on, since this *is* a markdown notepad.

### S7 — The review flow (the Drive-scan ergonomics)

1. **Capture / pick.**
2. **Crop screen** — detected quad with large draggable corner handles, magnifier loupe under the finger, rotate 90°, "use whole image", retake.
3. **Processing** — staged progress, cancellable.
4. **Review** — toggle between cleaned raster and vector preview; controls: *Sensitivity* (one knob → threshold offsets + hysteresis strictness), *Detail* (ε + preset resolution), colour chips with counts/remap/merge, "keep source photo as a dimmed locked reference layer" (default off). The slider re-runs S3–S5 at half resolution off the cached normalized buffer (~150 ms) so it feels live; accept re-runs at full resolution.
5. **Insert as strokes** (primary) / **Insert as photo** (fallback: rectified JPEG q≈0.7 in an `<image>` layer, warn >2 MB) / Retake / Cancel.
6. Content lands in a new **unlocked** layer "Scan 1", fitted to the current view, as **one undo step**. Because it is ordinary strokes, the eraser cleans up anything the filters missed; add "select all in layer" so a bad scan is one action to discard.

### Testing

- **Synthetic goldens, generated in-test** (no fixture bytes, fully deterministic): draw known shapes/strokes into an RGBA buffer, apply a synthetic illumination ramp + vignette + colour cast + gaussian noise + a faint "eraser ghost" band, run the pipeline, assert component count, colours, that the ghost produced **zero** strokes, and centerline length within tolerance.
- **Homography**: property test — random quads round-trip forward∘inverse within 1e-6; known-corner fixture; aspect recovery on a synthetically projected known rectangle within 3%.
- **Illumination**: after normalization, background std must drop below a fixed bound on a ramp fixture; per-channel division must neutralize an injected colour cast.
- **Colour**: table test over ~30 real marker RGB samples × 3 white-balance casts.
- **Skeleton graph**: junction continuation on a synthetic "X", "T", and crossed-out word; spur pruning idempotence.
- **Real photos** — a handful of ≤800 px JPEGs committed as fixtures (side-lit, glare, angled, four marker colours, visible eraser ghosting). Assert **summary statistics in ranges** (component count, colours detected, path count, no strokes inside the known-blank region), never byte-exact output — JPEG decode differs across platforms and pixel-exact goldens on photos are a maintenance trap.
- **Fixture decoding in the node test env**: a ~80-line test-only PNG chunk parser using node's built-in `zlib` (`__tests__/helpers/png.ts`). Keeps fixtures viewable in the repo as PNGs with **zero dependency** and no core-purity violation.

## Themable ink (palette slots as CSS variables)

Goal: a whiteboard follows the viewer's theme — dark app shows a dark board with light ink — while the `.svg` stays a standalone, standard file that renders correctly everywhere, including renderers with no CSS support.

**Mechanism — class + embedded style, literal hex as fallback truth.** `var()` is invalid in presentation attributes, but CSS *overrides* presentation attributes, which is exactly the layering needed:

- An element whose color is one of the 8 palette slots keeps its concrete light-theme hex in the presentation attribute (canonical, deterministic, what a dumb rasterizer uses) **and** gains `class="wb-c6"` (slots `wb-c0…wb-c7`, plus `wb-bg` on the background rect).
- One serializer-owned `<style wb:role="palette">` block in `<defs>` defines the slot variables with light defaults and `@media (prefers-color-scheme: dark)` overrides, and maps classes to `stroke:/fill: var(--wb-cN, <hex>)`. Any CSS-capable renderer — browser `<img>`, GitHub, the app — themes automatically; everything else falls back to the literal hex. Since the preview inlines images as `data:` URLs in `<img>`, whiteboards embedded in notes flip with the OS scheme for free.
- **Scoping is load-bearing:** all rules scope to the root `svg` element (attribute-selected, e.g. `svg[wb\:role]` or a root class), never `:root` — the SVG gets inlined into HTML contexts (export, mermaid-style DOM inlining) where `:root` is the page. And the block must carry `wb:role="palette"` so parse recognizes it as tool-owned and regenerates it, instead of the verbatim-prelude rule freezing it as foreign content.
- Custom (non-palette) colors stay literal and unthemed — no class, no entry in the block. The color picker's 8 swatches are therefore *roles*; a custom hex is an explicit opt-out. Scan S4 already snaps to this same canonical palette, so **scanned strokes are themable with zero extra scan work**; "preserve measured colour" opts a stroke out exactly like a custom hex.

**In-app override.** The app theme can be forced independent of the OS (`src/ui/theme.ts`), and pluggable theme JSONs may want their own board palette. The draw adapter (live DOM) sets `--wb-c0…c7`/`--wb-bg` as inline style on the root `<svg>` from the active theme — inline style beats the embedded block, so forced-dark-on-light-OS renders correctly while editing. Known residual mismatch: `<img>`-based preview only sees the OS media query, not the forced app theme; acceptable for v1, and the documented fix (inline whiteboard SVGs into the preview DOM the way mermaid diagrams are) is an optional follow-on.

**Dark variants** are auto-derived (near-black → near-white; chromatic slots lightened toward their hue's dark-background-legible tone), overridable by a `whiteboard` section in theme JSON files. The 8 derived defaults are constants next to `PALETTE` in `tool-settings.ts` (same eager-bundle leaf constraint).

**Round-trip.** The style block and classes are injected only on a genuine user edit — the same accepted normalize-on-first-edit contract; mount → look → close stays byte-identical. Serializer emits the block deterministically (fixed rule order); format goldens extend to cover it. Additive to schema 1: old builds and foreign renderers ignore the classes and read the presentation attributes. A per-document `"themed": false` in `wb:doc` metadata disables emission entirely.

## Phases (each independently shippable; worktree workflow per CLAUDE.md)

**Phase 1 — Format, routing, view + raw editing. ✅ SHIPPED** (branch `feat/whiteboard-format`). scene/parse/serialize, doc-family, mode/adapter plumbing, routing, StatusBar/Ribbon gating, adapter that renders + pans/zooms (read-only tools), error card; raw mode fully working.
*Verify:* `pnpm run check && pnpm test` (round-trip goldens incl. real Inkscape + hand-authored fixtures); tauri:dev — open svg, Draw⇄Raw, edit raw, save, reopen; opening without editing never dirties; `![](x.svg)` preview intact.

Automated verification is green: `pnpm run check`, 803 tests (56 new), `pnpm run build`, `cargo check`, and `tauri:dev` launches clean. The whiteboard is its own ~10 KB lazy chunk (I8 confirmed).

**First QA round found one defect, now fixed:** Draw mode rendered blank. `.editor-pane` (app.css) is a plain block with `height:100%`, not a flex container, so the adapter's `flex: 1 1 auto` root collapsed to zero height; it now sizes itself explicitly, the same way `.cm-editor` already did. The same round surfaced a second, quieter bug: every tab's editor is built while the tab is HIDDEN (I7 mounts them all), so the initial fit-to-window measured 0×0 and the board would have sat unscaled at the top-left — a ResizeObserver now re-fits once the stage has real pixels.

**Raw mode now highlights as XML**, not markdown: `editors/xml-highlight.ts` is a CM6 `StreamLanguage` tokenizer (~110 lines, no new dependency — `@codemirror/lang-xml` was declined because a highlighter only needs to tokenize). Colors are CSS variables from base.css reusing the same `--md-*` vocabulary as the markdown style and the Read pane, so light/dark and every theme plugin work with no extra code. XML mode also drops the markdown-only auto-bullet and list-Tab keymaps, which would be wrong in SVG source.

Decisions taken during Phase 1 that the spec above did not pin down:

- **Background** is stored in the metadata JSON *and* rendered as a `<rect wb:role="background">` right after `<metadata>`, so the board is white in a foreign renderer too. Parsing consumes that rect rather than treating it as content.
- **`wb:kind="foreign"`** is a real layer kind, not just an in-memory flag. Once an imported SVG's body has been wrapped in an Imported layer and saved, re-opening must recognize it as still-foreign (locked, not tool-owned) instead of demoting it to a draw layer.
- **`lastFileMode` never records `'draw'`.** Draw is a property of the file, not a preference — otherwise opening a whiteboard would change the mode the next note opens in.
- A `.svg` in a **read-only workspace** keeps the old image-viewer behavior; only writable ones route to the whiteboard.
- The full v1 element vocabulary (stroke / rect / ellipse / line / arrow / text / image) is already parsed and serialized, so Phase 2 only has to *create* elements, not extend the format.

**Phase 2 — Drawing. ✅ SHIPPED** (branch `feat/whiteboard-draw`). Pen/highlighter/eraser/shapes/arrow, undo/redo, layers panel, write-back on first edit, "New whiteboard" entry point, ribbon-as-toolbar, explorer submenu. Mouse+pen input only.

*Verify:* check+test (smoothing/hit-test/history/layer goldens & invariants); desktop draw-save-reopen-in-browser renders identically; right-click → New whiteboard creates and opens a board in the clicked folder.

Automated verification is green: `pnpm run check`, 888 tests (85 new across geometry/smoothing/tools/layers/hit-test/history), `pnpm run build`, `cargo check`, and `tauri:dev` launches and runs clean.

New pure modules, all colocated-tested: `geometry.ts` (path flattening, distances, rects), `smoothing.ts` (1€ filter → RDP → Catmull-Rom Béziers), `tool-settings.ts` + `tools.ts` (gesture → element), `layers.ts`, `hit-test.ts`, `history.ts`. `serialize.ts` gained `serializeElement` (exported) and `blankWhiteboardSource()`.

Decisions taken during Phase 2 that the spec above did not pin down:

- **The board renders from serialized source, not from a second DOM builder.** After the first edit the adapter renders `serializeWhiteboard(scene)` through the same DOMParser path Phase 1 used for the file's own bytes. One rendering path means the pane physically cannot drift from the format, and it costs a serialize+parse per commit (sub-millisecond at these sizes). The in-progress stroke lives on a transparent overlay drawn with `serializeElement`, so the drag preview is the committed element.
- **`tool-settings.ts` is a dependency-free leaf, split from `tools.ts`.** The ribbon is in the eager entry bundle and needs the palette; importing it from `tools.ts` would have pulled smoothing, serialization and the XML reader into startup. Verified after the split: the whiteboard is still its own 21.6 KB lazy chunk and only the colour constants reach the entry bundle.
- **Tool/colour/nib are global, undo is per-tab.** The marker you picked stays picked on the next board (what every drawing app does); undo depth is genuinely per-document and is keyed by tabId in `ui/stores/whiteboard.ts`. The adapter *pulls* tool settings at each gesture start and *pushes* undo state via `onStateChange`, so neither side subscribes to the other.
- **The layers panel and zoom cluster stay in the adapter**, not the ribbon. That removes all the plumbing a ribbon-hosted panel toggle would need, and keeps the lazy chunk self-contained.
- **The eraser deletes whole elements** (no masking — see `core/whiteboard/README.md` for why), and a whole drag is **one** undo step. Removals paint immediately; Escape restores from the last committed snapshot.
- **Menu shape deviates slightly from the plan above.** "New whiteboard" sits beside New file / New folder — that is where it belongs semantically and it is far more discoverable — while "Import document…" became a drill-in **Import ›** page holding *Document…*. Phase 4's *Whiteboard scan…* joins that page with no restructuring, which was the point of the original instruction. Drill-in rather than hover flyout: Android has no hover.
- **The first stroke on a foreign SVG creates its own layer**, inside the same undo step (`ensureDrawLayer`) — an imported board has only its locked "Imported" layer, and drawing must not require a trip to the layers panel first.
- **Deleting the last layer empties it** instead of removing it. A board with nowhere to draw is a dead end the UI would then have to explain.
- **`viewBox` is NOT recomputed on save.** The plan mentions growing it to cover content; doing so would resize the board out from under the user mid-stroke. Deferred to phase 3, where selection makes "fit the board to its content" an explicit command.
- **The board background stays a literal white `<rect>`** — QA asked whether it should follow the app theme. It cannot, as a plain literal: the same bytes have to render correctly in a browser and in the markdown preview. That question is what Phase 2.5 below answers properly, via palette slots.

**Phase 2.5 — Themable ink. ✅ BUILT** (branch `feat/whiteboard-theme`; desktop QA pending). Palette-slot classes + serializer-owned scoped `<style wb:role="palette">` block with dark-scheme media query, dark-variant constants beside `PALETTE`, adapter inline-var override from the active theme, theme-JSON `whiteboard` override section, `"themed"` metadata toggle. Spec in [Themable ink](#themable-ink-palette-slots-as-css-variables).
*Verify:* format goldens for the block + classes; open-without-edit stays byte-identical; saved board in a browser flips with OS dark mode; forced app theme themes the editor correctly; a custom-hex stroke stays untouched in both schemes; export fallback renders the literal hexes.

Automated verification is green: `pnpm run check`, 906 tests (18 new: `theming.test.ts` goldens + theme-plugin `whiteboard` section), `pnpm run build` (whiteboard still its own lazy chunk), `cargo check`.

Decisions taken during Phase 2.5 that the spec above did not pin down:

- **Scoping is a root class (`svg.wb-board`), not a `wb:` attribute selector.** Namespaced-attribute selectors behave differently between XML documents and inlined-HTML contexts; a class matches identically in both. The serializer merges `wb-board` in front of any foreign root class and parse strips the token back out, so a single `class` attribute round-trips stably.
- **Slot classes are derived from the colour at serialize time, never stored.** Parse ignores them entirely, which keeps the fixed-point invariant free and means old files gain theming on their first genuine edit (the accepted normalize-on-first-edit contract).
- **The stroke rule is `.wb-cN:not(text)`; text is themed via `text.wb-cN { fill }`.** A bare stroke rule would outline every glyph at the default 1 px stroke-width. Shape fills stay literal (v1 shapes are `fill="none"`); only outlines and text ink are themed.
- **The background rect is themable only while it is the canonical `#ffffff`** — a custom board colour is an opt-out exactly like a custom ink hex.
- **The adapter reads resolved `--wb-*` values off `<html>` via `getComputedStyle`** (base.css declares defaults; theme JSONs override via their `whiteboard` section) and copies them as inline style onto the board *and* the drag-preview overlay, re-applying on a `MutationObserver` over `data-theme`/`data-color-scheme`. No ui-layer import, so I9 holds.
- **The ribbon swatches and nib dot render through `var(--wb-cN, hex)`**, so the picker shows the ink the current theme will actually draw; the stored colour stays the canonical light hex (the slot's identity).

First UAT round added two revisions, both shipped in the same branch:

- **Boards are INFINITE by default.** `background: null` (the new `createScene` default) means no page rect; the surface colour comes from a `svg.wb-board{background:var(--wb-bg,…)}` rule in the palette block, and the serializer refits the root viewBox to the content (+48 margin, integer-rounded, idempotent — `core/whiteboard/bounds.ts`) on every save, unioning in the stored viewBox whenever unmeasurable raw/foreign content exists. This SUPERSEDES the phase-2 "viewBox is NOT recomputed on save" decision for infinite boards only — the objection (the page resizing under the user) assumed a visible page edge; a page board's viewBox still never moves. The adapter compensates the pan when the viewBox origin shifts mid-session so ink stays pinned on screen, paints the stage in `--wb-bg` with `overflow: visible`, and grew a **Page toggle** in the zoom cluster (`setBackground` in layers.ts): adding a page pins the current content-fitted viewBox as a fixed white page. Old phase-2 files carry a rect + metadata background, so they stay page boards untouched.
- **Two palettes: themed and static.** The ribbon gained an Auto/Fixed toggle (`paletteKind` in the whiteboard store) switching the swatch row between the 8 themable slots and `STATIC_PALETTE` — eight standard *named* SVG colours (`black`, `red`, … `purple`). Named colours can never equal a `PALETTE` hex, so the derived-class rule ignores them and a static stroke is literal by construction — zero format machinery. Switching carries the selection across by slot index.

Second UAT round (the palette didn't follow the theme; the infinite surface stayed dark grey everywhere):

- **In-app `--wb-*` defaults are now DERIVED from the theme palette vars** in base.css — `--wb-bg: var(--editor-bg)`, `--wb-c0: var(--fg)`, `--wb-c1: var(--danger)`, `--wb-c4: var(--accent)`, the rest `color-mix()` blends of those — instead of hardcoded per-mode hexes. Every theme (built-in or user JSON, both modes) now gets a matching board surface and ink palette automatically; a theme's `whiteboard` section remains the way to pin exact inks, and the dark-grey `#1e1e1e` surface (which had been base.css's fixed dark `--wb-bg` regardless of scheme) is gone. The FILE is untouched: its embedded palette block still falls back to the fixed `PALETTE`/`PALETTE_DARK` hexes for foreign renderers, so nothing about serialization changed. Themed swatch tooltips became role names (`THEMED_SLOT_NAMES`) since hue names would now lie.

Third UAT round:

- **Slot order became role-grouped**: Ink, Accent, Deep accent, Soft accent, Pencil, Alert, Warm, Deep warm — the accent family right after the pen. `PALETTE`/`PALETTE_DARK`/`STATIC_PALETTE` were permuted identically so slot N keeps one hue story across fallback hexes and the static row; old files self-heal (classes are derived from the hex, so a stroke's slot re-derives on its next save).
- **"Draws, then vanishes on release" returned with a NEW cause**: the live overlay carries `class="wb-board"` (so preview ink themes like committed ink), which meant the file's own `svg.wb-board{background:var(--wb-bg,…)}` surface rule ALSO painted the overlay — an opaque sheet sitting on top of the board, hiding every committed stroke the moment the preview cleared. (It was also the real culprit behind round 2's "surface is dark grey everywhere".) Fixed in whiteboard.css: `.wb-canvas > .wb-live{background:none}` out-specifies the embedded rule. Lesson recorded: any rule the serializer writes against `svg.wb-board` applies to EVERY element carrying that class once the file is adopted into the app DOM — the overlay included.
- **The outline toggle hides (visibility, not display) in draw mode** — a board has no headings, and keeping the reserved space pins the fullscreen button in place.

**Phase 3 — Selection, text, touch polish. ✅ BUILT** (branch `feat/whiteboard-work`; desktop QA pending, tablet QA pending). Select/move/resize with baked transforms, text tool, full pointer routing (pinch, palm rejection, finger toggle, pen eraser), phone toolbar sizing, viewport persistence.
*Verify:* classifier truth-table tests; `pnpm run android:deploy` on tablet — palm-resting pen draw, finger pan, pinch; desktop regression.

Automated verification is green: `pnpm run check`, 981 tests (60 new: `select.test.ts`, `input.test.ts`, text-tool and store additions), `pnpm run build` (whiteboard still its own lazy chunk, 21.6 → 30.3 KB), `cargo check`.

New pure modules, both colocated-tested: `select.ts` (the selected set, 8 resize handles, and `transformElement` — the baking) and `input.ts` (pointer routing + palm rejection). `geometry.ts` gained `transformPathData`, `rectContainsRect` and `unionRect`; `tools.ts` gained `makeText`; `tool-settings.ts` gained `TEXT_SIZES`/`fontSizeForWidth` and the handle constants.

Decisions taken during Phase 3 that the spec above did not pin down:

- **The viewport is SESSION state, not file state.** The format spec has a `view` key in `wb:doc` and the phase line says "viewport persistence", but WRITING it would dirty the document on every pan — which breaks the write-back guard's "mount → look → close is byte-identical" contract outright. So the view is kept per-tab in `ui/stores/whiteboard.ts` (survives tab switches and Draw⇄Raw round trips, which is where losing your place actually hurts) and a `view` that a file ARRIVES with is honoured read-only as the opening view. Restart forgets it; that is the right trade.
- **Marquee selects by CONTAINMENT, not intersection.** A marquee that took everything it grazed would make picking one stroke out of a dense sketch impossible, and "drag a box around it" is the gesture people already have.
- **Stroke width and font size scale by the geometric mean √(sx·sy)** under a non-uniform resize — one number cannot follow two axes. A stretched selection therefore lands within a stroke width of its target box; the tests assert that as the contract instead of pretending it is exact.
- **A resize clamps at a minimum size rather than flipping.** Passing through zero means negative scales, mirrored text, and a drag you cannot undo by dragging back — a whole class of problem removed by one `Math.max`.
- **Select drags paint live and commit ONCE**, exactly like the phase-2 eraser drag: every frame re-derives from the document as it was when the drag started (never accumulating transforms), and pointer-up is what makes it one undo step and schedules the write-back.
- **The text editor is a `<textarea>` parented to the TRANSFORMED `.wb-canvas`**, not a floating overlay in stage space. The browser then pans and zooms it with the board for free, and the on-screen type size is the size that will be committed. Enter is a newline (it is a text box); Ctrl/Cmd+Enter or clicking away finishes; Escape discards. Double-clicking text with the select tool reopens it, and emptying it deletes it.
- **The selection is dropped on undo/redo and on any external change.** A ref is a layer id plus an index, which survives a move or a resize (those replace in place) but not an add or a delete. Re-pointing it at "whatever is at that index now" would be worse than dropping it.
- **Two fingers always pan/pinch, even mid-stroke.** With finger-draw on, the second contact converts the gesture: the half-drawn stroke is discarded and the first finger joins the navigation set at the position it is actually at. Without that, "draw with finger" would cost you the pinch gesture.
- **`penSeen` is sticky across detach.** The device still has a pen after a mode switch; re-arming finger-draw would smear the next board.
- **Phones keep ONE toolbar — the ribbon — rather than gaining a bottom bar.** The plan floated a bottom bar for phones; the ribbon already scrolls horizontally on ≤640px (from the mobile pass), and splitting the draw tools across two toolbars would undo the phase-1 decision that made the ribbon the toolbar in the first place. What phase 3 actually changed is sizing: draw-mode targets go to the 44px touch minimum and the colour chips grow to match, with the tools ordered first so the common ones need no swipe. **Flagged for UAT** — if driving it on a phone proves the scroll is the problem, a bottom bar is still a contained change.
First UAT round found one defect and one gap, both fixed in the same branch:

- **Delete did nothing on a selected element.** The stage never became the keyboard target: every gesture calls `preventDefault()` on `pointerdown`, which suppresses the compatibility `mousedown` — and focus-on-click rides on `mousedown`. So the stage's own `keydown` listener never fired and Delete, Ctrl+Z and the arrow-key nudge were all silently dead after a click. Fixed by focusing the stage explicitly (`stage.focus({preventScroll:true})`) on every accepted press. Worth remembering as a class: **cancelling `pointerdown` costs you focus**, and a focus-dependent keyboard path will fail without a single error anywhere.
- **Text gained real font and size controls.** `TextElement` grew `fontFamily: string | null` (additive to schema 1 — omitted entirely when null, so files written before this round-trip byte-for-byte), and the ribbon shows a font menu + size menu in place of the nib row whenever the text tool is active or a selection could contain text. Four choices — Sans / Serif / Mono / Marker — each a *stack* ending in a generic family, because the `.svg` has to render on a machine that may not have the named face. Type size is now explicit (12–96) instead of being derived from the nib slot, which was cute and useless. The controls act on what you are looking at: they restyle the box being typed in (live, without stealing focus) and any selected text elements, as one undo step.

- **`refreshTool()` on the adapter** is the one thing the ribbon has to tell the adapter about. Tool settings are PULLED at each gesture, but the cursor and whether the selection shows handles are visible BETWEEN gestures, so the tool buttons poke the adapter after setting the store.

Second UAT round — Delete confirmed fixed; four more revisions, all in the same branch:

- **A drag-out text box was built, then reverted — text stays a point.** The MS Paint gesture was implemented in full (drag the rect, wrap inside it, bake the breaks into `<tspan>`s at commit via a pure `text-wrap.ts` fed a canvas `measureText`, remember the width as `wb:box-width`). UAT's verdict was that it "doesn't really do anything and doesn't fit cleanly into an SVG", which is right: SVG 1.1 `<text>` is an anchor point plus tspans — no width, no wrapping, no reflow, and SVG 2's proposal is implemented by nothing that ships. Faking it means the box width is editor-only state, the frozen breaks stop matching the moment a font resolves differently in another renderer, and a resize or a restyle silently invalidates line breaks the user never chose. **The rule that replaces it: `lines` comes from typed newlines and nothing else**, and the textarea grows sideways instead of wrapping, so what is on screen is the run of glyphs the file will hold. Recorded in `core/whiteboard/README.md` so it doesn't get re-litigated; a test asserts a 1000-character run stays one line.
- **The nib row really hides for the text tool now.** It was already conditional — with `hidden`, which `.ribbon-swatches { display: flex }` silently beats, so both rows showed. Now it is simply not rendered. (The UA sheet's `[hidden]{display:none}` loses to any class rule with a `display`; `hidden` is only safe on elements nothing styles.)
- **Ink got thinner and the default board smaller.** `STROKE_WIDTHS` 1.5/3/6/12 → **1/2/4/8** (default 3 → 2) and `DEFAULT_BOARD_*` 1600×1000 → **1200×750**. Two different fixes to one complaint: the widths set the nib-to-type ratio, and the board size sets the apparent size of everything, because a board is fitted to the pane on open — a bigger board in units is a silent zoom-out that renders 24-unit type as fine print. A unit is now roughly a board pixel. A test pins the ratio so a future nib change cannot quietly undo it.
- **The finger toggle hides without a touchscreen** (`navigator.maxTouchPoints > 0`), and says what it means. On a mouse-only machine it governed nothing — pointer routing sends mouse and pen to the tool regardless — so it read as a button that did nothing (QA dragged with it on and got text boxes, correctly). Where it does apply, the glyph now shows the current *answer* (✍ draws / ✋ pans) rather than the action, and the tooltip states the scope outright: "Touch: one finger draws, two fingers pan and zoom… A mouse or pen is unaffected."

Automated verification after this round: `pnpm run check` green, **984 tests** across 66 files, `pnpm run build` green with the whiteboard still its own lazy chunk, `cargo check` green.

**Phase 4 — Acquire & rectify (S0–S1). ✅ BUILT** (branch `feat/whiteboard-work`; desktop QA pending, tablet QA pending). Android camera chain (with Kotlin-side EXIF + downscale) + desktop picker/paste/drop; board detection, draggable-corner crop screen, aspect recovery, homography warp; insert as a rectified `<image>` photo layer. Ships as "scan to image" on its own.
*Verify:* cargo fmt/clippy/test; `cargo check --target aarch64-linux-android`; homography + quad unit tests; on-device capture → crop → save → renders in browser; permission-denied shows a notice; IPC payload stays under ~2 MB.

Automated verification is green: `pnpm run check`, **1016 tests** across 68 files (32 new: `quad.test.ts`, `homography.test.ts`, `pipeline.test.ts`), `pnpm run build` (whiteboard still its own lazy chunk, 30.3 → 48.8 KB), `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test` (49), and `cargo check --target aarch64-linux-android`.

New pure modules, all colocated-tested, in `src/core/whiteboard/scan/`: `types.ts` (a dependency-free leaf), `image-ops.ts` (downscale/resample, luminance, Otsu, 8-connected labelling, bilinear sampling, `rotate90`), `quad.ts` (`convexHull`, `decimatePolygon`, `maxAreaQuad`, `orderQuad`, `detectBoardQuad`), `homography.ts` (DLT solve, `quadAspectRatio`, `warpRows`), `pipeline.ts` (`planRectify`, `createRectifier`). `layers.ts` gained `addLayerWith` and an exported, prefix-taking `nextLayerName`.

Decisions taken during Phase 4 that the spec above did not pin down:

- **Detection uses the blob, not the edges — and admits when it failed.** Otsu → largest bright 8-connected component → convex hull → decimate to ≤12 vertices → maximum-area quadrilateral over the 495 four-subsets. A blob is indifferent to the occluded, low-contrast and off-frame edges real boards actually have, and it is a fraction of the code Hough lines would be. The hull comes from each row's leftmost and rightmost member — the convex hull of a point set IS the hull of its row extremes — so it costs O(height) points rather than O(area). When the bright region fills the frame, covers <15% or >98% of it, or the recovered quad recaptures less than half its own hull, the result is `source: 'frame'` and the crop screen says "no board edges stood out" instead of drawing a confident wrong outline.
- **Vertex decimation is Visvalingam, not an RDP epsilon sweep.** RDP takes a tolerance; the quad search wants a vertex BUDGET. Dropping the vertex with the smallest triangle contribution, repeatedly, lands on exactly 12 in one pass instead of a search over tolerances that a differently-scaled photo would need re-tuned.
- **`orderQuad` is the single place that decides which corner is "top-left"**, so every other module can index a `Quad` as TL, TR, BR, BL without re-deriving it. It runs at the END of a corner drag, never during — reordering mid-drag would swap the corner out from under the finger holding it.
- **The rectifier is a resumable job, not a function.** `createRectifier` returns something the caller pumps a band at a time from `requestAnimationFrame`, which is what makes the progress bar real and the Cancel button work. A test asserts the banded run is byte-for-byte what a one-shot warp produces — banding that changes the output is a bug, not a trade-off.
- **The output long edge is clamped to the source's own resolution.** A quad that only spans 900 px of photo is not rectified to 1800: the extra pixels are invented, cost 4× the memory, and slow every phase-5/6 stage that follows for nothing.
- **Kotlin does the EXIF rotation and the downscale, not JS.** A 12 MP capture is ~8 MB of base64 crossing IPC and then sitting in a JS string; the pipeline uses none of that resolution. `capturePhoto` decodes with `inSampleSize` (so the full bitmap never has to fit in memory), scales to ≤2600 px, bakes the EXIF orientation into the pixels and re-encodes at q0.9. Everything above the bridge can then assume upright pixels instead of each layer rediscovering that phones shoot sideways.
- **CAMERA is declared, so it must also be requested.** Android's rule is that `ACTION_IMAGE_CAPTURE` needs no permission — *unless* the app declares `CAMERA`, in which case it must be granted. The plugin declares it (per the plan) and therefore requests it at runtime through a `camera` alias, mirroring the `microphone` one. `<uses-feature … required="false">` keeps a camera-less device installable; `capturePhoto` rejects `NO_CAMERA` there.
- **Acquisition is INJECTED into the adapter, not imported by it.** The camera is an Android-only IPC bridge and the picker is a native dialog; neither belongs in an editor module (`editors → core, ipc`). `WhiteboardAdapterOptions.scan` takes two functions and a notice channel, EditorHost supplies them, and the desktop picker routes through a facade dispatch like every other native dialog.
- **A scan lands on its own layer, in the current view, as one undo step.** `addLayerWith` builds the layer and its contents in one document, so an unwanted scan is one Ctrl+Z (or one "delete this layer"). It is fitted to 84% of the VISIBLE scene rect rather than the board origin — a photo that arrives off-screen reads as nothing having happened. Because `<image>` was already parsed, serialized, bounded, hit-tested and transformable from phase 1–3, an inserted scan is selectable, movable, resizable and erasable with no new format work.
- **Desktop drop reuses the explorer's hit-testing trick.** Tauri intercepts OS file drags before the webview sees them, so HTML5 `drop` never fires; the board advertises `data-drop-scan` (exactly like the explorer's `data-drop-dir`), main.tsx hit-tests the physical cursor position, and delivery is a `wb-drop-photo` CustomEvent so main.tsx needs no handle on the lazily-loaded adapter. Clipboard paste is a plain `paste` listener on the stage.
- **"Import › Whiteboard scan…" creates the board first.** A scan has to land somewhere, and "a new whiteboard in this folder" needs no follow-up question. It then waits for the lazy draw adapter to register (polling with a deadline — the adapter does not exist at the moment the file is written) and falls back to a notice pointing at the ribbon's camera button rather than failing silently.

**Phase 5 — Clean & extract ink (S2–S4). ✅ BUILT** (branch `feat/whiteboard-work`; desktop QA pending, tablet QA pending). Flat-field normalization, glare detection, Sauvola + hysteresis, stroke-width-relative component filters, colour voting. Output still rasterized — insert the **cleaned** image. This is deliberate: it makes the noise and lighting story independently shippable and tunable against real photos *before* any vectorizer exists to blame.
*Verify:* synthetic illumination/ghost goldens; real-photo fixture stats; side-by-side before/after on the tablet across ≥6 lighting conditions; eraser-ghost fixture yields zero surviving components.

Automated verification is green: `pnpm run check`, **1065 tests** across 73 files (49 new: `illumination`, `distance`, `binarize`, `color`, `clean` suites), `pnpm run build` (whiteboard still its own lazy chunk, 48.8 → 61.2 KB), `cargo check`. The eraser-ghost golden asserts zero surviving components; the i-dot golden asserts revival.

New pure modules in `src/core/whiteboard/scan/`, all colocated-tested: `illumination.ts` (van Herk/Gil-Werman dilation field estimate, per-channel division, integral-image glare detection), `distance.ts` (exact Felzenszwalb–Huttenlocher EDT + stroke-width estimate), `binarize.ts` (Sauvola integral-image thresholds modulating the luminance gates; chroma gates free-standing), `components.ts` (hysteresis, component stats/filters, i-dot rule), `color.ts` (core-pixel chroma-weighted hue voting, 8 bins, palette snap), `clean.ts` (`createCleaner` resumable job + `composeCleaned`). The scan panel pumps the clean job after rectify, shows the cleaned board first in review with a photo toggle, and offers **Insert cleaned** (primary, PNG) / **Insert photo** (fallback, JPEG).

Decisions taken during Phase 5 that the spec above did not pin down:

- **Colour mapping to the theme palette is the DEFAULT; true colour voting is the secondary option** (user requirement). The review screen has an ink-colour select: *Theme colours* paints each component its `SCAN_PALETTE` hex — by construction a member of the drawing `PALETTE` (a test pins the invariant), so scanned ink matches drawn ink and inherits theming for free when phase 6 vectorizes it. *True colours* paints the component's measured median-core colour — still one colour per component (the colour VOTING output, not raw pixels). Switching is a cheap `composeCleaned` re-paint off the cached extraction; the pipeline never re-runs.
- **The Sauvola modulation applies to the LUMINANCE gates only; the chroma gates stand alone.** A yellow stroke's luminance sits above any sane local threshold — chroma is the only signal that finds it — while a white-balanced blank board has chroma ≈ 0, so chroma cannot speckle. Two Sauvola k's (0.2 strong, 0.08 weak) come from the same integral images.
- **The strong/weak decision is glare-masked at the gate**, not just filtered later: a blown highlight must not manufacture ink at all. Component-level glare rejection (≥60%) remains as the belt to those braces.
- **The cleaned output is flat colour on pure white, encoded as PNG** (the photo fallback stays JPEG q0.7). Flat colour on white compresses far better as PNG, and JPEG ringing around ink would poison phase 6's tracer. No anti-aliasing is painted; the browser's downscaling supplies it visually.
- **The clean job's steps are pipeline STAGES, not row bands** — each stage is one bounded typed-array pass (tens of ms at Balanced), which is honest progress-bar granularity without threading a cancellation token through five algorithms. Cancel lands between stages and just drops the job.
- **The EDT ignores the frame border** (border does not count as background), so ink cropped by the crop rectangle keeps its real half-width instead of thinning toward the edge.
- **The stroke-width estimate is 2 × the median of the EDT's local maxima** (plateaus count — a flat ridge is a centerline too), clamped to [1.5, 40] px so a pathological mask cannot zero out every downstream threshold.
- **Real-photo fixtures did not land in this phase** — there is no camera in the loop to take them with. The synthetic goldens cover ramp/vignette/cast/noise/ghost/grit/i-dot/glare; committing a handful of real ≤800 px fixtures (per the testing spec) is deliberately deferred to tablet QA, when real photos of a real board exist.

First UAT round (desktop, with a real board photo) found three defects, all fixed in the same branch:

- **"Import › Whiteboard scan…" opened the board in Raw mode** whenever the user's `lastFileMode` was `'raw'` — `openFileTab` inherited the markdown mode preference, and `'raw'` is legal for svg too, so `defaultModeFor` kept it. With no draw adapter, the scan poll timed out into the fallback notice. Fix in `tabs.ts`: **an `.svg` always opens in Draw**; Raw is an explicit per-tab switch (session restore still honours a recorded raw mode). Regression test added.
- **A circle drawn with a drying marker lost everything but its darkest arc** (diagnosed by running the pipeline offline on the actual photo). Two mechanisms, both fixed in `components.ts`: (a) the **faint filter** (`strongRatio < 0.15`) killed big faint-but-real components — it now spares **stroke-shaped** ones (`dtMax ≤ w` and `thinness ≥ 20`), which an eraser smear or hand shadow never is; (b) hysteresis killed weak-only fragments of fading strokes outright — a new **continuity rescue** revives a weak-only component when it is stroke-shaped AND within the i-dot reach (2·w) of kept ink, run to fixpoint (BFS) so a long faded tail recovers piece by piece. The stroke-width estimate still comes from strong-anchored ink only, so smears get no vote in `w`. On the real photo this took the result from a broken arc to the complete drawing with zero speckle; the eraser-ghost golden still passes (an isolated ghost is neither near ink nor stroke-shaped). **No sensitivity slider** — the user asked for automatic, and shape+continuity is the automatic answer; phase 6's review sliders remain available if real-world photos still need a knob.
- **The themed cleaned scan painted a white card even on dark boards.** `composeCleaned` gained `ComposeOptions` (`background: 'white' | 'transparent'`, `inkFor` override), and the scan panel now composes themed output on a **transparent sheet with ink in the RESOLVED app-theme palette** — probed through a real element's `color` (custom properties hold unresolved `color-mix()` text; only property resolution flattens them to rgb). The review preview paints `var(--wb-bg)` behind the canvas so what you see is the board it will land on. True colours keeps measured ink on white — that mode is a document, and its colours were measured against white. Known trade-off, accepted until phase 6: the PNG's ink is baked at insert time, so a later theme switch does not re-tint it (vectorized strokes will theme live).

Second UAT round (two saved boards from the same photo, both showing small black dots beside the handwriting — e.g. under the "1" of "Box 1"). Diagnosed by decoding the inserted PNG and running the real `extractInk`/`assignColors` over the actual board geometry, which put numbers on it: **105 of the 123 surviving components were speckle-sized, and the speckle filter had rejected exactly zero of them.** Two independent causes, both fixed:

- **The i-dot rule was a pass-through, not a filter** — it spared any speckle with kept ink within 2·w, and near handwriting there is kept ink within 2·w of *everything*. Two attempts to make it discriminate are recorded in the fourth round below; **both were reverted.**
- **Coreless components voted black, which is the worst possible answer.** Colour voting uses core pixels (`distance ≥ 0.6·dtMax`); a one- or two-pixel-thick component has no core, so its "core" is anti-aliased edge, which is desaturated by construction → `chroma < 0.12` → `black`. Every one of those 105 specks was therefore painted the theme's *foreground* colour amid green ink: maximally visible. Fix in `color.ts`: below `0.4·w` half-width a component has no trustworthy colour of its own and **inherits** the nearest cored component's within `3·w` (donors must be cored, so fragments cannot chain; nothing in reach means it keeps its own vote). This also fixes the arrow, whose faint shaft fragments were black dashes under a green head.

Third and fourth UAT rounds — **two attempts to make the speckle filter discriminate, both reverted. This is the useful result of the phase, and it belongs in the plan so nobody tries a third.**

- *Attempt 1 — a shape gate.* A spared speckle had to look like the marker made it: a **dab** (`dtMax ≥ 0.3·w`; a pen cannot draw thinner than its own tip) or a **fragment of a line** (spanning ≥ `w` on one axis). Measured on the real board this looked excellent — 123 → 32 components, 91 speckles removed, every reported dot gone. UAT's verdict was that it had overshot: the arrow read faint and the circle lost chunks. The mechanism: a light stroke does not fade into neat span-`w` pieces, it fades into pieces *shorter* than `w`, and those failed both tests.
- *Attempt 2 — exempt rescued components.* The continuity rescue already establishes weak-only + page-ink thickness + continuity with kept ink, which is strictly stronger evidence than either shape test and indifferent to size. The prediction was that the two populations separate on darkness — residue carries strong pixels, so hysteresis admits it directly and the rescue never sees it. **Wrong**: the board's residue marks are themselves faint, so they were rescued too. The specks came back *and* the circle stayed gappy — UAT called it worse than the starting point, correctly.

The conclusion both rounds converge on: **every property that separates residue from faint ink at the raster level — size, elongation, darkness, core thickness — also separates a fading stroke from its own solid part.** There is no raster-level discriminator, so there is no knob to tune, and the filter is now deliberately generous. Losing ink is the worse error by a wide margin: a surviving speck is one eraser tap away, whereas a stroke the pipeline never emitted cannot be recovered at all. **Despeckling moves to phase 6** (the user's own call — "we can probably deal with that in vectorization"), where after tracing a speck is a path with no length and no continuation, which is finally a decidable question.

What survives from the three rounds: the **colour inheritance** fix, which is orthogonal and strictly good — it is why the tolerated specks now read as the ink's own colour instead of jumping out in the theme's foreground; and the golden's new cases, which are now the guard rails in both directions (a fading tail of sub-`w` dashes that must ALL survive, and a near-ink speck asserted to survive *as an accepted cost*, so a future tightening has to argue with the test rather than slip past it).

Fifth UAT round — the source photograph finally arrived, and running the real pipeline on it **refuted the premise of the whole investigation**. Through the desktop path (full 4080×3072 — `decodeImage` never downscales; only Android's Kotlin side does) at Detail the rectified output is 2400×644, matching the app's 2400×653, and the extraction report is `{ghost: 4, speckle: 0, faint: 0, blob: 0, border: 0, glare: 0}`. **Zero rejections of any kind.** Dumping every stage as an image confirmed it: the weak mask, the kept mask and the app's own saved PNG all contain the circle complete and unbroken (77,497 vs 72,958 ink pixels between the offline run and the shipped file, the 6% being the different crop). Nothing was ever being cut out.

What "cutting out too much" actually was: the raster is **1-bit**, the ink is thin and mid-toned, and the board fits the image to the pane, so a 2400 px raster is always scaled down. Measured at display size the median ink pixel was only 160/255 — 37% dark — while the thick box strokes stayed solid. Two consequences worth recording, one counterintuitive: **a higher preset can look worse**, since the board fits to the pane whatever the preset, so Detail only makes each stroke finer relative to its raster and more of it averages away; and the themed palette costs fidelity here, since the pipeline classifies the marker correctly (`purple: 90, black: 21`) but the slot resolved to a grey-green in the active theme.

Fix (the user's pick from three options): **paint ink by coverage instead of as a 1-bit stamp** — new pure `coverage.ts`, stored on `CleanResult`, consumed by `composeCleaned` as alpha on a transparent sheet and as a blend toward white on an opaque one. The information was already measured and then discarded: extraction decides *whether* a pixel is ink, and the normalized image still knows *how much*. Three details make it correct rather than merely soft: coverage is `255 − min(R,G,B)` (distance from board white, not darkness — a yellow marker found by the chroma gate would otherwise render nearly transparent); each component is normalized against its OWN core, scaled by 0.9 so the plateau saturates and only the rim tapers (coverage answers *where the stroke is*, not how hard it was pressed — the flat per-component colour already carries the marker's identity); and the taper extends one pixel PAST the mask, or it would still land on a hard step at the threshold boundary. Presentation only — mask, components and colours are untouched, so phase 6 traces exactly what it would have.

Still open, unchanged: `w` is one number for the whole page, so mixed nib widths are a phase-6 concern; and the cleaned PNG bakes the ink colours resolved at insert time, so a board scanned in dark theme keeps dark-theme ink when viewed in light theme (`whiteboard-2.svg` shows this). Phase 6's vector strokes theme live and retire it. **Resolved in round five below: no ink was ever being lost.**

Automated verification after these rounds: `pnpm run check` green, **1079 tests** across 74 files, `pnpm run build` green, `cargo check` green.

**Phase 6 — Vectorize (S5) + review flow (S7).** EDT, thinning, skeleton graph, spur pruning, junction continuation, width sampling, RDP + Bézier via `smoothing.ts`, contour fallback, size guard, review dialog with live sliders and colour remap. Inserts editable strokes into an unlocked "Scan 1" layer.
*Verify:* skeleton-graph goldens; traced strokes are erasable/selectable/movable like drawn ones; real-whiteboard photo on tablet ≤~2 s at Balanced; saved file opens identically in a browser; full regression.

**Phase 7 — OCR (S6).** `text-layout.ts` grouping, `TextRecognizer` port, Android ML Kit chain (Digital Ink primary, Text Recognition fallback), `<desc>` + hidden `<text>` + metadata JSON, "Copy recognized text", desktop no-op path.
*Verify:* pure grouping/placement tests; on-device recognition on neat and messy handwriting with confidence reported; hidden text is copyable in a browser and absent from hit-testing; round-trip preserves the OCR group byte-stably; desktop reports `unavailable` without erroring.

## Risks / notes surfaced

1. Constant-width ink in v1; if variable-width feel is demanded, take the tiny perfect-freehand dep later as a separate brush tool (no format change). Traced strokes already carry per-vertex widths in `wb:widths`, so no re-scan would be needed.
2. Foreign-SVG verbatim re-emission is the trickiest correctness surface — real-world fixtures (Inkscape, Excalidraw export) guard it.
3. Embedded photos make multi-MB DocModel strings flow through the session flusher — watch flush timing in Phase 4 QA. The Phase 6 size guard (≤~4000 strokes / 1.5 MB) is the vector-side equivalent.
4. Android WebView pen fidelity (pressure, eraser button, coalesced events) varies by device — Phase 3 on-device QA is the gate; degradation is graceful.
5. Live-DOM SVG comfortable to a few thousand nodes; culling is a later optimization if long sessions exceed it. A dense scan is the most likely first trigger.
6. **Glare is unrecoverable**, not merely hard — blown highlights carry no signal. The pipeline detects and reports it rather than pretending; the fix is a user-facing hint plus the insert-as-photo fallback.
7. **ML Kit Digital Ink expects written stroke order**, and traced strokes have arbitrary order/direction. Line-level submission in reading order is the mitigation; if on-device accuracy disappoints in Phase 7, the Text Recognition v2 raster path is the ready fallback behind the same port. OCR is additive metadata — no OCR ever blocks or degrades the drawing.
8. **Thinning cost is the main perf unknown** on low-end Android. Mitigations, in order of preference: per-component bboxes, active-border queue, then drop to the Fast (1200 px) preset, then the same-origin worker.
9. Colour is a *classifier*, so it will occasionally be wrong (a dying blue marker reads grey). The review dialog's remap/merge controls are the intended fix — cheaper and more honest than chasing perfect accuracy.
