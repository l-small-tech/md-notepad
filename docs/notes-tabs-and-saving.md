# Notes, tabs, and saving

MD Notepad works with two kinds of tabs: **notes** and **files**. Knowing
the difference explains everything about saving.

## Notes — the tabs you never save

Any tab you create with **Ctrl+N** (Cmd+N on Mac) or the `+` button is a
*note*. Notes save themselves:

- Everything you type is stored on your computer automatically, within a few
  seconds of typing it.
- Quit the app, restart your computer, even lose power — your notes come
  back, tabs and all.
- Each note is quietly kept as a real markdown file in your **notes folder**
  (you can see and change that folder in Settings). The file is named after
  the note's first line.

**Closing a note deletes it.** That's the Notepad way: a note lives exactly
as long as its tab. The app asks you to confirm before discarding a note
that has any text in it. If you want to keep a note *and* close its tab,
save it as a file first (Ctrl+Shift+S) — see below.

## Files — regular documents you open and save

Open an existing markdown document with **Ctrl+O**, by dragging it onto the
window, or by double-clicking it in your system's file manager. That tab is a
*file* tab, and it behaves like a traditional editor:

- Your edits are **not** written to the file until you press **Ctrl+S**.
- A dot on the tab means "you have unsaved changes".
- Closing the tab with unsaved changes asks whether to save, discard, or
  cancel.
- Even here you're protected: unsaved edits survive a crash or restart —
  the tab reopens with your edits still in it, still marked unsaved.

Prefer files to save themselves too? Turn on **Live save** in Settings and
open files are written automatically as you type, like notes.

### Save and Save As

- **Ctrl+S** — save the current file. On a *note* tab this acts as Save As,
  turning the note into a regular file wherever you choose.
- **Ctrl+Shift+S** — Save As: save a copy under a new name or location. The
  tab switches over to the new file.

### If a file changes behind your back

If another program (or a sync service like Dropbox) changes a file while
you have it open, a banner appears at the top of that tab:

- **Reload** — throw away your version and load what's on disk.
- **Keep mine** — keep your version; the file is overwritten the next time
  you save.

## Working with tabs

- **New tab**: Ctrl+N or the `+` button.
- **Switch tabs**: click, or Ctrl+Tab / Ctrl+Shift+Tab to cycle.
- **Close**: the × on the tab, Ctrl+W, or middle-click. Closing the last tab
  always leaves one fresh empty note.
- **Close all**: right-click a tab for the menu.
- **Reorder**: drag tabs left and right.
- **Rename**: double-click the tab name, press F2, or right-click →
  Rename. Renaming also renames the file on disk, so tab and file always
  match. Rename a note to a blank name to go back to automatic naming.

## Split view

Want two tabs open at once in the same window? Right-click a tab and pick
**Split right** (side by side) or **Split down** (stacked). That tab is
pinned into the second pane — marked with a small accent underline in the
tab strip — while the tab strip keeps switching the first pane as usual.
Both panes are full editors: you can type in either one.

- **Resize**: drag the divider between the panes.
- **Bring the pinned tab back**: click it in the tab strip — the two panes
  swap, so your click always wins.
- **Back to one pane**: right-click any tab → **Close split** (closing the
  pinned tab does it too).

## Multiple windows

Want two documents side by side? Drag a tab out of the window and release
it — the tab opens in its own window right where you dropped it. You can
also right-click a tab and pick **Move to new window** (on Linux this menu
item is the way to do it).

Extra windows are full editors: everything above about notes, files, and
saving applies in each one. They're part of your session too — quit the app
and they come back, tabs and all. Closing an extra window with its × doesn't
lose anything: its tabs slide back into the main window.

Your notes are ordinary markdown files in your notes folder — you can back
them up, sync them, or open them in any other app whenever you like.
