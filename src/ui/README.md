# src/ui/ — React chrome

React renders the frame around the editors — never the editors themselves.
Keep this directory small; anything smart belongs in a store or in core.

## Component inventory

| Component | Milestone | Notes |
| --- | --- | --- |
| `App` | M1 | layout shell: TabBar / EditorHost / StatusBar stack |
| `TabBar` | M1 | tabs + new-tab button; middle-click close; F2/double-click inline rename; dirty dot for file tabs (M3); drag-out tear-off + "Move to new window" (M8); workspace color cues (a tab wears its workspace's accent; `groupTabsByWorkspace` optionally keeps each workspace's tabs contiguous — rules in core/tab-workspaces.ts, resolution in ui/workspace-cues.ts); phone widths (≤640px) show only the active tab full-width + a count-pill switcher |
| `EditorHost` | M1 | THE critical component — see below |
| `StatusBar` | M1 | mode segment control, cursor pos, word count; notice area (hints, flush errors) |
| `ConflictBanner` | M3 | per-tab "File changed on disk — Reload / Keep mine" |
| `ExternalLinkPrompt` | reference | the confirm bar for a clicked `http(s)` link (non-modal, bottom centre) — see "Link policy" below |
| `SettingsDialog` | M6 | plain form over the settings store |
| `ExternalLinkPrompt` | reference | the "open this in your browser?" bar for a clicked external link — non-modal, self-dismissing |
| `UpdateChip` | M7 | unobtrusive "Update available → restart" affordance |
| `TerminalTab` | M9 | one terminal tab page: hosts its split tree — see I10 below |
| `TerminalPane` | M9 | one pty + engine + canvas + input; the only place src/term and src/renderer meet the app |
| `PaneTree` | M9 | places a tab's panes as keyed, absolutely-positioned SIBLINGS (nesting them would remount — and kill — a pty on every split) |

## EditorHost — the never-remount rule (I7)

One `EditorHost` per OPEN tab, all mounted simultaneously; the inactive
ones are hidden with `display: none` — **not** unmounted. Switching tabs
must not re-create editors (state, undo history, scroll all live in the
editor instances).

```tsx
function EditorHost({ tab }: { tab: TabState }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // runs ONCE per tab lifetime — createModeSync attaches the initial editor
    const sync = createModeSync({
      model: tab.model, host: hostRef.current!, initialMode: tab.mode,
      adapters: { source: cm6Factory, wysiwyg: wysiwygFactory },
      onError: reportEditorError,
    });
    tabsStore.getState().registerModeSync(tab.id, sync);
    return () => { void sync.dispose(); };
  }, [tab.id]); // tab.id only — NEVER add deps that change during the tab's life
  return <div ref={hostRef} className="editor-host" />;
}
```

Rules:

- The effect dependency list is `[tab.id]` and stays that way. Mode changes
  go through `modeSync.setMode(...)` via a store action, not through props
  that would re-run the effect.
- `React.memo` the component; the parent renders `<EditorHost key={tab.id}>`
  so reconciliation is keyed by tab identity.
- No `<StrictMode>` in main.tsx (decision log): its dev double-effect would
  attach/dispose/attach every editor. If StrictMode is ever reintroduced,
  EditorHost must first become idempotent under double-mount — do not flip
  one without the other.
- Split mode: EditorHost renders the editor div plus (when
  `tab.mode === 'split'`) a divider and the preview pane div side by side.
  The editor div itself is the SAME node in raw and split — toggling only
  shows/hides the preview column (I7 corollary: mode-sync reuses the
  attached editor). The preview pane is NOT an editor — it's a second effect
  (keyed `[tabId, mode]`, separate from the `[tabId]`-only editor effect)
  that calls `attachPreviewPane` (src/preview/README.md) on entering split
  and disposes it on the way out; I7 governs the source editor only.
- Split divider: a ~15-line pointer-drag handler in EditorHost (no
  dependency) sets the editor pane's `flex-basis` directly via
  `style.flex`, bypassing React state so dragging never re-renders. The
  ratio lives in a module-level variable shared by every tab, so it survives
  tab switches for the session (not persisted to the manifest).

## Tab strip: shrink, then scroll (M9)

Every tab renders at `--tab-width` (its ideal size, not its title's — a
widened window would otherwise leave the new room empty) and shrinks like a
browser's down to `--tab-min-width`, then the strip scrolls; the `›N` button
appears only while something is actually clipped and lists exactly the clipped
tabs (with a per-row close, since a clipped tab has no × on screen).
Activating a tab scrolls it into view — from the keyboard or from that menu,
landing on a tab you cannot see is useless.

