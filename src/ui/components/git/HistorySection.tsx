/**
 * HistorySection — the log of the selected checkout: short sha, subject,
 * author and a relative time; a click shows the commit in the detail pane;
 * "Load more" pages further back until git says there is no more.
 */

import { relativeTime } from '../../../core/notes-overview';
import { gitStore } from '../../stores/git';
import { Empty, Section, useNow, useRepoSlice } from './shared';

export function HistorySection({ root }: { root: string }) {
  const log = useRepoSlice(root, (r) => r.log) ?? [];
  const exhausted = useRepoSlice(root, (r) => r.logExhausted) ?? false;
  const loading = useRepoSlice(root, (r) => r.loading.log) ?? false;
  const selected = useRepoSlice(root, (r) => r.selected) ?? null;
  const actions = gitStore.getState();
  const now = useNow();

  return (
    <Section title="History" count={log.length} defaultOpen={false}>
      {log.length === 0 ? (
        <Empty>{loading ? 'Reading the log…' : 'No commits yet'}</Empty>
      ) : (
        log.map((c) => (
          <div
            key={c.sha}
            className={`git-row git-commit-row${selected?.kind === 'commit' && selected.sha === c.sha ? ' is-selected' : ''}`}
            role="button"
            tabIndex={0}
            title={`${c.sha}\n${c.author} · ${c.at}`}
            onClick={() => actions.select(root, { kind: 'commit', sha: c.sha })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                actions.select(root, { kind: 'commit', sha: c.sha });
              }
            }}
          >
            <span className="git-sha">{c.short}</span>
            <span className="git-commit-subject">{c.subject}</span>
            <span className="git-commit-meta">
              {c.author} · {relativeTime(c.at, now)}
            </span>
          </div>
        ))
      )}
      {log.length > 0 && !exhausted && (
        <button
          type="button"
          className="git-link-btn git-load-more"
          disabled={loading}
          onClick={() => void actions.loadMoreLog(root)}
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </Section>
  );
}
