/**
 * The system clipboard, as a seam — the same shape as the app's other IPC
 * seams: an interface, a memory implementation for tests and browser dev, and
 * a real one that degrades instead of throwing.
 *
 * Why this exists at all, when the web platform has a clipboard: the web view's
 * clipboard is not the system's. WebKitGTK (every Linux build) gates
 * `navigator.clipboard.readText()` behind a permission a packaged app has no way
 * to grant itself, so a paste from a menu or a shortcut silently resolves to the
 * empty string — the "paste does nothing" bug. The Tauri clipboard plugin talks
 * to the real clipboard through the OS, with no permission prompt and no user
 * gesture requirement.
 *
 * `navigator.clipboard` stays as the fallback: it is what `pnpm dev` in a
 * browser has, and it is what answers if the plugin is ever missing from a
 * build. Both are wrapped so a rejection reads as "nothing on the clipboard"
 * rather than as an exception in the middle of a keystroke.
 */

import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

export interface ClipboardProvider {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

/** In-memory clipboard: the test double. */
export function createMemoryClipboard(seed = ''): ClipboardProvider {
  let text = seed;
  return {
    read: () => Promise.resolve(text),
    write: (value) => {
      text = value;
      return Promise.resolve();
    },
  };
}

/** The web view's own clipboard — the fallback, and all `pnpm dev` has. */
export function createDomClipboard(): ClipboardProvider {
  return {
    read: async () => (await navigator.clipboard?.readText()) ?? '',
    write: async (text) => {
      await navigator.clipboard?.writeText(text);
    },
  };
}

/**
 * The real clipboard: the plugin first, the web view second. An empty clipboard
 * throws on some platforms rather than returning '', which is why read swallows
 * and returns '' — there is nothing to paste either way.
 */
export function createTauriClipboard(): ClipboardProvider {
  const dom = createDomClipboard();
  return {
    read: async () => {
      try {
        return (await readText()) ?? '';
      } catch {
        try {
          return await dom.read();
        } catch {
          return '';
        }
      }
    },
    write: async (text) => {
      try {
        await writeText(text);
      } catch {
        // Worth one more try: a failed plugin write and a failed web-view write
        // are different failures, and the second one is what browser dev uses.
        await dom.write(text);
      }
    },
  };
}

let installed: ClipboardProvider | null = null;

/** Install a provider (tests), or clear it back to the real one with null. */
export function setClipboardProvider(provider: ClipboardProvider | null): void {
  installed = provider;
}

export function getClipboard(): ClipboardProvider {
  installed ??= createTauriClipboard();
  return installed;
}
