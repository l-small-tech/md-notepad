/**
 * PromptStrip — a note's prompt status, above the editor.
 *
 * Shown only for a file inside a workspace that has a `STATUSES.md` (see
 * `ui/prompt-status.ts`). It carries the two halves of the loop:
 *
 * - **Copy as prompt** — the picked section (or the whole note) goes to the
 *   clipboard with its `Prompt-id:` line and is marked Queued. The picker
 *   follows the caret in Raw/Split mode until the user picks by hand.
 * - one chip per section an agent has reported on, with its one-line summary.
 *
 * All decisions are `core/prompt-status.ts`; this is its projection.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  STATUS_LABELS,
  promptSections,
  sectionAtLine,
  statusesForNote,
} from '../../core/prompt-status';
import { getSourceAdapter } from '../editor-registry';
import type { DocModel } from '../../core/doc-model';
import { promptStatus, usePromptStatus, type PromptStatusApi } from '../prompt-status';
import { useTabsStore } from '../stores/tabs';
import { uiStore } from '../stores/ui';

const WHOLE = '';

export function PromptStrip({ tabId }: { tabId: string }) {
  const filePath = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  const model = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.model);
  // Subscribed so the strip appears/disappears and re-reads rows as any STATUSES.md changes.
  const byRoot = usePromptStatus((s) => s.byRoot);
  void byRoot;
  const at = promptStatus().locate(filePath);
  if (!at || !filePath || !model || /(^|\/)STATUSES\.md$/i.test(at.rel)) {
    return null;
  }
  // Keyed by file: a Save As starts over rather than carrying a stale pick.
  return <Strip key={filePath} tabId={tabId} filePath={filePath} model={model} at={at} />;
}

function Strip({
  tabId,
  filePath,
  model,
  at,
}: {
  tabId: string;
  filePath: string;
  model: DocModel;
  at: NonNullable<ReturnType<PromptStatusApi['locate']>>;
}) {
  const [text, setText] = useState(() => model.getText());
  useEffect(() => {
    // Headings move as the user types; a short debounce keeps this off the keystroke path.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = model.subscribe(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => setText(model.getText()), 400);
    });
    return () => {
      off();
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [model]);

  const sections = useMemo(() => promptSections(text), [text]);
  const [picked, setPicked] = useState<string | null>(null);
  // The caret moves without re-rendering this strip; hovering it re-reads.
  const [, recheckCaret] = useState(0);

  const statuses = statusesForNote(at.ws.rows, at.rel);
  /** The hand-picked section while it still exists, else the caret's, else the whole note. */
  const valueIn = (list: typeof sections): string => {
    if (picked !== null && (picked === WHOLE || list.some((s) => s.slug === picked))) {
      return picked;
    }
    const line = getSourceAdapter(tabId)?.getCaretLine() ?? null;
    return line === null ? WHOLE : (sectionAtLine(list, line)?.slug ?? WHOLE);
  };
  const value = valueIn(sections);

  const copy = async () => {
    const current = model.getText();
    const fresh = promptSections(current);
    const slug = valueIn(fresh);
    const section = fresh.find((s) => s.slug === slug) ?? null;
    const ok = await promptStatus()
      .copyAsPrompt(filePath, current, section)
      .catch(() => false);
    uiStore
      .getState()
      .showNotice(
        ok
          ? `Copied "${section?.title ?? 'whole note'}" — paste it into your agent.`
          : 'Could not copy the prompt.',
        3500,
      );
  };

  const chips = [...statuses.entries()].map(([slug, row]) => ({
    slug,
    row,
    title:
      slug === WHOLE ? 'Whole note' : (sections.find((s) => s.slug === slug)?.title ?? `#${slug}`),
  }));

  return (
    <div
      className="prompt-strip"
      role="group"
      aria-label="Prompt status"
      onPointerEnter={() => recheckCaret((n) => n + 1)}
    >
      <select
        className="prompt-strip-select"
        aria-label="Section to copy"
        value={value}
        onChange={(e) => setPicked(e.target.value)}
      >
        <option value={WHOLE}>Whole note</option>
        {sections.map((s) => (
          <option key={s.slug} value={s.slug}>
            {`${'  '.repeat(Math.max(0, s.level - 1))}${s.title}`}
          </option>
        ))}
      </select>
      <button
        className="conflict-banner-button"
        title="Copy this section for your agent and mark it Queued"
        onClick={() => void copy()}
      >
        Copy as prompt
      </button>
      <div className="prompt-strip-chips">
        {chips.map(({ slug, row, title }) => (
          <button
            key={slug}
            className="prompt-chip"
            data-status={row.status}
            title={`${title} — ${STATUS_LABELS[row.status]}${row.updated ? ` · ${row.updated}` : ''}${row.summary ? `\n${row.summary}` : ''}`}
            onClick={() => {
              setPicked(slug);
              const line = sections.find((s) => s.slug === slug)?.line;
              if (line !== undefined) {
                getSourceAdapter(tabId)?.revealLine(line);
              }
            }}
          >
            <span className="prompt-chip-dot" aria-hidden="true" />
            <span className="prompt-chip-title">{title}</span>
            <span className="prompt-chip-status">{STATUS_LABELS[row.status]}</span>
            {row.summary && <span className="prompt-chip-summary">{row.summary}</span>}
          </button>
        ))}
      </div>
      <button
        className="conflict-banner-button"
        title="Every prompt in this workspace"
        onClick={() => promptStatus().setPanelOpen(true)}
      >
        All
      </button>
    </div>
  );
}
