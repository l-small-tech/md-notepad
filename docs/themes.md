# Themes

A **theme** sets the colors the app uses — the background, the text, the accent
on links and headings, and so on. Themes are what make long reading and writing
sessions comfortable, so it's worth finding (or making) one you like.

Pick a theme in the **☰ menu → Themes** — every installed theme is listed
there, with a ✓ on the one you're using, and picking one applies it instantly.
(The same list is also in **Settings → Theme**.) It starts with **System**
(**Light Green** when your computer is in light mode, **Dark Green** in dark
mode, switching live when it changes), then every theme grouped by its declared
mode:

- **Light** — **Light Green**, **Beacon** (maximum-contrast black-on-white),
  **Skylark** (color-vision-friendly), **Lagoon** (shallow tropical water),
  **Marmalade** (orange), **Honeycomb** (yellow), **Ultramarine** (blue),
  **Dragonfruit** (magenta), and any light theme you add yourself.
- **Dark** — **Dark Green**, **Vantablack** (maximum-contrast white-on-black),
  **Nightjar** (color-vision-friendly), **Abyss** (lightless deep ocean),
  **Garnet** (red), **Cyanotype** (blueprint cyan), **Amethyst** (violet), and
  any dark theme you add yourself.

Two pairs deserve a special note:

- **Beacon / Vantablack** are the high-contrast pair — pure black-and-white
  grounds with hard borders and a loud selection color, for harsh glare,
  low-vision use, and OLED screens.
- **Skylark / Nightjar** are built entirely from the Okabe–Ito palette, whose
  colors stay distinguishable under the common forms of color-vision
  deficiency — nothing in them relies on telling red from green.

Unlike **System**, each named theme keeps its one look — light stays light and
dark stays dark, whatever your computer's light/dark setting. You pick the
mood, not the machine.

The best part: **themes are just small files you can edit or create yourself** —
no programming needed, and an AI assistant can write a whole theme for you in
seconds. Read on.

## The themes folder

Every theme is one small `.json` file in your **themes folder**. Below the
theme list in **☰ menu → Themes** are the buttons for managing it:

- **Open folder** — opens the themes folder in your file manager, so you can
  see the files, drop new ones in, or make copies. *(Desktop only.)*
- **New theme…** — creates a fresh theme file (a copy of the Default palette),
  selects it, and reveals it so you can start editing.
- **Reload** — re-reads the folder after you've edited or added files, so your
  changes show up right away.
- **Help** — opens this page.

The fifteen example themes live here too — open any of them to see exactly how
a theme is built, or copy one as a starting point.

## What a theme file looks like

A theme is a name, a **mode** (`"light"` or `"dark"` — the look it presents),
and one **branding** block of colors. Here's a complete one:

```json
{
  "name": "Midnight",
  "mode": "dark",
  "branding": {
    "primary": "#6ea1ff",
    "secondary": "#ff6b5e",
    "tertiary": "#8a63d2",
    "bg": "#0f1419",
    "editorBg": "#0b0f14",
    "bgAlt": "#1a212b",
    "bgHover": "#242d3a",
    "fg": "#e6e6e6",
    "fgMuted": "#8a94a3",
    "accent": "#6ea1ff",
    "border": "#2a3240",
    "danger": "#ff6b5e",
    "selection": "#264066"
  }
}
```

Save it as, say, `midnight.json` in the themes folder, click **Reload**, and
"Midnight" appears in the Theme dropdown's Dark group. The **file name**
(without `.json`) is the theme's id, so keep it simple: lowercase letters,
numbers, and dashes.

### The branding colors

Colors can be written as hex (`#rrggbb`), `rgb(...)`, `hsl(...)`, or a named
color like `navy`.

First, the **brand trio** — your theme's three identity colors. They drive the
vector drawings' themed ink palette (the pens automatically match your theme):

| Key         | What it is |
| ----------- | ---------- |
| `primary`   | The theme's signature color — usually the same as `accent`. |
| `secondary` | The strongest supporting color. |
| `tertiary`  | A third distinct color to round out the set. |

Then the ten interface colors:

| Key          | What it colors |
| ------------ | -------------- |
| `bg`         | The main app background (toolbar, tabs, sidebar). |
| `editorBg`   | The writing surface — usually a hair different from `bg`. |
| `bgAlt`      | Secondary panels and subtle raised areas. |
| `bgHover`    | The highlight when you hover over a button or list row. |
| `fg`         | The main text color. |
| `fgMuted`    | Secondary text — hints, labels, inactive items. |
| `accent`     | Links, headings, and active highlights. |
| `border`     | Lines between panels and around controls. |
| `danger`     | Warnings and destructive actions (e.g. delete). |
| `selection`  | The highlight behind selected text. |

You don't have to include everything — any key you leave out simply uses the
Default value for your theme's mode, and a missing trio is derived from your
`accent`, `danger`, and `fg`. But for a polished result, set them all.

### Coloring markdown elements (optional)

The branding colors cover the whole app. If you also want to recolor
**individual markdown elements** — give headings their own color, tint links,
make code stand out — add an optional `"syntax"` block. Any key you set applies
in every view (source, Rich, and Read). Leave the block out entirely, or leave
any key unset, and that element keeps its normal color.

```json
{
  "name": "Inky",
  "mode": "light",
  "branding": { "bg": "#ffffff", "fg": "#1f1f1f", "accent": "#3574f0" },
  "syntax": {
    "heading": "#8a101f",
    "bold": "#1f1f1f",
    "italic": "#6e6e6e",
    "link": "#3574f0",
    "code": "#b23a2b",
    "quote": "#6e6e6e",
    "list": "#6e6e6e"
  }
}
```

