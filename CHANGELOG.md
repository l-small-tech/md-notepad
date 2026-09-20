# Changelog

Every tagged release gets a short, high-level entry here: the handful of
improvements a user would want to know about, not an inventory of commits.
The release workflow copies the tagged version's section into the GitHub
release notes and refuses to build a tag that has none.

Keep an `## [Unreleased]` section at the top while working; rename it to
`## [X.Y.Z] — YYYY-MM-DD` when bumping the version.

## [Unreleased]

- **Two views of one file, in sync as you type.** Right-click a file's tab →
  **Duplicate tab** (or **Duplicate in new window**) for a second view of the
  same file: Markdown in one, Present, Review or Draw in the other. Edits show
  up in the other view as you type — no more pressing Reload — and saving
  either one saves both. The Reload banner is still there for changes made
  outside the app.
- **Presenter view for slide decks.** Right-click a deck's tab → **Presenter
  view** (or press **P** during the show): a second window with the current
  slide, the next slide, your speaker notes, a clock and a timer. Put it on
  your laptop screen and press F11 on the slides — both windows stay on the
  same slide, and the arrow keys work in either.
- **The file drawer is sorted by name.** Folders come first, then files, both
  A→Z regardless of capitalisation and with numbers read as numbers, so
  `note2.md` sits above `note10.md`. Files used to be listed newest-first,
  which moved rows around every time you saved.
- **Full screen and distraction-free are now two separate switches.** F11
  makes the window fill the screen and leaves the interface exactly as it is,
  like every other desktop app. The old "full window" view that hides the
  tabs, toolbar and status bar is now called **Distraction-free** (the ⤢
  button and the app menu) and works with or without full screen. Esc leaves
  distraction-free first, then full screen. On Windows 11, full screen no
  longer leaves a black strip where the taskbar was.
- **Quieter scrollbars.** Scrollbars are now a slim, translucent bar tinted to
  your theme that appears while you scroll and fades away when you stop, in
  the style of Windows Terminal. Hover it to grab it.
- **Slide decks stand out in the file tree.** A Marp presentation now shows a
  purple *marp* badge in the Workspaces pane instead of the ordinary *md* one.
- **Ctrl+N opens a new window.** A fresh window with one empty note, instead
  of another tab in the current one. The tab bar's "+" and the command
  palette's "New tab" still add a tab here; Ctrl+Shift+N still picks a type.
- **Empty notes explain themselves.** A brand-new note shows ghost text — how
  notes save, what Ctrl+S does, and a one-glance markdown cheat sheet — that
  disappears at the first keystroke.

## [0.9.0] — 2026-09-16

- **Diagram editor.** Whiteboards are for drawing diagrams now, not just
  sketching on. Five new shapes — diamond, triangle, parallelogram, hexagon and
  cylinder — join rectangles, rounded rectangles, ellipses, lines and arrows in
  a shape menu that keeps the ribbon the same size and remembers the shape you
  last used. Shapes can be filled (including with the board's own colour, so a
  box hides what is behind it on a light or a dark board), dashed or dotted,
  and arrows can have a head at either end or both. Holding Shift while
  dragging keeps a shape square and a line at 45°. With something selected, the
  colour, width, fill, dash and arrow-head controls restyle it instead of only
  setting what comes next — and they show what the selection currently is.
  Diagrams can now be arranged, too: copy, cut, paste and duplicate (Ctrl+C /
  X / V / D — a copy pastes onto another board, or into other apps as SVG),
  bring forward and send back (Ctrl+] / [), align and distribute from the
  board's new right-click menu, and group things so they select and move
  together (Ctrl+G). Double-click a shape to give it a label that stays
  centred as the shape moves and resizes. There is a grid, too (G, or the ⊞
  button — each board remembers its own spacing and whether it snaps), and
  things line up with each other whether or not the grid is on: drag a box
  near another one's edge or centre and it lands on it, with a thin line
  showing what it lined up with. Hold Alt to ignore all of that for one drag;
  freehand ink never snaps. And lines and arrows are live connectors: start
  or end one on a shape and it sticks — to the middle of a side, or aimed at
  the centre — and follows the shape when it moves or resizes, landing on the
  drawn edge of an ellipse or a diamond rather than the box around it. Select
  an arrow to drag either end onto another shape (or off it); pick "Elbow" in
  the style menu or the right-click menu for right-angled routing. Deleting a
  shape leaves its arrows where they were. Single-letter hotkeys pick tools
  (V, P, H, E, T, R, O, L, A) — see `docs/keyboard-shortcuts.md` and the new
  `docs/diagrams.md`. Everything still saves as a plain `.svg` that renders
  the same anywhere.

- **Help… menu and Prompts.** The ⌄ menu beside the + button gains a Help…
  page: the user guide, the shortcuts page, and **Prompts** — ready-made
  briefs an AI agent can act on, copied to the clipboard with one click. The
  first prompt converts a Marp deck and its SVG diagrams to follow the app
  theme; decks now bake the theme into whiteboard-style SVGs the way the
  markdown preview does, and re-bake them when you switch themes.
