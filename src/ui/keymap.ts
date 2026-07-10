/**
 * The single keyboard-shortcut registry (src/ui/README "Keyboard shortcuts").
 *
 * `keyEventToAction` is a PURE decision function — it maps a keyboard event
 * (or any structurally-compatible descriptor) plus the platform to an action,
 * or `null` when the app should not intercept the key. Keeping it pure is
 * what lets the shortcut table be unit-tested without a DOM; `src/main.tsx`
 * installs the one real `keydown` listener that calls this and dispatches
 * into store actions.
 *
 * `mod` = Cmd on macOS, Ctrl elsewhere. Shortcuts not in the M1 table return
 * `null` so the event falls through — notably mod+F, which CM6's own search
 * keymap handles while the editor is focused.
 */

import type { EditorMode } from '../core/types';

export type Platform = 'mac' | 'other';

export type ShortcutAction =
  | { type: 'new-tab' }
  | { type: 'close-tab' }
  | { type: 'next-tab' }
  | { type: 'prev-tab' }
  | { type: 'rename-tab' }
  | { type: 'set-mode'; mode: EditorMode }
  | { type: 'open-file' }
  | { type: 'save' }
  | { type: 'save-as' }
  | { type: 'open-settings' }
  | { type: 'font-inc' }
  | { type: 'font-dec' }
  | { type: 'font-reset' }
  | { type: 'toggle-fullscreen' };

/** The subset of KeyboardEvent this function reads (so tests need no DOM). */
export interface KeyDescriptor {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function detectPlatform(platformString: string): Platform {
  return /mac|iphone|ipad|ipod/i.test(platformString) ? 'mac' : 'other';
}

export function keyEventToAction(e: KeyDescriptor, platform: Platform): ShortcutAction | null {
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
  // The "wrong" primary modifier for the platform must not also fire the
  // shortcut (Ctrl+N on macOS is not new-tab).
  const wrongMod = platform === 'mac' ? e.ctrlKey : e.metaKey;

  // F2 rename is unmodified and platform-independent.
  if (e.key === 'F2' && !mod && !e.altKey) {
    return { type: 'rename-tab' };
  }

  // Full screen: F11 is the unmodified convention on Windows/Linux (and works
  // on external mac keyboards too); Ctrl+Cmd+F is the macOS-native chord. Both
  // must be matched before the mod/wrongMod guard — on mac the chord holds
  // Ctrl AND Cmd, which that guard would reject as a "wrong modifier".
  if (e.key === 'F11' && !mod && !e.altKey && !e.shiftKey) {
    return { type: 'toggle-fullscreen' };
  }
  if (
    platform === 'mac' &&
    e.metaKey &&
    e.ctrlKey &&
    !e.altKey &&
    !e.shiftKey &&
    e.key.toLowerCase() === 'f'
  ) {
    return { type: 'toggle-fullscreen' };
  }

  if (!mod || wrongMod || e.altKey) {
    return null;
  }

  // Ctrl/Cmd+Tab cycles tabs (Shift reverses). `key` is 'Tab'.
  if (e.key === 'Tab') {
    return e.shiftKey ? { type: 'prev-tab' } : { type: 'next-tab' };
  }

  // mod+S / mod+Shift+S (save / save as) are the only M1+ Shift-combos.
  if (e.key.toLowerCase() === 's') {
    return e.shiftKey ? { type: 'save-as' } : { type: 'save' };
  }

  // Font size (mod += / - / 0). "mod+=" often arrives as '+' (Shift held on a
  // US layout), and "mod+-" as '_', so these must be checked BEFORE the
  // no-Shift guard below and tolerate either form.
  if (e.key === '=' || e.key === '+') {
    return { type: 'font-inc' };
  }
  if (e.key === '-' || e.key === '_') {
    return { type: 'font-dec' };
  }
  if (e.key === '0') {
    return { type: 'font-reset' };
  }

  // The remaining shortcuts are not Shift-combos.
  if (e.shiftKey) {
    return null;
  }

  switch (e.key.toLowerCase()) {
    case 'n':
      return { type: 'new-tab' };
    case 'w':
      return { type: 'close-tab' };
    case 'o':
      return { type: 'open-file' };
    case ',':
      return { type: 'open-settings' };
    case '1':
      return { type: 'set-mode', mode: 'raw' satisfies EditorMode };
    case '2':
      return { type: 'set-mode', mode: 'split' satisfies EditorMode };
    case '3':
      return { type: 'set-mode', mode: 'wysiwyg' satisfies EditorMode };
    case '4':
      return { type: 'set-mode', mode: 'read' satisfies EditorMode };
    default:
      return null;
  }
}