Whole tabs only, justified: when the strip overflows, the fitted whole tabs
stretch to share the sub-tab remainder (`wholeTabsFit` in the same module
gives the count; `--tab-justify-width` overrides the tab min/max), so the
right edge never slices a tab AND the strip ends flush against the ›N / "+ ⌄"
group instead of leaving a gap before the window controls.
`scroll-snap-align` keeps the left edge on a tab start once it scrolls. The
fit comes from tab widths rather than live positions, so it does not move as
the strip scrolls.

What is clipped is **measured**, not computed from a width budget: the tabs
are elastic, so the answer has to survive a resize, a renamed title, a
collapsed group and a scroll alike. The rule itself is pure and tested
(`clippedTabIds` in `src/ui/tab-overflow.ts`); the component keeps only the
`ResizeObserver` wiring. Two consequences worth knowing:

- The phone layout is now plain CSS (`.tab:not(.tab-active) { display: none }`
  below 640px). Hidden tabs measure as zero-width, which the rule already
  counts as clipped — so the count pill lists exactly them with no phone
  branch in the measurement.
- A clipped group CHIP takes its whole run into the overflow list: a run you
  can only see the tail of is not a group you can read.

Right-clicking the strip's FREE space opens nothing (the default webview menu
is suppressed) — the app menu lives solely in the "+ ⌄" picker
(`components/AppMenu.tsx`). "Close all tabs" remains reachable from a tab's
context menu and the command palette.

Right-clicking a TAB opens that tab's own menu (`TabContextMenu`) — what acts
on this document: **Export…** and **Copy all raw text** (only for a tab holding
markdown — not a terminal, image, import card or `.svg` drawing), then Keep
open / Rename / Move to new window / Close / Close all. Both document rows name
the right-clicked tab's id explicitly, because right-clicking a tab
deliberately does not activate it (`ui/tab-actions.ts`, and
`openExportPreview(tabId?)`). The split is the rule: app commands in the
picker, per-document ones on the tab.

The free space after the last tab keeps `data-tauri-drag-region` but no
reserved floor — a full row of tabs runs right up to the window controls. The
drag drop-indicator is scroller-relative and must add `scroller.scrollLeft`.

### The "+ ⌄" button pair

The two live in one floating pill after the last tab (Windows Terminal
style). A plain click on + makes **another one of whatever is in front** —
`defaultNewTabChoice` in `core/new-tab.ts` (pure, tested): terminal → terminal,
`.svg` → drawing, everything else → note. The ⌄ button — or alt-click,
right-click, long-press or mod+Shift+N — opens the type picker instead, which
lists every type explicitly — note, one row per terminal profile (shell icon,
no heading of its own: a shell is one more thing "+" makes), then the drawing —
so the inference is never the only route. mod+N follows the
same rule — the binding has always been labelled "New tab", not "New note".

Under the tab kinds the picker carries the app rows — **Themes** (drilling
into the same `ThemesMenuPage`), **Settings**, and the two full-screen stages
— and both they and the kind rows come from `components/AppMenu.tsx`
(`AppActionRows`, `NewTabRows`), which is also what the bar menu renders, so
the two cannot drift. The pill is the one menu affordance that stays visible
however full the strip gets, which is why the chrome actions live there and
not only behind the bar's right-click.

Every tab leads with a kind icon (terminal / markdown / drawing / image /
import — `tabIconKind` in TabBar) so the strip reads apart at a glance; a
terminal's agent-status badge sits after the icon, not instead of it.

### Where a new terminal starts

`terminal-open.ts` gives every new terminal tab the **selected workspace's
directory** as its cwd: `uiStore.selectedExplorerDir` (the last folder row
clicked, or workspace explicitly set active via double-click or the header's
right-click "Set active"), falling back to the default notes-dir
workspace, and to the app's own cwd for a synced (`saf://`) selection. It does
not inherit from the tab in front. A profile's own `cwd` still wins
(`TerminalPane`), and splitting a pane still inherits that pane's cwd.

### Which shell a terminal runs, and in which typeface

One global choice each, both in the Settings dialog's Terminal section — the
app stays a notepad with a terminal in it, not a terminal emulator with
per-profile launch configs.

