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
- Snap to a canonical palette (`#1a1a1a`, `#d02f2f`, `#e07b00`, `#c9a400`, `#1f9d55`, `#0f8f8f`, `#1f6fd0`, `#8a3fd1`) so output is clean, consistent and themeable; "preserve measured colour" is an option in the review dialog. Both the snapped and the measured colour go in the metadata.
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

**Phase 3 — Selection, text, touch polish.** Select/move/resize with baked transforms, text tool, full pointer routing (pinch, palm rejection, finger toggle, pen eraser), phone toolbar layout, viewport persistence.
*Verify:* classifier truth-table tests; `pnpm run android:deploy` on tablet — palm-resting pen draw, finger pan, pinch; desktop regression.

**Phase 4 — Acquire & rectify (S0–S1).** Android camera chain (with Kotlin-side EXIF + downscale) + desktop picker/paste/drop; board detection, draggable-corner crop screen, aspect recovery, homography warp; insert as a rectified `<image>` photo layer. Ships as "scan to image" on its own.
*Verify:* cargo fmt/clippy/test; `cargo check --target aarch64-linux-android`; homography + quad unit tests; on-device capture → crop → save → renders in browser; permission-denied shows a notice; IPC payload stays under ~2 MB.

**Phase 5 — Clean & extract ink (S2–S4).** Flat-field normalization, glare detection, Sauvola + hysteresis, stroke-width-relative component filters, colour voting. Output still rasterized — insert the **cleaned** image. This is deliberate: it makes the noise and lighting story independently shippable and tunable against real photos *before* any vectorizer exists to blame.
*Verify:* synthetic illumination/ghost goldens; real-photo fixture stats; side-by-side before/after on the tablet across ≥6 lighting conditions; eraser-ghost fixture yields zero surviving components.

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
