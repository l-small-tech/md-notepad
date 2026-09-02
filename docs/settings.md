# Settings

Open Settings with the **⚙** button in the toolbar or **Ctrl+,** (Cmd+, on
Mac). Changes apply immediately — there's no OK button to press — and are
remembered. Press Esc or click outside the panel to close it.

## Appearance

- **Theme** — one list that combines the light/dark mode and the color scheme:
  - **System** follows your computer's light/dark setting, switching live
    when it changes: **Light Green** in light mode, **Dark Green** in dark.
  - Below it every theme is grouped by its declared mode: **Light**
    (**Light Green**, **Paper**, **Solarized Light**, **Nord Light**) and
    **Dark** (**Dark Green**, **Solarized Dark**, **Nord Dark**, **Dracula**,
    **Monokai**) — themes you add yourself join the group their `mode`
    declares. They all ship as example *theme files* you can edit, and each
    keeps its one look — light or dark — whatever your computer's light/dark
    setting.

  See **[Themes](themes.md)** for how to make your own (an AI can write one for
  you in seconds) — a theme can set the whole palette *and* recolor individual
  markdown elements (headings, bold, links, …). The same list — plus the
  **Open folder**, **New theme…**, **Reload**, and **Help** buttons — lives in
  the **⌄ menu → Themes** (the arrow beside the `+` button on the tab bar).
- **This window only** — a theme normally applies to every open window and is
  remembered for next launch. Tick this box (or **right-click** a theme in the
  **⌄ menu → Themes** list) to dress just the window you're in — handy for
  telling two windows apart at a glance. The other
  windows keep the shared theme, and picking further themes here keeps
  affecting only this window until you untick the box (or choose **Use shared
  theme** in that menu). A window-only theme lasts as long as the window: on
  the next launch it follows the shared theme again.
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
  just like notes do. When off (the default), files wait for Ctrl+S. You can
  also flip it without opening Settings: press and hold the toolbar's save
  button and pick **Auto save**.
- **Confirm before moving files between folders** — whether dragging a file
  to a new folder in the sidebar asks "are you sure?" first.
- **Arrange tabs by workspace** — off by default, so tabs stay wherever you
  drag them. Turn it on and the tabs of one workspace are kept side by side:
  opening or dragging a tab slots it next to the others from its folder. Either
  way, a tab always wears the color of the workspace its file lives in, so the
  strip reads like the sidebar.
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

## Terminal (desktop only)

Terminal tabs have their own group of settings; none of these exist on
Android, which has no terminal.

- **Shell** — the shell every terminal runs. **Automatic** picks your
  system's usual one (PowerShell 7 on Windows, zsh on macOS, bash on Linux);
  the list offers the common alternatives, and **Custom…** takes any program
  name or full path. Applies to terminals opened from now on.
- **Font** — the typeface for terminal text. **Fira Code** by default —
  terminals want box-drawing and column alignment more than prose does — or
  **Match editor font** to follow your notes. The *size* always follows the
  editor's **Font size** (and **Ctrl+=** / **Ctrl+-** inside a terminal zooms
  just that pane).
- **Default profile** — which launch configuration a plain **New terminal**
  uses. Profiles are edited by hand in `settings.json` under
  `terminalProfiles`; each has an `id`, a `name`, optional `program` and
  `args`, an optional starting folder `cwd`, extra `env`, and two optional
  size fields: `fontSize` (an absolute cell size in pixels) or
  `fontSizeDelta` (pixels added to the editor's font size — `2` means "two
  larger than my notes", and it keeps following Ctrl+= / Ctrl+-). If both are
  present, `fontSize` wins.
- **AI TUI** — the coding agent the new-tab menu's **AI** row launches:
  **Claude** (Claude Code, the default), **ChatGPT** (the `codex` CLI),
  **Gemini**, **Grok**, **Copilot** (GitHub Copilot CLI), **opencode**, or
  **Custom…** with your own command line (`aider --model sonnet`). The app
  checks which of these are actually installed — at start-up, whenever this
  dialog opens, and on **Re-check** — and shows each one's status:
  - Found: a check mark and where the command lives.
  - Not found: the name is dimmed (you can still pick it) with an **Install**
    button beside it. Install opens a terminal tab and types the tool's
    official install command into your shell — a package manager you already
    have (winget, Homebrew, scoop) when the tool ships there, otherwise its own
    user-space installer, otherwise `npm install -g` (with Node.js installed
    first if you have no `npm`). Nothing runs hidden: you see the exact
    command, answer any prompt yourself, and keep the shell afterwards. Close
    that tab (or press **Re-check**) and the row updates.

  The AI tab renders a touch larger than your notes — two pixels over the
  editor's font size — since an agent's output is mostly read, not typed.
  It still follows Ctrl+= / Ctrl+-. (The **AI theme** button in
  ☰ Menu → Themes opens the same agent, in your themes folder.)
- **Cursor style**, **Blinking cursor**, **Scrollback**, **Lines per
  scroll**, **Bell** (never a sound — the cursor changes shape, the pane
  flashes, or nothing), **Copy on select**, **Confirm multi-line paste**,
  **Confirm closing a running shell**, **Keep the pane open after the shell
  exits**, **Alt sends Escape**, **Backspace sends DEL**, and **Let programs
  set the clipboard (OSC 52)** — the usual terminal-emulator knobs, each
  explained on its row.

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