- **Shell** (`settings.terminalShell`) — a program name resolved against
  `PATH`, an absolute path, or empty for the platform default that
  `src-tauri/src/shell.rs` picks (PowerShell 7 / zsh / bash). The picker lists
  the usual shells for `desktopOs()` plus "Custom…"; `core/terminal-shells.ts`
  owns those lists. `core/settings.ts`'s `terminalProgram` folds the setting
  into a profile at spawn time, so a profile that names its OWN `program`
  still wins. It applies to shells started from
  now on — a running pty is never restarted by a settings change.
- **Font** (`settings.terminalFont`) — defaults to Fira Code rather than
  following the editor font, because box-drawing and column alignment are not
  what a prose typeface is chosen for; `'match'` opts back in. Only the
  FAMILY is separate: the size still follows `--editor-font-size`, so mod+=/-/0
  keeps driving terminal cells.

## TerminalTab — the keep-your-box rule (I10)

The opposite of I7's `display: none`, for the opposite reason. A terminal
page is hidden with `visibility: hidden` (plus `pointer-events: none`) and
is **never** unmounted while its tab exists.

`display: none` would measure the pane at 0×0; its `ResizeObserver` would
resize the pty to 1×1; and every TUI running in it would redraw into a
corner — which the user sees the instant they switch back. A hidden CM6
must not lay out, a hidden terminal must. Both call sites carry a comment
pointing at the other; keep them that way.

The chrome is HIDDEN on a terminal tab: `Ribbon`, `FileExplorer`,
`OutlinePanel` and `StatusBar` are not rendered at all (they read editor
state a terminal has none of), while the `TabBar` stays — it is the window
titlebar. The explorer/outline open-closed flags in `uiStore` are left
untouched, so switching back to a document restores exactly what was there.

## Multi-window (M8 tab tear-off)

