# MD Notepad

A minimal, fast, cross-platform **markdown notepad** in the spirit of
Windows 11 Notepad: tabs you never have to save, that are simply *there*
again when you come back.

## Why

Notepad's ephemeral tabs are perfect for half-formed thoughts — open a tab,
type, close the app. MD Notepad keeps that feel and adds what markdown
people want: GitHub-Flavored Markdown, Mermaid diagrams, three edit modes,
and Fira Code with ligatures (`->` really is one glyph).

## Features (v1 target)

- **Notepad-style tabs** — unsaved notes persist across restarts, kill the
  app any time and lose at most ~5 seconds of typing.
- **Notes are plain `.md` files** in a folder you choose
  (default: your platform's app-data dir → `md-notepad/notes`); open and
  save regular files anywhere, too.
- **Three modes per tab** — raw source (CodeMirror 6), split source+preview,
  and WYSIWYG (Milkdown).
- **Full GFM** preview — tables, task lists, strikethrough, autolinks — plus
  **Mermaid** diagrams.
- **Monospace everywhere**, bundled Fira Code, ligatures on by default.
- Light/dark/system themes. Small, quiet, fast.

## Install

Prebuilt installers land on the
[Releases](../../releases) page from v0.1.0: Windows (NSIS `.exe`), macOS
(universal `.dmg`), Linux (`.deb`, `.rpm`, `.AppImage`).

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
against the minisign public key embedded in the app before it is applied;
your open tabs are flushed to disk before the restart, so updating never
costs typed text. The update check is silent on failure and never blocks
startup — if you're offline, nothing happens.

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

Start with [plan.md](plan.md) — it is the map of the whole project
(architecture, invariants, milestones, decision log). Each source directory
has a README specifying its contracts.

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
Bundled Fira Code font is © The Fira Code Project
Authors, SIL Open Font License 1.1.
