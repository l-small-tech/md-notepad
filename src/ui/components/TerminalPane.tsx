/**
 * One terminal pane: a pty, an engine, a canvas view and an input layer, wired
 * together — the leaf of a terminal tab's split tree.
 *
 * This is the only place the four layers meet — `src/ipc` (bytes), `src/term`
 * (state), `src/renderer` (pixels and input) — and it stays deliberately thin:
 *
 *   pty bytes ─► Terminal.write ─► view.requestRender ─► canvas
 *   keystrokes ─► keymap? ─► TermInput.encode ─► pty.write
 *
 * The pty is spawned once, on mount, and lives as long as the element does
 * (which is why `PaneTree` places panes as keyed SIBLINGS — see its header).
 * Everything else — settings, theme, font zoom — is applied to the live
 * objects by a second effect, so changing a setting never restarts a shell.
 * Actions the pane cannot service itself (new tab, palette, splits) go up
 * through `runShortcutAction`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { confirm } from '@tauri-apps/plugin-dialog';
import { terminalProgram } from '../../core/settings';
import type { Settings, TerminalProfile } from '../../core/types';
import { getClipboard } from '../../ipc/clipboard';
import { getPtyProvider, type PtyHandle } from '../../ipc/pty';
import { TermInput, TermView, type TerminalTheme } from '../../renderer';
import { Terminal } from '../../term';
import { runShortcutAction } from '../commands';
import { registerPaneActions, runPaneAction, type PaneAction } from '../pane-actions';
import {
  detectPlatform,
  keyEventToAction,
  type ShortcutAction,
  type TerminalScroll,
} from '../keymap';
import { isExternalHref } from '../../core/external-links';
import { externalLinkStore } from '../stores/external-link';
import { currentFont } from '../terminal-theme';

/** Inset between the pane edge and the first cell, in CSS pixels. */
const PADDING = 8;
/** Font zoom bounds, as steps away from the configured size. */
const MIN_ZOOM = -8;
const MAX_ZOOM = 24;
/** How long the visual bell flashes. */
const BELL_MS = 120;
/**
 * How long the cursor bell holds its shape. Longer than the flash on purpose:
 * a flash is loud enough to register in a frame or two, a change of shape has
 * to sit still long enough to be noticed without being looked for.
 */
const BELL_CURSOR_MS = 400;

const platform = detectPlatform(typeof navigator === 'undefined' ? '' : navigator.platform);

export interface TerminalPaneProps {
  paneId: string;
  profile: TerminalProfile;
  settings: Settings;
  /**
   * The palette to paint with, already resolved for the active theme. Resolved
   * by the app rather than read from the DOM here: the renderer takes numbers,
   * and one pane must never see a different theme than another.
   */
  theme: TerminalTheme;
  /** True when this is the focused pane of the frontmost tab. */
  active: boolean;
  /** Where to start: a restored or inherited working directory. */
  cwd?: string | null;
  onTitle: (title: string) => void;
  onCwd: (cwd: string) => void;
  /** The child exited; the app decides whether the pane closes (settings). */
  onExit: (code: number) => void;
  /** The user interacted with this pane — it should become the focused one. */
  onFocus: () => void;
}

/** True for an element a user may be typing into — never steal its focus. */
function isTextField(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

/** `file://host/path` (OSC 7) → a plain path a pty can be spawned in. */
function pathFromFileUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') {
      return null;
    }
    const pathname = decodeURIComponent(parsed.pathname);
    // `file:///C:/…` parses to pathname `/C:/…` — strip the artificial slash
    // or the value fails later as a spawn cwd on Windows.
    return (/^\/[A-Za-z]:(\/|$)/.test(pathname) ? pathname.slice(1) : pathname) || null;
  } catch {
    return null;
  }
}