The keys:

| Key             | What it colors |
| --------------- | -------------- |
| `heading`       | All headings (levels 1–6). |
| `heading1`…`heading6` | A single heading level — overrides `heading` for that level. |
| `bold`          | **Bold** text. |
| `italic`        | *Italic* text. |
| `strikethrough` | ~~Struck-through~~ text. |
| `link`          | Links and URLs. |
| `code`          | Inline code and code blocks. |
| `quote`         | Blockquotes. |
| `list`          | List bullets and numbers. |

To color each heading level differently, set `heading1` through `heading6`
instead of (or on top of) `heading`.

### Terminal colors (optional)

Terminal tabs paint with a 16-color ANSI palette plus a background,
foreground, cursor and selection. You don't have to supply any of it: the
palette is **derived from your branding colors** — `accent` becomes blue and
the cursor, `danger` becomes red, `fgMuted` becomes bright black, `editorBg`
and `fg` become the surface and the text — and each derived color is checked
against the background and nudged until it's comfortably readable. Every theme
therefore arrives with a working terminal palette and nothing to decide.

If you want exact control, add an optional `"terminal"` block. Anything you
leave out stays derived, so setting one key sets one key:

```json
{
  "name": "Midnight",
  "mode": "dark",
  "branding": { "editorBg": "#0b0f14", "fg": "#e6e6e6", "accent": "#6ea1ff" },
  "terminal": {
    "cursor": "#ffcc00",
    "red": "#ff6b5e",
    "green": "#9ece6a",
    "blue": "#6ea1ff"
  }
}
```

The keys:

| Key | What it colors |
| --- | -------------- |
| `background` / `foreground` | The terminal surface and its default text. |
| `cursor` | The block/bar cursor. |
| `cursorText` | The character *under* a block cursor. `null` = the background color. |
| `selection` | The highlight behind selected terminal text. |
| `selectionText` | Text inside a selection. `null` = each character keeps its own color. |
| `black` `red` `green` `yellow` `blue` `magenta` `cyan` `white` | ANSI colors 0–7. |
| `brightBlack` … `brightWhite` | ANSI colors 8–15. |

The terminal's **font** is not part of the theme: terminal cells use the same
Editor font and size as your notes, so Ctrl/Cmd `+` / `-` resizes them too
(and `Ctrl+Shift` with `+` / `-` zooms one pane on its own).

### Advanced: the `css` field (optional)

If you want to go beyond colors — say, add letter-spacing in Read mode or tweak
a font — you can add an optional `"css"` field with raw CSS. It's applied only
when your theme is selected. Most people never need this; skip it unless you
know CSS.

```json
{
  "name": "Airy",
  "mode": "light",
  "branding": { "bg": "#fbfbfa", "fg": "#2b2b2b" },
  "css": ".markdown-body { line-height: 1.8; }"
}
```

## Let an AI build your theme

You don't have to pick the colors yourself. Paste the prompt below into any AI
assistant (ChatGPT, Claude, Gemini, …), describe the mood you want, and drop the
result into your themes folder.

> I'm making a color theme for a markdown notepad app. A theme is a JSON file
> with a `name`, a `mode` (either `"light"` or `"dark"` — the one look the
> theme presents), and a `branding` palette. The palette has these keys, all
> color strings (hex is fine):
>
> - `primary`, `secondary`, `tertiary` — the theme's three identity colors
>   (`primary` is usually the same as `accent`)
> - `bg` — main app background
> - `editorBg` — the writing surface (a hair off `bg`)
> - `bgAlt` — secondary panels
> - `bgHover` — hover highlight
> - `fg` — main text
> - `fgMuted` — secondary text
> - `accent` — links and headings
> - `border` — dividing lines
> - `danger` — warnings/delete
> - `selection` — selected-text highlight
>
> Optionally also add a flat `syntax` object to recolor markdown elements,
> using any of these keys: `heading` (or `heading1`…`heading6` for per-level),
> `bold`, `italic`, `strikethrough`, `link`, `code`, `quote`, `list`.
>
> Please output only a valid JSON file. Make it **[describe what you want — e.g.
> "a warm, low-contrast sepia theme that's easy on the eyes at night"]**. If the
> mode is light, use dark text on light backgrounds; if dark, light text on dark
> backgrounds — with enough contrast to read comfortably.

Save the AI's output as `something.json` in your themes folder, click
**Reload**, and select it. If it doesn't look right, ask the AI to adjust and
reload again.

## Tips & troubleshooting

- **It's not in the list** — click **Reload**. Make sure the file ends in
  `.json` and is valid JSON (a missing comma or quote will make the app skip
  it), and that the colors sit inside a `"branding"` block — files from older
  versions with separate `"light"`/`"dark"` blocks are skipped. Pasting the
  file's contents back to your AI and asking it to "convert to the branding
  format" usually sorts it out.
- **Some colors look wrong** — you may have left those keys out (they fall back
  to Default) or set a `mode` that doesn't match your palette's brightness.
- **A theme disappeared** — if you delete a theme's file while it's selected,
  the app quietly falls back to the Default palette. Pick another scheme, or add
  the file back.
- **Editing on the fly** — keep the file open in the app (or an editor), tweak a
  color, save, and click **Reload** to see it instantly.
- **Multiple windows** — a newly added theme shows up in other open windows
  after you click **Reload** in each (or restart the app).

The fifteen example themes are yours to modify — if you change one and want the
original back, just delete your version and reopen Settings (the app re-creates
any missing example on the next launch).
