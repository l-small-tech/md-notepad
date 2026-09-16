# Changelog

Every tagged release gets a short, high-level entry here: the handful of
improvements a user would want to know about, not an inventory of commits.
The release workflow copies the tagged version's section into the GitHub
release notes and refuses to build a tag that has none.

Keep an `## [Unreleased]` section at the top while working; rename it to
`## [X.Y.Z] — YYYY-MM-DD` when bumping the version.

## [Unreleased]

- **Switching modes keeps your place in the file.** Flipping between Raw,
  Split, Review and Rich now lands you where you were reading instead of
  jumping back to the top — it carries the line at the top of the screen
  across. For a code file in Review it lands on the card for that line.

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

## [0.8.0] — 2026-09-11

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
