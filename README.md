<div align="center">

<img src="assets/icon.svg" width="96" alt="MD Notepad icon" />

# MD Notepad

**A minimal, fast, cross-platform markdown notepad — with tabs you never have to save.**

*In the spirit of Windows 11 Notepad: open a tab, type, close the app. It's all there when you come back.*

[![Latest release](https://img.shields.io/github/v/release/l-small-tech/md-notepad?include_prereleases&label=release)](https://github.com/l-small-tech/md-notepad/releases)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-8e4ec6)](https://github.com/l-small-tech/md-notepad/releases)

[![Tauri](https://img.shields.io/badge/Tauri_2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-000000?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![React](https://img.shields.io/badge/React_19-087EA4?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)](https://vite.dev)
[![CodeMirror](https://img.shields.io/badge/CodeMirror_6-D30707?logo=codemirror&logoColor=white)](https://codemirror.net)
[![Milkdown](https://img.shields.io/badge/Milkdown-1e1e2e)](https://milkdown.dev)
[![Mermaid](https://img.shields.io/badge/Mermaid-FF3670?logo=mermaid&logoColor=white)](https://mermaid.js.org)

[Install](#install) · [Features](#features) · [Built for AI workflows](#built-for-ai-assisted-workflows) · [Docs](docs/README.md) · [Build from source](#build-from-source)

</div>

---

## Why

Notepad's ephemeral tabs are perfect for half-formed thoughts — open a tab,
type, close the app, and it's simply *there* again next time. MD Notepad
keeps that feel and adds what markdown people want: GitHub-Flavored
Markdown, Mermaid diagrams, four viewing modes, workspaces for browsing any
folder of markdown, and Fira Code with ligatures (`->` really is one glyph).

It's also quietly built for the age of AI pair-programming — see
[Built for AI-assisted workflows](#built-for-ai-assisted-workflows).

## Features

- 🗂️ **Notepad-style tabs** — unsaved notes persist across restarts; kill
  the app any time and lose at most ~5 seconds of typing. Tabs name
  themselves after their first line.
- 📄 **Notes are plain `.md` files** in a folder you choose — no database,
  no lock-in. Open and save regular files anywhere, too.
- 👁️ **Four modes per tab** — raw source (CodeMirror 6), split
  source+preview, WYSIWYG (Milkdown Crepe), and a distraction-free **Read**
  mode with zoom and fullscreen.
- 🧜 **Full GFM preview** — tables, task lists, strikethrough, autolinks —
  plus **Mermaid** diagrams rendered in place.
- 🗄️ **Workspaces** — add any folder as a sidebar section with its own
  accent color: browse, create, rename, move, and drag-and-drop files.
  Read-only workspaces supported.
- 🖼️ **Painless images** — paste a screenshot and it's saved beside your
  note and referenced at the caret; drag images in from anywhere.
  Configurable storage layout (subfolder / same folder / workspace root).
- 🔤 **Eight bundled open-source fonts** — Fira Code (default) plus
  JetBrains Mono, Cascadia Code, Source Code Pro, IBM Plex Mono,
  Inconsolata, and Victor Mono for your notes; optional Inter for the UI
  chrome. Ligatures on by default.
- 🪟 **Multiple windows** — drag a tab out of the window to open it in its
  own window at the drop point (or right-click → *Move to new window*).
  Extra windows are part of your session and come back on restart; closing
  one returns its tabs to the main window.
- 🌗 **Light / dark / system themes.** Small, quiet, fast.
- 🔄 **Safe auto-updates** — signed with minisign and verified before
  install; open tabs are flushed to disk first, so updating never costs
  typed text.

## Built for AI-assisted workflows

MD Notepad doubles as a **prompt notebook** for agentic AI tools like
[Claude Code](https://claude.com/claude-code). Lots of small heuristics add
up:

- **Copy carries your attachments.** The ⧉ button — and plain **Ctrl+C** on
  a selection — copies markdown *plus* an appended block of `@path`
  mentions for every local file and image the text references. Paste into
  an agent CLI and it can pull those files in directly. Build and store
  prompts with images and files explicitly included, then ship them with
  one copy-paste.
- **Absolute paths by default.** Inserted links, pasted screenshots, and
  dropped images are referenced by absolute path, so an agent (or any other
  tool) can resolve them no matter where it was launched. Alt+click the
  link buttons when you want a relative path instead.
- **Great for exploring a repo's `/docs`.** Add any folder — say, the
  documentation an agent just wrote — as a (read-only, if you like)
  workspace and read it rendered, with Mermaid diagrams, without leaving
  your notes.
- **Nothing is ever trapped.** Notes are ordinary markdown files on disk
  with human-readable names — agents can read and edit them, and your
  editor picks the changes up.

## Install

Prebuilt installers are on the
[Releases](https://github.com/l-small-tech/md-notepad/releases) page:
Windows (NSIS `.exe`), macOS (universal `.dmg`), Linux (`.deb`, `.rpm`,
`.AppImage`).

Because releases are not code-signed with paid OS certificates (yet):

- **Windows** SmartScreen: *More info → Run anyway* on first launch.
- **macOS** Gatekeeper: right-click the app → *Open* on first launch.

### Verifying a download

Every release ships `SHA256SUMS` and Sigstore build-provenance
attestations:

```sh
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify <asset-file> --repo l-small-tech/md-notepad
```

### Updates

The app checks GitHub Releases on launch (and on demand from Settings).
When a newer version exists, a quiet chip appears in the status bar — one
click downloads, installs, and restarts. Every update package is verified
against the minisign public key embedded in the app before it is applied.
The update check is silent on failure and never blocks startup — if you're
offline, nothing happens.

## Where your notes live

| OS | Default notes folder |
| --- | --- |
| Windows | `%APPDATA%\tech.l-small.mdnotepad\notes` |
| macOS | `~/Library/Application Support/tech.l-small.mdnotepad/notes` |
| Linux | `~/.local/share/tech.l-small.mdnotepad/notes` |

Changeable in Settings. Notes are ordinary markdown files named after their
first line — take them with you any time. Closing a note tab discards that
note (you'll be asked first); saving it elsewhere via *Save As* turns it
into a regular file.

## Documentation

The full user guide lives in [`docs/`](docs/README.md) and ships inside the
app — Settings → **Open docs** adds it to the sidebar as a read-only
workspace:

[Getting started](docs/getting-started.md) ·
[Notes, tabs & saving](docs/notes-tabs-and-saving.md) ·
[Viewing modes](docs/editing-modes.md) ·
[Writing markdown](docs/writing-markdown.md) ·
[Workspaces](docs/workspaces-and-files.md) ·
[Images](docs/pictures-and-images.md) ·
[Settings](docs/settings.md) ·
[Keyboard shortcuts](docs/keyboard-shortcuts.md)

## Known limitations (rich / WYSIWYG mode)

Rich mode is markdown-first, but a WYSIWYG editor rewrites source the moment
you edit. By design:

- **Viewing never changes a note.** Opening a note in rich mode and switching
  back is byte-identical — nothing is written until you actually edit.
- **Your first edit normalizes syntax spelling** (list markers, emphasis
  characters, blank-line spacing may change). *Content is preserved*; only how
  the markdown is written may differ. A one-time status-bar hint appears when
  entering rich mode on a note this would affect.
- **Mermaid diagrams show as plain code** in rich mode (they still render in
  split/preview). Rendering diagrams inside WYSIWYG is a deliberate non-goal.
- **Undo history does not cross a raw ⇄ rich switch** (industry norm for
  dual-mode markdown editors).

Prefer raw or split mode when you need byte-exact control over markdown
formatting.

## Tech stack

| Layer | Technology |
| --- | --- |
| Shell | [Tauri 2](https://tauri.app) (Rust backend, native WebView) |
| UI | [React 19](https://react.dev) + [TypeScript](https://www.typescriptlang.org) + [Zustand](https://zustand-demo.pmnd.rs) |
| Source editor | [CodeMirror 6](https://codemirror.net) |
| WYSIWYG editor | [Milkdown Crepe](https://milkdown.dev) |
| Markdown pipeline | [unified](https://unifiedjs.com) (remark-gfm → rehype-sanitize) |
| Diagrams | [Mermaid](https://mermaid.js.org) |
| Build / test | [Vite](https://vite.dev) + [Vitest](https://vitest.dev), cargo for the shell |
| Fonts | [Fira Code](https://github.com/tonsky/FiraCode) (default) + 6 more monospace faces and [Inter](https://rsms.me/inter/), all bundled via [@fontsource](https://fontsource.org) (OFL-1.1) |

## Build from source

Prerequisites: Node ≥ 20, Rust (stable, via [rustup](https://rustup.rs)),
plus per-OS Tauri deps — Windows: MSVC Build Tools + WebView2 (in Windows
11); macOS: Xcode CLT; Linux: `libwebkit2gtk-4.1-dev build-essential curl
wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`.

```sh
npm ci
npm run tauri dev      # run the app (vite + cargo, hot reload)
npm run tauri build    # produce installers for your OS
```

Checks: `npm run check && npm test`, and in `src-tauri/`:
`cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`.

## Contributing / architecture

Start with [src/README.md](src/README.md) — it owns the frontend-wide rules.
Each source directory has a README specifying its architecture, contracts,
and invariants.

## Releasing (maintainers)

Versions live in three files that must agree: `package.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`. Bump all three on
`main`, tag `vX.Y.Z`, push the tag — `release.yml` builds every platform
into a **draft** release with the updater manifest (`latest.json`),
minisign `.sig` files, `SHA256SUMS`, and Sigstore attestations. Review the
draft (install at least one asset), then publish; publishing is what makes
`latest.json` visible to auto-updaters.

The updater key ceremony happened once at M7 (2026-07-10): a minisign
keypair was generated offline with `tauri signer generate`; the private
key + password live in the maintainer's password manager and in the repo's
Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`); the public key is embedded in
`tauri.conf.json`. **Losing the private key or its password orphans the
update channel** — every installed copy would refuse updates signed by any
other key, and users would have to reinstall manually. Guard it.

## License

[GPL-3.0-only](LICENSE). Bundled third-party components are listed in
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) (shipped with the app).
All bundled fonts (Fira Code, JetBrains Mono, Cascadia Code, Source Code
Pro, IBM Plex Mono, Inconsolata, Victor Mono, Inter) are © their respective
project authors, SIL Open Font License 1.1.
