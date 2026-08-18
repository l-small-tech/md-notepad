/**
 * What "+" (and mod+N) should make — decided once, purely, so the button, the
 * shortcut and the command palette cannot drift apart.
 *
 * The rule is "another one of what I am looking at": a terminal makes a
 * terminal, a drawing makes a drawing, anything else makes a note. That keeps
 * the promise the button has always made ("New tab", not "New note") while
 * making it useful on the two tab kinds a plain note is wrong for. Every type
 * stays explicitly reachable through the picker menu, so the inference is
 * never the only route.
 */

import { docFamilyForTab } from './doc-family';
import type { TabKind } from './types';

export type NewTabChoice = 'note' | 'drawing' | 'terminal';

/** The subset of a tab this decision reads. */
export interface NewTabContext {
  kind: TabKind;
  filePath?: string | null;
  notePath?: string | null;
}

/**
 * The type a plain "+" should create, given the tab in front (or null when
 * nothing is open).
 *
 * `terminalsAvailable` is false on Android, which has no pty: there the
 * answer can never be 'terminal', however the question is asked.
 */
export function defaultNewTabChoice(
  active: NewTabContext | null,
  terminalsAvailable = true,
): NewTabChoice {
  if (!active) {
    return 'note';
  }
  switch (docFamilyForTab(active)) {
    case 'terminal':
      return terminalsAvailable ? 'terminal' : 'note';
    case 'svg':
      return 'drawing';
    default:
      // Notes, markdown files, images and import cards all make a note: an
      // image viewer is not a document type you can author a new one of.
      return 'note';
  }
}
