# The viewing modes

Every markdown tab can be viewed four ways; code files get Raw and Review. Switch with the buttons at the
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

Full screen works in every mode, including drawings. Once the chrome is
hidden, there are two ways back:

- **Mouse and keyboard** — move the pointer to the top of the window for the
  floating controls, or press **Esc** / **F11**.
- **Touch or pen** — press and hold anywhere for a moment. A small menu
  appears with **Exit full screen**, **Workspaces** and **Outline**. On a
  drawing, the hold that opens the menu doesn't leave a mark.

How wide the text column is in Read mode is up to you — see **Read mode
margins** in [Settings](settings.md).

## Review (Ctrl+4, code files)

A code file — `.ts`, `.tsx`, `.js` or `.rs` — offers two modes: **Raw**, the
plain source with syntax colouring, and **Review**, which takes Read's place.
Review is read-only. It shows the file's *structure* for someone who knows
what code is but not the syntax, so you can read what an agent did and tell
it what to change next, by voice.

Every piece of the file becomes a card, in source order:

- **A plain-English sentence** for each function — "Takes a folder path, a
  list of folders, and an optional list of folders, and gives back *show*
  (yes or no) and *explicit* (yes or no)." The real signature sits under it
  in code font, and the author's doc comment under that. The sentence is a
  reading aid built from simple rules, not a specification; when it looks
  off, trust the signature.
- **Forms** for structs, interfaces, enums and classes: a table of fields,
  each with its plain-English type and its comment.
- **An imports card** at the top: what this file uses from the app and
  which packages.
- **Facts** on each card: what it calls and what calls it, its size (the
  dots), and whether it is exported.
- **Code** opens the body folded to its bones — the declarations and the
  `if` / `for` / `match` / `return` lines — with `⋯ 9 lines` markers you tap
  to open one level at a time. Short functions open in full.
- **Flow** draws one function's branches and loops as a flowchart.

Above the deck, **Cards / Calls / Changes** switch views. *Calls* draws which
functions in this file use which; tap a node to jump to its card. Chips
under the header filter the deck (All · Exported · Changed · Functions ·
Types). Any diagram opens full screen with pinch-zoom when tapped.

**Changes** needs git on the machine. The header offers a baseline — *this
branch* (against the branch it was made from), *uncommitted*, or *last
commit* — and cards carry **added**, **changed** and **removed** badges;
a changed signature says what changed ("now also takes hiddenDirs"). When
the same file is also changed on another worktree's branch, the card says
so. Without git, the header just says so and every other view works. The
branch to compare against is auto-detected (`development`, `main`, or
`master`) and can be set under **Review baseline branch** in
[Settings](settings.md).

**Voice notes work on cards.** Turn on the toolbar's voice-notes button,
press and hold a card, and dictate. The note lands in
`<file>.<ext>.comments.md` beside the file, quoting the card's signature and
naming the declaration, with the branch and baseline recorded at the top.
Spoken names snap to the real identifiers ("shows all files" becomes
`showsAllFiles`); each snap can be undone before you move on. On the
desktop, the offline Whisper engine is primed with the file's own names, so
they transcribe correctly far more often.

## Choosing a default

New tabs open in Raw mode out of the box. Pick a different default —
including Read, handy if you mostly open notes to look things up — under
**Default mode** in [Settings](settings.md).
