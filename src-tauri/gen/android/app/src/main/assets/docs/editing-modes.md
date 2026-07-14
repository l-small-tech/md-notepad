# The four viewing modes

Every tab can be viewed four ways. Switch with the buttons at the
bottom-left of the window, or with **Ctrl+1** to **Ctrl+4** (Cmd on Mac).
Each tab remembers its own mode.

## Raw (Ctrl+1)

Just your text, with the markdown symbols visible and gently colored. This
is the fastest, most precise mode — what you see is exactly what's in the
file. Press **Ctrl+F** here to search within the note.

## Split (Ctrl+2)

Raw text on the left, the finished result on the right, updating live as
you type. Great while you're learning markdown, or for documents with
tables and diagrams. Drag the divider between the panels to resize them.

## Rich (Ctrl+3)

A word-processor-style view: no markdown symbols, formatting appears as you
apply it, and a small toolbar pops up when you select text. Behind the
scenes it's still the same markdown file.

Two honest caveats about Rich mode:

- **Your first edit may tidy the markdown's spelling.** Markdown allows
  several ways to write the same thing (`*` or `-` for bullets, for
  example). Rich mode rewrites the text using its preferred style the first
  time you edit — the *content* never changes, only the symbols. The app
  shows a one-time reminder when this could happen. If the exact symbols
  matter to you, edit in Raw or Split mode.
- **Diagrams show as code.** Mermaid diagrams (see
  [Writing markdown](writing-markdown.md)) only render in Split and Read
  modes.

Also note: undo history doesn't carry across a switch between Rich and the
other modes.

## Read (Ctrl+4)

The polished result, full-width, with nothing editable — ideal for actually
*reading* a finished note. In Read mode the toolbar swaps to reading tools:

- **A− / A+** — text size (also Ctrl+`-` / Ctrl+`=` anywhere, Ctrl+0 to
  reset).
- **⛶ Full screen** (or **F11**; Ctrl+Cmd+F on Mac) — press once to hide
  all the app chrome, press again to fill the whole screen. **Esc** steps
  back out.

How wide the text column is in Read mode is up to you — see **Read mode
margins** in [Settings](settings.md).

## Choosing a default

New tabs open in Raw mode out of the box. Pick a different default —
including Read, handy if you mostly open notes to look things up — under
**Default mode** in [Settings](settings.md).
