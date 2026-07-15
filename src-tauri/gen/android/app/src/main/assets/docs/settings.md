# Settings

Open Settings with the **⚙** button in the toolbar or **Ctrl+,** (Cmd+, on
Mac). Changes apply immediately — there's no OK button to press — and are
remembered. Press Esc or click outside the panel to close it.

## Appearance

- **Theme** — one list that combines the light/dark mode and the color scheme:
  - **System**, **Light**, and **Dark** use the app's built-in palette.
    *System* follows your computer's setting, switching live when it changes.
  - Below the divider are the **themes**: **Solarized**, **Nord**, **Gruvbox**,
    **Everforest**, **Rosé Pine**, **Light Green**, and **Dark Green** ship as
    example *theme files* you can edit — and you can add your own. Each theme has
    both a light and a dark version and **follows your computer's light/dark
    setting automatically**.

  See **[Themes](themes.md)** for how to make your own (an AI can write one for
  you in seconds) — a theme can set the whole palette *and* recolor individual
  markdown elements (headings, bold, links, …). The **Themes folder** row below
  the dropdown has buttons to **Open folder**, start a **New theme…**, and
  **Reload** after editing.
- **Font size** — the size of text in the editor and previews. You can also
  change it any time with **Ctrl+=** / **Ctrl+-** (and **Ctrl+0** to
  reset), which is especially handy in Read mode.
- **Editor font** — the typeface for your notes, in the editor and in
  previews. Seven open-source coding fonts ship with the app: **Fira Code**
  (the default, and our recommendation), JetBrains Mono, Cascadia Code,
  Source Code Pro, IBM Plex Mono, Inconsolata, and Victor Mono (known for
  its cursive italics).
- **Interface font** — the typeface for the app's own chrome: tabs, the
  sidebar, dialogs. **Match editor font** (the default) keeps the classic
  monospace-everywhere look; **Inter** is a clean sans-serif made for user
  interfaces, worth trying if you'd like the chrome to stay out of the way
  of your text; **System sans-serif** uses your operating system's UI font.
- **Font ligatures** — fonts that support it (Fira Code, JetBrains Mono,
  Cascadia Code, Victor Mono) can join character pairs like `->` into a
  single arrow glyph. Purely cosmetic; turn it off if you prefer to see
  the characters as typed.
- **Cursor style** — the shape of the editing caret: **Bar** (the default, a
  slim vertical line), **Thin** (a hairline bar), **Thick** (a bold bar), or
  **Underscore** (an underline beneath the character).
- **Word wrap** — when on (the default), long lines wrap to fit the window.
  When off, long lines run sideways and you scroll horizontally.
- **Read mode margins** — how wide the text column is in Read mode:
  **Narrow** margins put more text on screen; **Wide** margins give a
  centered, book-like column.

## Behavior

- **Default mode (new tabs)** — which of the four viewing modes
  ([explained here](editing-modes.md)) a new tab starts in: Raw, Split,
  Rich, or Read.
- **Live save** — when on, files you've opened save themselves as you type,
  just like notes do. When off (the default), files wait for Ctrl+S.
- **Confirm before moving files between folders** — whether dragging a file
  to a new folder in the sidebar asks "are you sure?" first.
- **Preview tabs** — when on (the default), single-clicking a file in the
  sidebar opens it in a reusable, italicized preview tab, and double-click
  (or editing) keeps it open permanently. When off, every click opens its
  own tab.

## Images

- **Pasted / dropped images** — where pictures you paste or drag in are
  stored, relative to the note that uses them. See
  [Pictures in your notes](pictures-and-images.md).
- **Image folder name** — the name of the images folder used by the
  "subfolder" and "workspace root" choices.

## Notes folder

Shows where your notes live, with a **Change…** button to move them. When
you pick a new folder the app offers to bring your existing notes along.
The default location is inside your personal app-data folder; many people
point it at a synced folder (Dropbox, OneDrive, etc.) instead so notes
follow them between computers.

## Documentation

**Open docs** opens this user guide in the sidebar as a read-only
**Documentation** workspace.

## Updates

The bottom row shows the version you're running and a **Check for updates**
button. The app also checks quietly on its own shortly after launch:

- If a newer version exists, a small **"Update available"** chip appears in
  the status bar — nothing pops up over your work.
- Click the chip and the update downloads, installs, and restarts the app.
  Your open tabs are written to disk first, so updating never loses a word.
- Every update is cryptographically checked before it's installed, and a
  failed check-for-updates never bothers you (if you're offline, nothing
  happens).