Releasing a tab drag outside the window (or right-click → "Move to new
window") moves the tab into its own OS window. The model:

- **Every window is the full app** — same `main.tsx` boot, own JS context,
  own stores, own session controller. The window label decides the role:
  `main` vs `w-<nanoid>` (torn-off).
- **One manifest per window, in the one session dir**: `session.json` for
  main, `session-<label>.json` for secondaries. `buffers/` is shared (tab
  ids are global nanoids). Note-slug collisions across windows are guarded
  by re-listing the notes dir at the start of every flush.
- **Handoff is disk-first**: the source window flushes the tab, detaches it
  (`detachTab` — no delete tombstones), flushes its manifest again, and only
  THEN spawns the window, passing a one-tab manifest in the `?adopt=` URL
  param. A crash mid-handoff can therefore never restore the tab in two
  windows; worst case it's in neither manifest but its files are on disk.
- **Session restore covers windows**: at boot, main lists
  `session-*.json` (a dedicated Rust command) and re-spawns each window;
  the window-state plugin restores per-label geometry.
- **Closing a torn-off window hands its tabs back to main** over the
  `adopt-tabs`/`adopt-ack-<label>` event pair (its manifest is deleted only
  after main acks; no ack → the manifest stays and the window returns next
  boot). Closing MAIN quits the app: it broadcasts `main-closing`, waits for
  the secondaries to flush + close, then sweeps stragglers.
- **Cross-window invariants**: the controller's `adoptTabs` skips files a
  local tab already owns (one owner per file, applied across windows);
  file-open entry points (argv, `open-files`) target main only; the
  notes-dir change flow is main-only; settings changes broadcast via a
  `settings-changed` event so theme/fonts stay uniform — except a theme a
  window pinned to itself (`stores/window-theme`), which neither leaves nor
  accepts the broadcast.
- **Platform gating**: on Linux (Wayland offers no global cursor position or
  app-side window placement) the drag-out release is judged in client
  coordinates and the new window is spawned unpositioned — the compositor
  places it. Android is single-window; there only in-strip reorder exists.
  The context-menu item works everywhere.

## Keyboard shortcuts (single registry)

One `keydown` listener installed at bootstrap, dispatching store actions —
components do not bind their own global keys. `mod` = Cmd on macOS, Ctrl
elsewhere (`navigator.platform`-based helper).

| Keys | Action | Milestone |
| --- | --- | --- |
| mod+N | new tab, of the type in front (`core/new-tab.ts`) | M1/M9 |
| mod+Shift+N | new-tab type picker (note / drawing / terminal) | M9 |
| mod+W | close tab (confirm per semantics) | M1/M2 |
| mod+Tab / mod+Shift+Tab | next / previous tab | M1 |
| F2 | rename tab | M1 |
| mod+F | editor search panel | M1 (CM6 handles it when focused) |
| mod+1 / mod+2 / mod+3 | raw / split / wysiwyg | M1 (targets exist M4/M5) |
| mod+O | open file | M3 |
| mod+S / mod+Shift+S | save / save as | M3 |
| mod+, | settings | M6 |
| mod+= / mod+- / mod+0 | font size up / down / reset | M6 |

Don't intercept keys CM6 needs while the editor is focused unless the
shortcut is in this table (the listener checks `defaultPrevented` and
event target).

### Terminal tabs

A focused shell owns almost every key, so `keyEventToAction` takes a
CONTEXT. In `'terminal'` it answers for a short allowlist and returns
`null` for everything else, which is then encoded and sent to the child —
mod+S is XOFF, mod+O and mod+U are readline, mod+1..4 mean whatever the
running program says. `TerminalPane` asks the keymap first and calls
`preventDefault()` only on what it handles; the global listener's
`defaultPrevented` guard keeps the two from both firing.

| Keys | Action |
| --- | --- |
| mod+Shift+C / mod+Shift+V | copy / paste |
| mod+C | copy **only when something is selected** — otherwise it encodes as SIGINT |
| mod+Shift+A | select all |
| mod+Shift+K | clear scrollback |
| mod+Shift+D / mod+Shift+E | split right / split down |
| mod+Shift+X | close pane (the last one closes the tab) |
| mod+Shift+[ / mod+Shift+] | previous / next pane |
| Shift+PgUp / Shift+PgDn | scrollback by a page |
| mod+Shift+↑ / ↓ | scrollback by a line |
| mod+Shift+Home / End | scrollback to top / bottom |
| mod+= / mod+- / mod+0 | zoom THIS pane only (not the app-wide editor font) |

Still available from a terminal: new/close tab, next/prev tab, rename tab,
settings, palette, full screen. Nothing else.

## UI conventions

- Notices (flush errors, normalization hint, "note file missing") go to the
  StatusBar notice area — auto-dismiss after ~6s, never modal.
- The webview must NEVER navigate. `link-guard.ts` (installed once from
  main.tsx) cancels every anchor click the surface that rendered it did not
  already claim — an `http(s)` link that gets through replaces the whole app
  with a chrome-less remote page and there is no way back. External links go
  through `stores/external-link.ts` → `ExternalLinkPrompt` → the OS browser;
  the confirmation step exists because a markdown link's real destination is
  invisible until it is clicked. TerminalPane's detected link clicks take the
  same route.

### Link policy (app-wide)

The webview must NEVER navigate. A remote page loaded into the window replaces
the entire app with something that has no chrome, no Back and no way out — a
soft lock. `link-guard.ts` installs one delegated `click`/`auxclick` listener on
`document` (from main.tsx, for the window's lifetime) that prevents the default
on EVERY anchor, and hands `http(s)` ones to `stores/external-link`:

- Clicks a surface already handled (`defaultPrevented`) are skipped — the
  preview pane runs its own richer handler and prevents the default itself.
- The wysiwyg (ProseMirror) document is the case the guard exists for: its
  anchors belong to no handler, so without it a click navigates the window.
- Nothing opens without confirmation. `ExternalLinkPrompt` names the host the
  URL really resolves to (userinfo stripped — `https://github.com@evil.example`
  reaches `evil.example`) and warns before "Open in browser" reaches
  `openUrl`. Esc or ~15s of no answer dismisses it.
- Ctrl/Cmd-clicking a URL detected in terminal output takes the same path.

### Context-menu policy (app-wide)

The webview's own menu (Back / Reload / Inspect Element) must never appear over
app chrome — the window is undecorated and meant to read as a native app, so a
devtools menu on the minimize button is a leak, not a feature.
`context-menu-guard.ts` installs one delegated `contextmenu` listener on
`document` (from main.tsx, alongside the link guard, for the window's lifetime)
that prevents the default everywhere except:

- targets a surface already claimed (`defaultPrevented`) — FileExplorer,
  TabBar, Ribbon and TerminalPane open their own menus and cancel it themselves;
- text entry (`input`, `textarea`, `contenteditable` — CodeMirror and milkdown
  are the latter), where the native menu is the editors' only right-click
  copy/paste.

Per-component swallows (StatusBar, Ribbon) predate the guard and are now
belt-and-braces; a new surface needs no guard of its own unless it has a menu.

- Modals are reserved for: close-tab confirmation, save/discard/cancel on
  dirty file close, settings. Use `@tauri-apps/plugin-dialog` for native
  confirm dialogs (they match the OS), custom DOM only for SettingsDialog.
- The window title mirrors the active tab: `<title> — MD Notepad`
  (`getCurrentWindow().setTitle`), updated from a store subscription.
- Drag-reorder of tabs: pointer-events implementation, no dnd library
  (dependency freeze), and NOT HTML5 drag-and-drop — Tauri's OS drag-drop
  interception swallows webview-internal HTML5 drags on Windows (same
  constraint as the FileExplorer's useFileDrag). The drag also handles
  group membership (drop inside a run joins, boundaries leave, chip
  appends) and hands releases outside the window to the M8 tear-off.

## Settings (M6)

- Persisted via `tauri-plugin-store` (`settings.json` in appDataDir), wrapped
  in `src/ipc/settings-store.ts` (the only place the store plugin is touched).
  `main.tsx` loads + `normalizeSettings` BEFORE resolving paths/mounting, then
  arms a debounced write-through subscription (so the initial load doesn't echo
  a save). A corrupt/missing store degrades to defaults — never a crash.
- `SettingsDialog` writes every field straight through `settingsStore.update`,
  so changes apply immediately: theme/ligatures/font size via the DOM
  subscription (`applyDomSettings`), word wrap via EditorHost reconfiguring the
  live CM6 adapter, default mode on the NEXT new tab.
- Theme picking has two surfaces — the "+ ⌄" picker (or the tab bar's own
  menu) → **Themes** (the theme
  list plus Open folder / New theme… / Reload / Help) and the Settings **Theme**
  dropdown. Both go through `ui/theme-actions.ts` (side effects) and
  `stores/theme-registry`'s `currentThemeValue` / `themeSelectionPatch` (the
  pure "which entry is current / what does this choice mean" pair, unit-tested),
  so the two can't drift.
- **Window-only theme** (right-click in the Themes list, or the Settings box): the
  pinned theme still lives in the settings store — every consumer reads the
  theme from there — and `stores/window-theme` instead guards the two edges
  where settings cross the window boundary. `sharedSettings` swaps the shared
  theme back in before `main.tsx` saves/broadcasts; `mergeIncomingSettings`
  takes a sibling's settings minus the theme, which is also what stops the echo
  of our own broadcast from undoing the pin. Not persisted — it lasts as long
  as the window.
- **Smooth scrolling** is the ENGINE's, on purpose — do not reintroduce a JS
  scroll animation. One was built (a window-level wheel listener springing
  `scrollTop` per rAF) and removed: it ran on the main thread, so every frame
  fought CM6's viewport re-render and the result was jitter no spring tuning
  could fix, while `preventDefault` suppressed the engine's own
  compositor-thread animation that does this properly. Now DOM surfaces scroll
  natively everywhere, and the setting means: on Linux, `main.tsx` flips
  WebKitGTK's `enable-smooth-scrolling` via `ipc.setSmoothScrolling`
  (`src-tauri/src/commands/webview.rs`); on Windows, WebView2 (Chromium)
  already animates wheel scrolls and there is nothing to flip; on macOS,
  wheels step and trackpads carry OS momentum. The terminal is the exception
  that still animates — a canvas has no native scrolling — with the spring in
  `core/smooth-scroll.ts` (renderer/README), gated by the same setting.
- **Font size is CSS-variable driven** (`--editor-font-size`): CM6, preview,
  and wysiwyg all read it, so `mod+=/-/0` and the dialog just update the setting
  — no per-editor plumbing. Word wrap is the one setting that needs an editor
  hook (CM6's `setWordWrap`), applied without re-mounting (I7).
- Notes-dir change: the flow lives on the session controller
  (`changeNotesDir`) — folder picker → optional move of existing notes (pure
  set from `core/notes-move.ts`) → repoint the live `notesDir` so the next
  flush writes there. Moved notes' tabs are retargeted via `applyFlushResult`;
  files that can't move are left behind and reported in a status-bar notice.

## Testing expectations

Stores (`stores/*.ts`) get full Vitest coverage — tab lifecycle, rename
override, close bookkeeping (`closedNotePaths` tombstones), shortcut
dispatch decisions (pure `keyEventToAction(e, platform)` helper). JSX stays
declarative and thin.
