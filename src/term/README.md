# src/term/ — the terminal engine

Bytes in, screen state out. This directory is a **self-contained library**:
no DOM, no Tauri, no React, no imports from sibling layers (invariant I9,
lint-enforced in `eslint.config.js`). It was written for `smooth-terminal`
and ported here verbatim; keep it portable.

Everything here is covered by Vitest and the suites are **normative** — they
define the VT behaviour the rest of the terminal feature relies on.

## What lives here

| File | Role |
| --- | --- |
| `parser.ts` | VT/xterm escape-sequence state machine (Paul Williams VT500 diagram) + streaming UTF-8 decoder. Holds no screen state. |
| `screen.ts` | The screen model: consumes parser actions, owns grid, cursor, modes, tab stops, alt screen, OSC state. |
| `row.ts` | One grid row, packed as three `Uint32` words per cell (content, fg, bg) with side maps for rare data. |
| `attributes.ts` | The bit layout of the fg/bg words: color mode (16 / 256 / truecolor) + SGR flags. |
| `scrollback.ts` | Fixed-capacity ring buffer — O(1) eviction, because `cat` of a big file scrolls ~100k lines through it. |
| `charwidth.ts` | wcwidth-style display width (0 / 1 / 2 columns) from checked-in Unicode 16 range tables. |
| `terminal.ts` | The public face: `new Terminal({cols, rows})`, `write(bytes)`, `resize()`, `onData()`. |
| `index.ts` | The barrel — import from `'../term'`, never from a file inside. |

## Contracts you must not break

1. **Purity.** No `document`, no `window`, no `@tauri-apps/*`, no React. The
   engine must stay runnable in `environment: 'node'` under Vitest.
2. **The parser never throws.** Any byte sequence, chunked at any boundary,
   must return the machine to a sane state (`__tests__/fuzz.test.ts`).
3. **12 bytes per cell.** Rare per-cell data (combining marks, underline
   color, hyperlink id) goes in a per-row side table behind an "extended"
   bit — never a fourth word.
4. **Width tables are generated, not hand-edited.** Regenerate with
   `node scripts/gen-width-tables.mjs` on a Unicode version bump and paste
   the output over the tables.

## Tests

`__tests__/` covers the parser, SGR, movement, modes, scroll regions, resize
(reflow), wide characters, OSC, alt screen, and a byte-level fuzz pass.
`theme-detect.test.ts` is the light/dark contract specifically — the OSC
10/11/12 query answers and the DEC 2031 / DSR 996 reports every harness uses to
decide whether to paint a light or a dark interface; it names which agent
relies on which, so a change here has a visible consequence attached. The
**replay** suite is the end-to-end proof: `fixtures/*.bin` are raw byte
streams captured from real programs (vim, less, htop, claude-code) with
`fixtures/*.txt` the screen `tmux` itself ended up with; the engine must
reproduce that screen. Record new ones with `scripts/record-fixture.sh`.
