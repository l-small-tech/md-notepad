# Keyboard shortcuts

On Mac, use **Cmd** wherever **Ctrl** is shown (except F2, F11, and Esc,
which are the same everywhere).

## Tabs

| Shortcut | What it does |
| --- | --- |
| Ctrl+N | New note tab |
| Ctrl+W | Close the current tab |
| Ctrl+Tab | Next tab |
| Ctrl+Shift+Tab | Previous tab |
| F2 | Rename the current tab (and its file) |

## Files

| Shortcut | What it does |
| --- | --- |
| Ctrl+O | Open a file |
| Ctrl+S | Save (on a note tab: Save As) |
| Ctrl+Shift+S | Save As |

## Editing (Raw and Split modes)

| Shortcut | What it does |
| --- | --- |
| Enter (on a list line) | Continue the list with a new bullet/number |
| Tab (on a list line) | Indent one level, with any nested items below it |
| Shift+Tab (on a list line) | Un-indent one level, with any nested items below it |

Indenting works like a word processor. Bullet markers change with depth — `*` at
the left margin, `-` one level in, `+` two levels in, then repeating — so
un-indenting a nested `- item` twice brings back `* item` at the margin. Ordered
lists are renumbered as you go: nesting an item restarts it at `1.` and closes
the gap it left behind. (Markdown has no letter numbering, so nested ordered
lists stay numeric.) The first item at any depth has nothing to nest under, so
Tab leaves it where it is.

## Viewing modes

| Shortcut | What it does |
| --- | --- |
| Ctrl+1 | Raw — plain markdown text |
| Ctrl+2 | Split — text and preview side by side |
| Ctrl+3 | Rich — word-processor style |
| Ctrl+4 | Read — read-only, full-width |

## Display

| Shortcut | What it does |
| --- | --- |
| Ctrl+= | Larger text |
| Ctrl+- | Smaller text |
| Ctrl+0 | Reset text size |
| F11 (Mac: Ctrl+Cmd+F) | Full screen in Read mode — press again for more, Esc to step back |

## Everything else

| Shortcut | What it does |
| --- | --- |
| Ctrl+K | Command palette — type to search every command |
| Ctrl+Shift+O | Toggle the outline panel (jump between headings) |
| Ctrl+, | Open Settings |
| Ctrl+F | Find within the note (Raw and Split modes) |
| Ctrl+Shift+F | Search across all workspaces — click a result to jump to it |
| Esc | Close Settings / the command palette / leave full screen |

A few mouse tricks worth knowing: middle-click a tab to close it,
double-click a tab name to rename it, drag tabs to reorder them, and
right-click tabs, files, and workspace headings for their menus.