- **Marp slide decks.** A markdown file with `marp: true` in its frontmatter
  is a slide deck: Split shows the slides beside the text (the one under your
  cursor highlighted), the Review mode becomes **Present** — a light table of
  slides with your speaker notes under each — and F11 twice runs the show:
  one slide on a dark screen, keyboard driven, Esc back to where you were.
  The status bar counts slides and estimates the talk length, and Export…
  writes a standalone HTML deck. Themes from the Marp built-ins or a CSS file
  kept next to the deck.

## [0.8.1] — 2026-09-15

- **Switching modes keeps your place in the file.** Flipping between Raw,
  Split, Review and Edit now lands you where you were reading instead of
  jumping back to the top — it carries the line at the top of the screen
  across. For a code file in Review it lands on the card for that line.

- **"Rich" mode is now called "Edit".** The word-processor view for markdown
  files keeps the same Ctrl+3 shortcut and behaviour — only the name in the
  status bar, the command palette and Settings changes.

- **Cut, copy and paste files and folders in the workspaces pane.** Right-click
  any row for Cut / Copy, then Paste into a folder or workspace header — or use
  Ctrl+X, Ctrl+C and Ctrl+V on the selected row, as in VS Code and File
  Explorer. A cut row dims until you paste it; a copy lands as "name copy" when
  something with that name is already there, and can be pasted into as many
  folders as you like. Whole folders come along with everything inside them.

- **Copy a folder's path.** "Copy path" is now on folder and workspace
  right-click menus too, not just files.

- **Right-click menus near the bottom of the workspace pane stay whole.** A
  menu that would run off the bottom of the window now opens upwards (and
  scrolls if it is taller than the window) instead of being cut off.

- **Review notes live in the document.** The Review-mode button is now
  "Review notes" (they are typed on desktop and spoken on the phone). Press
  and hold a line and the note box opens right under it, like a comment in
  a word processor — no side panel. Every paragraph or code card that
  already has a note shows a marker in the margin; tap it to read, edit or
  delete the notes right there, and a saved note opens where it landed.

- **See all review notes.** A new "All notes" button beside the toggle (and
  a palette command) opens an overview of every note across your
  workspaces — newest first or grouped by document, searchable, scoped to
  the current document if you like. Edit a note in place, delete it, or
  "Go to" it: the document opens in Review mode scrolled to the note.
  Works as a side panel on desktop and a full-screen sheet on a phone.

- **Review notes are typed on desktop.** The note box is a text field with
  a Save button; use Win+H (Windows) or the Dictation key (macOS) to talk
  into it, or tap the microphone to dictate offline with Whisper. If Whisper
  isn't installed yet, the microphone is an Install button that downloads
  the model right there. The phone keeps voice first, with a text field too.

- **Voice typing.** A microphone in the ribbon in Raw, Split and Rich modes
  types what you say at the cursor — Windows voice typing, offline Whisper,
  or the phone's recognizer, the same engines as Review's voice notes.

- **Read mode is now Review.** The fourth mode (Ctrl+4) is called Review for
  every file type, matching the code view.

- **Whisper everywhere, and faster.** Offline dictation now runs on the GPU
  (Vulkan on Windows and Linux, Metal on macOS — several times faster, with
  a switch in Settings to force the CPU), works on Android as an alternative
  to the device's recognizer, and offers to download its model on first
  launch so it is ready before the first voice note. The model list is four
  compact files (Tiny, Base, Small, Large v3 Turbo); an earlier version's
  full-precision downloads are migrated and can be removed from Settings.
- **Review mode for code files.** Open a `.ts`, `.tsx`, `.js` or `.rs` file
  and press Ctrl+4 to see it as plain-English cards instead of syntax: one
  card per declaration, forms for types, an x-ray-folded Code expander,
  Flow and Calls diagrams, and a *What changed* view against a git
  baseline.
- **Voice notes.** In Review mode (and on code Review cards) press and hold and
  dictate; the note lands in a `.comments.md` sidecar the document never
  sees, ready for an agent to act on. Windows voice typing on Windows,
  offline Whisper on macOS/Linux (downloadable models, no audio saved),
  native recognizer on Android. Spoken identifiers snap to real names.
- **Live edit.** Mark a shared folder and open files merge outside changes
  as they land; a lost collision flashes red and offers *Restore mine*.
- **Explorer:** show or hide unsupported files per workspace or folder.
- Windows 11: launching from an empty virtual desktop opens the window
  there.

## [0.7.3] — 2026-09-02

- **Terminal tabs follow the shell.** Shell integration reports `cd`, so a
  terminal tab takes its workspace's color, and right-click helpers
  (*Change directory…*, *List files*, *Open Claude*) type the real command
  for you.
- **Harness detection and install.** Settings shows which AI agents
  (Claude Code, Copilot, opencode) are installed and offers to install the
  missing ones; light themes made readable for agent TUIs.
- **Settings** reorganized into tabs, with *Update now* and a weekly
  automatic update check.
- Whiteboard fixes: overlay opacity, vanishing strokes, and boards that
  blend into the surface they sit on; right-click a board image to switch
  its theme.
- File explorer: cross-workspace moves and case-only renames on cloud
  volumes.

Earlier releases are described on the
[GitHub Releases](https://github.com/l-small-tech/md-notepad/releases) page.
