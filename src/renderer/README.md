# src/renderer/ — the terminal surface

Screen model in, pixels out; DOM events in, pty bytes out. Like `term/`, this
is a portable library: it owns a canvas and a hidden textarea, but it imports
**no** React and **no** Tauri (invariant I9, lint-enforced). It may import
`term/` and `core/`. Ported verbatim from `smooth-terminal`.

The host (`src/ui/components/TerminalPane.tsx`) hands it an element, a
`Terminal`, a resolved `TerminalTheme` and a `FontSpec`. The renderer never
reads CSS variables or the DOM for configuration — everything is passed in.

## What lives here

| File | Role |
| --- | --- |
| `view.ts` | `TermView` — the mountable surface. Owns the canvas, frame loop, `ResizeObserver`, devicePixelRatio, focus, link hover; reports grid size so the host can resize the pty. |
| `renderer.ts` | The canvas painter: dirty rows → `clearRect` → background spans → text runs → decorations. |
| `runs.ts` | Row → draw runs. Batches consecutive cells into background spans and text runs so a line is a couple of canvas calls, not a hundred. |
| `colors.ts` | Cell attributes → painted colors. A *default* background resolves to `null` and that area is left unpainted, so the page background shows through. |
| `theme.ts` | `TerminalTheme`: 16 ANSI colors + background/foreground/cursor/selection, as numbers. Defaults mirrored as hex in `core/terminal-palette.ts`. |
| `metrics.ts` | Font measurement and cell geometry — measured from the real font once per font/size change, never guessed. |
| `selection.ts` | Selection model in absolute buffer lines (so it stays anchored while output scrolls), plus text extraction. |
| `links.ts` | OSC 8 hyperlinks and implicit URL detection under the pointer. |
| `keys.ts` | Pure keyboard encoding: a `KeyInput` description → the bytes xterm would send. Legacy/modifyOtherKeys encoding by default. |
| `mouse.ts` | Pointer events → mouse-tracking escape sequences. Byte-oriented (X10 puts coordinates above 0x7f). |
| `paste.ts` | Paste sanitizing + chunked writes. The one path where the terminal sends text the user did not type key by key. |
| `input.ts` | `TermInput` — the only DOM-event file. Owns the hidden textarea (the only way a web view runs IME composition) and glues events onto the pure modules above. |
| `index.ts` | The barrel — import from `'../renderer'`. |

## Contracts you must not break

1. **No React, no Tauri.** The host wires callbacks; the renderer knows
   nothing about stores, tabs or IPC.
2. **Configuration is passed, not read.** Theme, font and cursor style arrive
   as options and are re-applied idempotently, which is what makes live
   re-theming a prop change rather than a shell restart.
3. **Never let the surface collapse.** A 0×0 element resizes the pty to 1×1
   and every running TUI redraws into a corner — see invariant I10 in
   `src/ui/README.md`. That is why terminal tab pages are hidden with
   `visibility: hidden`, never `display: none`.
4. **Encoding stays pure.** `keys.ts`, `mouse.ts`, `paste.ts` and `runs.ts`
   take plain values, not events or canvases, so the whole matrix is
   unit-testable (and diffable against `showkey -a`).
