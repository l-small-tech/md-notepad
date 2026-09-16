/**
 * Prompts — the reusable briefs the Help… › Prompts menu page hands to an AI
 * agent. Each one is a page under docs/prompts (readable in the Documentation
 * workspace) bundled here verbatim, so the menu's copy and the docs page can
 * never drift. Picking a prompt puts it on the clipboard; the user pastes it
 * into a harness terminal or any chat assistant.
 */

import themeMarpDeck from '../../docs/prompts/theme-marp-deck.md?raw';
import { getClipboard } from '../ipc/clipboard';
import { openDocs } from './session';
import { uiStore } from './stores/ui';

export interface PromptEntry {
  /** Stable id (the docs page's file name without the extension). */
  id: string;
  /** The menu row's label. */
  label: string;
  /** The row's tooltip: what the prompt gets an agent to do. */
  title: string;
  /** The prompt text, exactly as the docs page shows it. */
  text: string;
}

/** The catalog, in menu order. */
export const PROMPTS: readonly PromptEntry[] = [
  {
    id: 'theme-marp-deck',
    label: 'Theme a Marp deck & its SVGs',
    title:
      'Convert a Marp deck and the SVG images it embeds so slides and diagrams follow the app theme',
    text: themeMarpDeck,
  },
];

/** The docs page describing the prompts and how to use them. */
export const PROMPTS_DOC_PAGE = 'prompts.md';

/** The docs page holding one prompt's text. */
export function promptDocPage(prompt: PromptEntry): string {
  return `prompts/${prompt.id}.md`;
}

/**
 * Put a prompt on the clipboard and say so in the status bar. A clipboard
 * that refuses (a web view without permission) is reported the same way, so
 * the user knows to open the page and copy by hand.
 */
export async function copyPrompt(prompt: PromptEntry): Promise<void> {
  const { showNotice } = uiStore.getState();
  try {
    await getClipboard().write(prompt.text);
    showNotice(`Prompt copied — paste it into your AI agent (${prompt.label})`);
  } catch {
    showNotice(
      'Could not copy the prompt — right-click it under Help… › Prompts to read and copy it by hand',
    );
  }
}

/** Open the prompts guide, or one prompt's own page, in the docs workspace. */
export function openPromptsDocs(prompt?: PromptEntry): void {
  openDocs(prompt ? promptDocPage(prompt) : PROMPTS_DOC_PAGE);
}
