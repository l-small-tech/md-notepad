/**
 * Agent status cues carried in a terminal's OSC 0/2 title.
 *
 * CLI agents that live in a terminal tab announce what they are doing by
 * prefixing their window title with a single glyph — Claude Code writes
 * `✳ <title>` when it is idle and alternates `◐ ` / `◑ ` while it works, and
 * the same convention (a spinner while busy, a check when done, a mark when
 * it needs you) shows up across other tools. Rendered as plain text that cue
 * is a 13px character lost inside the label, so the strip parses it out here
 * and the TabBar paints it as a colored badge instead.
 *
 * Pure and app-local-free (I9): a glyph in, an activity + the remaining title
 * out. The classification is deliberately generous — an unknown leading glyph
 * is left in the label rather than painted with a meaning we guessed.
 */

/** What the leading glyph says the session is doing. */
export type AgentActivity = 'working' | 'ready' | 'waiting' | 'error';

export interface AgentStatusCue {
  activity: AgentActivity;
  /** The glyph itself, so the badge shows what the agent actually sent. */
  glyph: string;
  /** Screen-reader text for the badge. */
  label: string;
}

/**
 * Glyph → activity. Every entry is a single code point (variation selectors
 * are stripped before lookup), because the cue is always one leading
 * character followed by a space.
 *
 * `working` — braille/arc/clock spinners, the ones that animate frame to
 *   frame. Claude Code's ◐ ◑ pair lives here.
 * `ready`   — the idle/"turn is yours" marks and completion checks. Claude
 *   Code's ✳ is the idle prefix, which is also what a finished turn shows.
 * `waiting` — the agent is blocked on the user (a permission prompt, a
 *   question, a paused run).
 * `error`   — the turn failed.
 */
const ACTIVITY_BY_GLYPH = new Map<string, AgentActivity>([
  // Half/quarter circle spinners (Claude Code) and their siblings.
  ...(['◐', '◑', '◒', '◓', '◴', '◵', '◶', '◷', '◜', '◝', '◞', '◟'] as const).map(
    (g) => [g, 'working'] as const,
  ),
  // Braille spinners — the dominant CLI spinner family.
  ...(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const).map(
    (g) => [g, 'working'] as const,
  ),
  ...(['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const).map((g) => [g, 'working'] as const),
  ...(['⏳', '⌛', '🔄'] as const).map((g) => [g, 'working'] as const),
  // Idle / done.
  ...(['✳', '✱', '✲', '✴', '✵', '✶', '✷', '✸', '✹', '✺', '✻', '✽', '❋'] as const).map(
    (g) => [g, 'ready'] as const,
  ),
  ...(['✓', '✔', '☑', '✅', '🟢'] as const).map((g) => [g, 'ready'] as const),
  // Blocked on the user.
  ...(['⏸', '❓', '❔', '🔔', '⚠', '❗', '❕', '🟡', '🟠'] as const).map(
    (g) => [g, 'waiting'] as const,
  ),
  // Failed.
  ...(['✗', '✘', '✖', '❌', '⨯', '🔴'] as const).map((g) => [g, 'error'] as const),
]);

const LABEL: Record<AgentActivity, string> = {
  working: 'Working',
  ready: 'Ready',
  waiting: 'Needs input',
  error: 'Failed',
};

/** Emoji presentation selectors ride along with glyphs like ⚠️ — drop them. */
const VARIATION_SELECTORS = /[\uFE00-\uFE0F]/g;

export interface SplitTitle {
  /** The parsed cue, or null when the title carries no known status glyph. */
  cue: AgentStatusCue | null;
  /** The title with the cue (and the space after it) removed. */
  rest: string;
}

/**
 * Split a leading status glyph off a terminal title.
 *
 * Requires the glyph to be followed by whitespace and something else — a
 * title that IS just "✳" or "?" is a title, not a status cue, and a shell
 * prompt reading "~/src ✗" is not a prefix at all. When nothing matches, the
 * title comes back untouched and the caller renders it as before.
 */
export function splitAgentStatus(title: string): SplitTitle {
  const match = /^(\S)\uFE0F?\s+(\S[\s\S]*)$/u.exec(title);
  if (!match) {
    return { cue: null, rest: title };
  }
  const glyph = match[1]!;
  const rest = match[2]!;
  const activity = ACTIVITY_BY_GLYPH.get(glyph.replace(VARIATION_SELECTORS, ''));
  if (!activity) {
    return { cue: null, rest: title };
  }
  return { cue: { activity, glyph, label: LABEL[activity] }, rest };
}
