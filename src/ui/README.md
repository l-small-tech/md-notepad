# src/ui/ — React chrome

React renders the frame around the editors — never the editors themselves.
Keep this directory small; anything smart belongs in a store or in core.

## Component inventory

| Component | Milestone | Notes |
| --- | --- | --- |
| `App` | M1 | layout shell: TabBar / EditorHost / StatusBar stack |
| `TabBar` | M1 | tabs + new-tab button; middle-click close; F2/double-click inline rename; dirty dot for file tabs (M3); drag-out tear-off + "Move to new window" (M8) |
| `EditorHost` | M1 | THE critical component — see below |
| `StatusBar` | M1 | mode segment control, cursor pos, word count; notice area (hints, flush errors) |
| `ConflictBanner` | M3 | per-tab "File changed on disk — Reload / Keep mine" |
| `SettingsDialog` | M6 | plain form over the settings store |
| `UpdateChip` | M7 | unobtrusive "Update available → restart" affordance |

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
  `settings-changed` event so theme/fonts stay uniform.
- **Platform gating**: the drag-out gesture is disabled on Linux (Wayland
  offers no reliable global cursor position); the context-menu item works
  everywhere.

## Keyboard shortcuts (single registry)

One `keydown` listener installed at bootstrap, dispatching store actions —
components do not bind their own global keys. `mod` = Cmd on macOS, Ctrl
elsewhere (`navigator.platform`-based helper).

| Keys | Action | Milestone |
| --- | --- | --- |
| mod+N | new note tab | M1 |
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

## UI conventions

- Notices (flush errors, normalization hint, "note file missing") go to the
  StatusBar notice area — auto-dismiss after ~6s, never modal.
- Modals are reserved for: close-tab confirmation, save/discard/cancel on
  dirty file close, settings. Use `@tauri-apps/plugin-dialog` for native
  confirm dialogs (they match the OS), custom DOM only for SettingsDialog.
- The window title mirrors the active tab: `<title> — MD Notepad`
  (`getCurrentWindow().setTitle`), updated from a store subscription.
- Drag-reorder of tabs: pointer-events implementation (~40 lines), no
  dnd library (dependency freeze).

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
- Theme picking has two surfaces — the ribbon's ☰ menu → **Themes** (the theme
  list plus Open folder / New theme… / Reload / Help) and the Settings **Theme**
  dropdown. Both go through `ui/theme-actions.ts` (side effects) and
  `stores/theme-registry`'s `currentThemeValue` / `themeSelectionPatch` (the
  pure "which entry is current / what does this choice mean" pair, unit-tested),
  so the two can't drift.
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
