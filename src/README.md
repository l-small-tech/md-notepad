# src/ — Frontend architecture

This README owns the rules that apply to ALL frontend code; each
subdirectory README owns its own contracts.

## Layering (invariant I9 — lint-enforced)

```
ui  ──▶  editors / preview / ipc / core     (ui may import everything)
editors / preview  ──▶  core, ipc           (never ui, never each other)
ipc  ──▶  @tauri-apps/* only                (never core/editors/preview/ui)
core ──▶  NOTHING app-local, no DOM, no Tauri, no React
```

- `core/` — pure logic. The `no-restricted-imports` rule in
  `eslint.config.js` rejects Tauri/React imports there; keep the rule in
  sync if paths change.
- `ipc/` — the only place `invoke()` and `@tauri-apps/api/*` calls live.
  UI code calls `ipc.*` wrappers, never `invoke` directly.
- Type-only imports across layers are allowed downward only (an editor may
  import a core type; core imports no editor types).

## Store conventions (Zustand)

- Stores are **vanilla** (`createStore` from `zustand/vanilla`), defined in
  `src/ui/stores/`, one file per store, and exported twice:

  ```ts
  export const tabsStore = createStore<TabsState>()((set, get) => ({ ... }));
  export const useTabsStore = <T>(selector: (s: TabsState) => T): T =>
    useStore(tabsStore, selector);
  ```

  Non-React code (session flusher, adapters) subscribes to `tabsStore`
  directly; components use the hook with selectors (never select the whole
  state — that re-renders on every change).
- Actions are defined inside the store; components never `setState` from
  outside an action.
- Per-tab non-serializable objects (`DocModel`, `ModeSync`) live in the tab
  entry but are excluded from anything persisted (`planFlush` receives a
  serializable view, never the store objects).

## Event flow (one keystroke)

```
CM6 update → adapter.pushText(model) → model notifies subscribers
  ├─ tabs store: recompute title (deriveTitle) if no customTitle
  ├─ flusher.request()                     (debounced session persist)
  └─ preview controller (split mode): debounced re-render
```

Window-level events (`open-files`, focus, close-requested) are subscribed
once in `src/main.tsx` bootstrap and dispatched into store actions —
components never add window-level listeners themselves.

## Startup sequence (M2+)

1. Load settings (plugin-store → `normalizeSettings`) → apply theme.
2. Resolve `notesDir`/`sessionDir` (`src/ipc/paths.ts`).
3. Restore session (see core/README — restore flow), or self-heal.
4. `ipc.drainStartupFiles()` + subscribe `open-files` → open file tabs.
5. Mount React. Until step 5 the window shows nothing but background color —
   keep steps 1–4 under ~150ms (they are a handful of small IPC calls).

## Styling

- Plain CSS files imported from components; CSS variables from
  `styles/base.css` only — components never hardcode colors.
- Both themes are defined as variable sets on `:root`; theme switching is
  `data-theme` on `<html>`, nothing else re-renders.
- Content is always monospace: `var(--font-mono)`, whose stack main.tsx
  swaps per the "Editor font" setting (bundled OFL faces, core/fonts.ts).
  UI chrome uses `var(--font-ui)`, which defaults to following
  `--font-mono` (monospace everywhere IS the aesthetic) but can be pointed
  at a sans stack by the "Interface font" setting. Editor/preview/wysiwyg
  surfaces must reference `--font-mono` explicitly, never inherit from
  body.

## Testing expectations

Every store and every pure module gets a Vitest suite in a sibling
`__tests__/`. Component rendering is not unit-tested (no react-testing-lib
dependency); component LOGIC that grows beyond trivial must be extracted to
a store/pure function and tested there.
