# Themes

A **theme** sets the colors the app uses — the background, the text, the accent
on links and headings, and so on. Themes are what make long reading and writing
sessions comfortable, so it's worth finding (or making) one you like.

Pick a theme in **Settings → Theme**. That one dropdown starts with **System**
(**Light Green** when your computer is in light mode, **Dark Green** in dark
mode, switching live when it changes), then — below a divider — every theme: six ready-made examples ship with the
app — four popular community schemes (**Solarized**, **Nord**, **Dracula**,
and **Monokai**) plus two originals, **Light Green** and **Dark Green** (a
fresh, forest-green pair). Each community theme comes in both a light and a
dark version, and the app automatically uses the right one based on your
computer's light/dark setting.

The best part: **themes are just small files you can edit or create yourself** —
no programming needed, and an AI assistant can write a whole theme for you in
seconds. Read on.

## The themes folder

Every theme is one small `.json` file in your **themes folder**. In Settings,
the **Themes folder** row (just under the Theme dropdown) has three buttons:

- **Open folder** — opens the themes folder in your file manager, so you can
  see the files, drop new ones in, or make copies. *(Desktop only.)*
- **New theme…** — creates a fresh theme file (a copy of the Default palette),
  selects it, and reveals it so you can start editing.
- **Reload** — re-reads the folder after you've edited or added files, so your
  changes show up right away.

The six example themes live here too — open any of them to see exactly how a
theme is built, or copy one as a starting point.

## What a theme file looks like

A theme is a small block of colors for **light** mode and **dark** mode, plus a
name. Here's a complete one:

```json
{
  "name": "Midnight",
  "light": {
    "bg": "#ffffff",
    "editorBg": "#f7f7f5",
    "bgAlt": "#f0f0f0",
    "bgHover": "#e8e8e8",
    "fg": "#1a1a1a",
    "fgMuted": "#6a6a6a",
    "accent": "#3060d0",
    "border": "#e0e0e0",
    "danger": "#c42b1c",
    "selection": "#b5d1ff"
  },
  "dark": {
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
"Midnight" appears in the Theme dropdown. The **file name** (without
`.json`) is the theme's id, so keep it simple: lowercase letters, numbers, and
dashes.

### The ten colors

Colors can be written as hex (`#rrggbb`), `rgb(...)`, `hsl(...)`, or a named
color like `navy`.

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

You don't have to include all ten — any you leave out simply use the Default
theme's value. But for a polished result, set them all for both light and dark.

### Coloring markdown elements (optional)

The ten colors above cover the whole app. If you also want to recolor
**individual markdown elements** — give headings their own color, tint links,
make code stand out — add an optional `"syntax"` block. It has a `light` and a
`dark` palette of its own, and any key you set applies in every view (source,
Rich, and Read). Leave the block out entirely, or leave any key unset, and that
element keeps its normal color.

```json
{
  "name": "Inky",
  "light": { "bg": "#ffffff", "fg": "#1f1f1f", "accent": "#3574f0" },
  "dark": { "bg": "#1e1e1e", "fg": "#e8e8e8", "accent": "#6ea1ff" },
  "syntax": {
    "light": {
      "heading": "#8a101f",
      "bold": "#1f1f1f",
      "italic": "#6e6e6e",
      "link": "#3574f0",
      "code": "#b23a2b",
      "quote": "#6e6e6e",
      "list": "#6e6e6e"
    },
    "dark": {
      "heading": "#ff8a97",
      "link": "#6ea1ff",
      "code": "#ff6b5e"
    }
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

### Advanced: the `css` field (optional)

If you want to go beyond colors — say, add letter-spacing in Read mode or tweak
a font — you can add an optional `"css"` field with raw CSS. It's applied only
when your theme is selected. Most people never need this; skip it unless you
know CSS.

```json
{
  "name": "Airy",
  "light": { "bg": "#fbfbfa", "fg": "#2b2b2b" },
  "dark": { "bg": "#1b1b1b", "fg": "#dddddd" },
  "css": ".markdown-body { line-height: 1.8; }"
}
```

## Let an AI build your theme

You don't have to pick the colors yourself. Paste the prompt below into any AI
assistant (ChatGPT, Claude, Gemini, …), describe the mood you want, and drop the
result into your themes folder.

> I'm making a color theme for a markdown notepad app. A theme is a JSON file
> with a `name`, a `light` palette, and a `dark` palette. Each palette has these
> ten keys, all color strings (hex is fine):
>
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
> Optionally also add a `syntax` object with `light` and `dark` palettes to
> recolor markdown elements, using any of these keys: `heading` (or
> `heading1`…`heading6` for per-level), `bold`, `italic`, `strikethrough`,
> `link`, `code`, `quote`, `list`.
>
> Please output only a valid JSON file. Make it **[describe what you want — e.g.
> "a warm, low-contrast sepia theme that's easy on the eyes at night"]**. Ensure
> the light palette has dark text on light backgrounds and the dark palette has
> light text on dark backgrounds, with enough contrast to read comfortably.

Save the AI's output as `something.json` in your themes folder, click
**Reload**, and select it. If it doesn't look right, ask the AI to adjust and
reload again.

## Tips & troubleshooting

- **It's not in the list** — click **Reload**. Make sure the file ends in
  `.json` and is valid JSON (a missing comma or quote will make the app skip
  it). Pasting the file's contents back to your AI and asking it to "fix the
  JSON" usually sorts it out.
- **Some colors look wrong** — you may have left those keys out (they fall back
  to Default) or set light/dark values that are too close in brightness.
- **A theme disappeared** — if you delete a theme's file while it's selected,
  the app quietly falls back to the Default palette. Pick another scheme, or add
  the file back.
- **Editing on the fly** — keep the file open in the app (or an editor), tweak a
  color, save, and click **Reload** to see it instantly.
- **Multiple windows** — a newly added theme shows up in other open windows
  after you click **Reload** in each (or restart the app).

The seven example themes are yours to modify — if you change one and want the
original back, just delete your version and reopen Settings (the app re-creates
any missing example on the next launch).
