/**
 * Display metadata and CSS font stacks for the bundled typefaces.
 *
 * The ids live in ./types.ts (they are part of the persisted Settings
 * schema); this module maps each id to what the UI shows and what CSS gets.
 * All woff2 files are imported once in main.tsx via @fontsource — the
 * WebView only fetches a family the moment text actually uses it, so
 * offering many fonts costs nothing at runtime.
 *
 * Every family is licensed SIL OFL 1.1 (see THIRD-PARTY-NOTICES.txt).
 */

import type { EditorFontId, UiFontId } from './types';

/** Shared monospace fallback tail — used when the bundled face fails to load. */
const MONO_FALLBACK = "ui-monospace, 'SF Mono', Consolas, 'DejaVu Sans Mono', monospace";

export interface EditorFontOption {
  id: EditorFontId;
  /** Name shown in the Settings dropdown. */
  label: string;
  /** Full font-family stack for `--font-mono`. */
  stack: string;
  /** Whether the face has code ligatures (the ligatures setting affects it). */
  ligatures: boolean;
}

export const EDITOR_FONTS: readonly EditorFontOption[] = [
  {
    id: 'fira-code',
    label: 'Fira Code (default)',
    stack: `'Fira Code', ${MONO_FALLBACK}`,
    ligatures: true,
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: `'JetBrains Mono', ${MONO_FALLBACK}`,
    ligatures: true,
  },
  {
    id: 'cascadia-code',
    label: 'Cascadia Code',
    stack: `'Cascadia Code', ${MONO_FALLBACK}`,
    ligatures: true,
  },
  {
    id: 'source-code-pro',
    label: 'Source Code Pro',
    stack: `'Source Code Pro', ${MONO_FALLBACK}`,
    ligatures: false,
  },
  {
    id: 'ibm-plex-mono',
    label: 'IBM Plex Mono',
    stack: `'IBM Plex Mono', ${MONO_FALLBACK}`,
    ligatures: false,
  },
  {
    id: 'inconsolata',
    label: 'Inconsolata',
    stack: `'Inconsolata', ${MONO_FALLBACK}`,
    ligatures: false,
  },
  {
    id: 'victor-mono',
    label: 'Victor Mono',
    stack: `'Victor Mono', ${MONO_FALLBACK}`,
    ligatures: true,
  },
];

export interface UiFontOption {
  id: UiFontId;
  label: string;
  /**
   * Full stack for `--font-ui`, or null for 'match' (main.tsx then points
   * `--font-ui` back at `var(--font-mono)` so the chrome follows the editor).
   */
  stack: string | null;
}

export const UI_FONTS: readonly UiFontOption[] = [
  { id: 'match', label: 'Match editor font', stack: null },
  {
    id: 'inter',
    label: 'Inter (suggested)',
    stack: "'Inter', system-ui, 'Segoe UI', sans-serif",
  },
  { id: 'system', label: 'System sans-serif', stack: "system-ui, 'Segoe UI', sans-serif" },
];

export function editorFontStack(id: EditorFontId): string {
  return (EDITOR_FONTS.find((f) => f.id === id) ?? EDITOR_FONTS[0]!).stack;
}

/** Stack for `--font-ui`; null means "follow `--font-mono`". */
export function uiFontStack(id: UiFontId): string | null {
  return (UI_FONTS.find((f) => f.id === id) ?? UI_FONTS[0]!).stack;
}