export function TerminalPane({
  paneId,
  profile,
  settings,
  theme,
  active,
  cwd,
  onTitle,
  onCwd,
  onExit,
  onFocus,
}: TerminalPaneProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<TermView | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const inputRef = useRef<TermInput | null>(null);
  const handleRef = useRef<PtyHandle | null>(null);

  const [status, setStatus] = useState<string | null>('starting…');
  const [bell, setBell] = useState(false);
  /** Where the right-click menu is, and whether it has a selection to copy. */
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  /** Font zoom, in steps from the configured size. Per pane, not persisted. */
  const [zoom, setZoom] = useState(0);

  // Props the long-lived objects read: kept in a ref so a new callback identity
  // (every render, in practice) never tears down a pty.
  const latest = useRef({ profile, settings, theme, cwd, onTitle, onCwd, onExit, onFocus });
  useEffect(() => {
    latest.current = { profile, settings, theme, cwd, onTitle, onCwd, onExit, onFocus };
  });

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }
    const {
      profile: initialProfile,
      settings: initialSettings,
      theme: initialTheme,
      cwd: initialCwd,
    } = latest.current;

    let disposed = false;
    let bellTimer: ReturnType<typeof setTimeout> | null = null;
    // The view sizes the engine from the element, so the pty is spawned with
    // the grid that is actually on screen — no initial 80×24 redraw.
    const term = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: initialSettings.terminalScrollback,
    });
    const view = new TermView(surface, {
      terminal: term,
      theme: initialTheme,
      font: {
        ...currentFont(initialSettings.terminalFont),
        ...(initialProfile.fontSize ? { size: initialProfile.fontSize } : {}),
      },
      padding: PADDING,
      cursorStyle: initialSettings.terminalCursorStyle,
      cursorBlink: initialSettings.terminalCursorBlink,
      smoothScroll: initialSettings.smoothScrolling,
    });
    // Seed OSC 10/11/12 so an application querying the background color learns
    // the theme's, and gets light/dark detection right.
    view.setTheme(initialTheme);
    termRef.current = term;
    viewRef.current = view;

    const input = new TermInput(surface, {
      terminal: term,
      view,
      write: (data) => void handleRef.current?.write(data),
      // The keymap gets every key first; only what it declines is encoded.
      keymap: (event) => {
        const action = keyEventToAction(event, platform, 'terminal');
        if (!action) {
          return false;
        }
        // Ctrl+C is SIGINT first and copy second: with nothing selected the
        // chord is declined here and encoded for the shell like any other key.
        // The shifted form always copies, so the terminal convention still has
        // an unconditional route.
        if (action.type === 'terminal-copy' && !event.shiftKey && !input.hasSelection) {
          return false;
        }
        runAction(action);
        return true;
      },
      copyOnSelect: initialSettings.terminalCopyOnSelect,
      altSendsEscape: initialSettings.terminalAltSendsEscape,
      backspaceSendsDelete: initialSettings.terminalBackspaceSendsDelete,
      scrollLines: initialSettings.terminalScrollLines,
      confirmPaste: (text) => confirmMultilinePaste(text),
      // The system clipboard, not the web view's — see src/ipc/clipboard.ts.
      clipboard: getClipboard(),
      // Whether Copy is worth offering is decided when the menu opens: the
      // selection cannot change while it is up.
      onContextMenu: (event) =>
        setMenu({ x: event.clientX, y: event.clientY, hasSelection: input.hasSelection }),
    });
    inputRef.current = input;

    async function confirmMultilinePaste(text: string): Promise<boolean> {
      if (!latest.current.settings.terminalConfirmMultilinePaste) {
        return true;
      }
      const lines = text.split('\n').length;
      try {
        return await confirm(
          `Paste ${lines} lines into the terminal? Everything after the first newline runs immediately.`,
          { title: 'Paste', kind: 'warning' },
        );
      } catch {
        // Outside a Tauri webview there is no native dialog; don't block.
        return true;
      }
    }

    /** Actions this pane owns; the rest go up to the app shell. */
    function runAction(action: ShortcutAction): void {
      switch (action.type) {
        case 'terminal-copy':
          // Clearing after a copy is what makes Ctrl+C safe to bind: the next
          // one finds no selection and goes to the shell as SIGINT.
          void input.copySelection().then((copied) => {
            if (copied) {
              input.clearSelection();
            }
          });
          return;
        case 'terminal-paste':
          void input.pasteFromClipboard();
          return;
        case 'terminal-select-all':
          input.selectAll();
          return;
        case 'terminal-clear-scrollback':
          term.clearScrollback();
          view.refresh();
          return;
        case 'terminal-scroll':
          scroll(action.to);
          return;
        // Font zoom is per-pane, not the app-wide editor font size: zooming a
        // shell to read a wide table must not reflow every open note.
        case 'font-inc':
          setZoom((current) => Math.min(MAX_ZOOM, current + 1));
          return;
        case 'font-dec':
          setZoom((current) => Math.max(MIN_ZOOM, current - 1));
          return;
        case 'font-reset':
          setZoom(0);
          return;
        default:
          runShortcutAction(action);
          return;
      }
    }

    function scroll(to: TerminalScroll): void {
      switch (to) {
        case 'lineUp':
          scrollBy(1);
          return;
        case 'lineDown':
          scrollBy(-1);
          return;
        case 'pageUp':
          scrollBy(term.rows - 1);
          return;
        case 'pageDown':
          scrollBy(-(term.rows - 1));
          return;
        case 'top':
          scrollBy(term.scrollbackLength);
          return;
        case 'bottom':
          view.scrollToBottom();
          return;
      }
    }

    function scrollBy(lines: number): void {
      view.scrollLines(lines);
    }

    term.setHandlers({
      title: (value) => latest.current.onTitle(value),
      cursorStyle: (style, blink) => view.setCursorStyle(style, blink),
      cwd: (url) => {
        const path = pathFromFileUrl(url);
        if (path) {
          latest.current.onCwd(path);
        }
      },
      bell: () => {
        const mode = latest.current.settings.terminalBell;
        if (mode === 'off') {
          return;
        }
        if (bellTimer) {
          clearTimeout(bellTimer);
        }
        // Backspace at an empty prompt and completion with nothing left to
        // complete both ring on every keystroke, so the quiet answer is the
        // default: change the cursor's shape, never flash the pane.
        if (mode === 'cursor') {
          view.setBellCursor(true);
          bellTimer = setTimeout(() => view.setBellCursor(false), BELL_CURSOR_MS);
          return;
        }
        // Clear a cursor bell the setting may have interrupted mid-ring.
        view.setBellCursor(false);
        setBell(true);
        bellTimer = setTimeout(() => setBell(false), BELL_MS);
      },
      clipboard: (base64) => {
        // OSC 52 lets *any* program that can write to this terminal set the
        // clipboard, so it stays behind a setting.
        if (!latest.current.settings.terminalAllowOscClipboard) {
          return;
        }
        try {
          const text = new TextDecoder().decode(
            Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
          );
          void getClipboard().write(text);
        } catch {
          // A malformed payload is the application's bug, not ours.
        }
      },
    });
    registerPaneActions(paneId, (action: PaneAction) => runAction(action));
    const offData = term.onData((bytes) => void handleRef.current?.write(bytes));
    const offResize = view.onResize(({ cols, rows }) => {
      void handleRef.current?.resize(cols, rows);
    });

    // The profile's directory wins over the inherited one: a profile that names
    // a project directory means it, wherever the tab was opened from.
    const startCwd = initialProfile.cwd ?? initialCwd;
    // Unset = the platform default, resolved in Rust at spawn time.
    const program = terminalProgram(initialSettings, initialProfile);

    void (async () => {
      try {
        const handle = await getPtyProvider().spawn(
          {
            ...view.gridSize,
            ...(program ? { program } : {}),
            args: initialProfile.args,
            ...(startCwd ? { cwd: startCwd } : {}),
            env: initialProfile.env,
          },
          {
            onData: (bytes) => {
              term.write(bytes);
              view.requestRender();
            },
            onExit: (code) => {
              setStatus(code === 0 ? 'shell exited' : `shell exited (${code})`);
              latest.current.onExit(code);
            },
          },
        );
        if (disposed) {
          void handle.kill();
          return;
        }
        handleRef.current = handle;
        setStatus(null);
      } catch (error) {
        setStatus(`spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();

    return () => {
      disposed = true;
      if (bellTimer) {
        clearTimeout(bellTimer);
      }
      registerPaneActions(paneId, null);
      offResize();
      offData();
      input.dispose();
      view.dispose();
      void handleRef.current?.kill();
      handleRef.current = null;
      inputRef.current = null;
      viewRef.current = null;
      termRef.current = null;
    };
    // `paneId` is fixed for the life of an element (it is the React key), so
    // this effect runs exactly once: one pane, one pty.
  }, [paneId]);

  // Settings, profile, theme and zoom applied to the live objects. Everything
  // here is idempotent, so re-running it on any change is safe — which is what
  // makes a theme switch a repaint rather than a shell restart.
  useEffect(() => {
    const view = viewRef.current;
    const input = inputRef.current;
    const term = termRef.current;
    if (!view || !input || !term) {
      return;
    }
    const font = currentFont(settings.terminalFont);
    view.setFont({ ...font, size: Math.max(1, (profile.fontSize ?? font.size) + zoom) });
    view.setCursorStyle(settings.terminalCursorStyle, settings.terminalCursorBlink);
    view.setSmoothScroll(settings.smoothScrolling);
    view.setTheme(theme);
    term.setScrollbackLimit(settings.terminalScrollback);
    input.configure({
      copyOnSelect: settings.terminalCopyOnSelect,
      altSendsEscape: settings.terminalAltSendsEscape,
      backspaceSendsDelete: settings.terminalBackspaceSendsDelete,
      scrollLines: settings.terminalScrollLines,
    });
  }, [settings, profile, theme, zoom]);

  // Focus follows the store: exactly one pane holds the keyboard, and a pane in
  // a background tab must never take it.
  //
  // Focusing TWICE is deliberate. Activating a tab from the strip happens on
  // `pointerdown`, so this effect runs before the compatibility `mousedown` —
  // whose default action moves focus to the nearest focusable ancestor of the
  // (unfocusable) tab, i.e. off our textarea and onto the body. The pane's own
  // input layer dodges that by preventing the default (see renderer/input.ts);
  // the tab strip cannot, since it must stay a plain click target. So the
  // focus is re-asserted on the next frame, after every default action of the
  // click that activated us has run. The same re-assert covers menus and the
  // palette, which hand focus back when they close.
  useEffect(() => {
    if (!active) {
      return;
    }
    inputRef.current?.focus();
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.focused) {
        return;
      }
      // Never yank focus out of an open text field (App.tsx applies the same
      // rule): a rename input over a terminal tab must get to keep it.
      if (isTextField(document.activeElement)) {
        return;
      }
      input.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  // Ctrl/Cmd-click opens a link; plain clicks belong to the selection.
  const onClick = useCallback((event: React.MouseEvent) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    const link = viewRef.current?.hoveredLink;
    if (!link) {
      return;
    }
    event.preventDefault();
    // Same confirm-then-open path as a markdown link: a URL detected in
    // terminal output is no more trustworthy than one in a document — and an
    // OSC 8 hyperlink can carry any scheme, so only http(s) may reach the OS.
    if (!isExternalHref(link.uri)) {
      return;
    }
    externalLinkStore.getState().request(link.uri);
  }, []);

  const classes = ['term-pane'];
  if (active) {
    classes.push('term-pane-active');
  }
  if (bell) {
    classes.push('term-pane-bell');
  }

  return (
    <div
      className={classes.join(' ')}
      data-pane-id={paneId}
      onClick={onClick}
      // Clicking anywhere in the pane focuses it (and its hidden textarea), so
      // the pane itself never needs to be focusable.
      onPointerDown={() => {
        onFocus();
        inputRef.current?.focus();
      }}
    >
      <div className="term-surface" ref={surfaceRef} />
      {status ? <div className="term-status">{status}</div> : null}
      {/* Outside `.term-surface` on purpose: that element is the input layer's
          host, and a menu inside it would hand every click to the selection. */}
      {menu && (
        <PaneMenu
          menu={menu}
          paneId={paneId}
          onClose={() => setMenu(null)}
          mac={platform === 'mac'}
        />
      )}
    </div>
  );
}

/**
 * The pane's right-click menu, in this app's menu idiom (see TabBar's
 * `TabContextMenu`). Every item runs through the pane's registered action
 * runner rather than a second copy of the switch: "Copy" from the menu, from
 * the palette and from Ctrl+Shift+C have to be one implementation.
 */
function PaneMenu({
  menu,
  paneId,
  onClose,
  mac,
}: {
  menu: { x: number; y: number; hasSelection: boolean };
  paneId: string;
  onClose: () => void;
  mac: boolean;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const chord = (letter: string) => (mac ? `⇧⌘${letter}` : `Ctrl+Shift+${letter}`);

  function run(action: PaneAction) {
    onClose();
    runPaneAction(paneId, action);
  }

  function global(action: ShortcutAction) {
    onClose();
    runShortcutAction(action);
  }

  return (
    <div
      className="tab-menu term-pane-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        className="tab-menu-item"
        role="menuitem"
        disabled={!menu.hasSelection}
        onClick={() => run({ type: 'terminal-copy' })}
      >
        Copy<span className="tab-menu-chord">{chord('C')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => run({ type: 'terminal-paste' })}
      >
        Paste<span className="tab-menu-chord">{chord('V')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => run({ type: 'terminal-select-all' })}
      >
        Select all<span className="tab-menu-chord">{chord('A')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => run({ type: 'terminal-clear-scrollback' })}
      >
        Clear scrollback<span className="tab-menu-chord">{chord('K')}</span>
      </button>
      <div className="tab-menu-sep" role="separator" />
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => global({ type: 'terminal-split', direction: 'right' })}
      >
        Split right<span className="tab-menu-chord">{chord('D')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => global({ type: 'terminal-split', direction: 'down' })}
      >
        Split down<span className="tab-menu-chord">{chord('E')}</span>
      </button>
      <button
        className="tab-menu-item"
        role="menuitem"
        onClick={() => global({ type: 'terminal-close-pane' })}
      >
        Close pane<span className="tab-menu-chord">{chord('X')}</span>
      </button>
    </div>
  );
}
