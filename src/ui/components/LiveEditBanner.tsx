/**
 * LiveEditBanner — per-tab "another editor replaced lines you wrote" notice
 * (Live Edit). The merge already took the version on disk (core/merge.ts);
 * this offers the author's own lines back. Non-blocking, same shape as the
 * ConflictBanner, sits above the editor pane. Restore mine reinserts the
 * lines right after the ones that replaced them (they flash green) so the
 * two versions can be reconciled by hand; Dismiss forgets them.
 */

import { dismissLostLines, restoreLostLines } from '../session';
import { useLiveEditStore } from '../stores/live-edit';

export function LiveEditBanner({ tabId }: { tabId: string }) {
  const lost = useLiveEditStore((s) => s.lost[tabId]);
  if (!lost || lost.length === 0) {
    return null;
  }
  const n = lost.reduce((sum, b) => sum + b.lines.length, 0);
  return (
    <div className="conflict-banner live-edit-banner" role="alert">
      <span className="conflict-banner-message">
        Another editor replaced {n} {n === 1 ? 'line' : 'lines'} you wrote
      </span>
      <button
        className="conflict-banner-button"
        title="Put your lines back, right after the ones that replaced them"
        onClick={() => restoreLostLines(tabId)}
      >
        Restore mine
      </button>
      <button className="conflict-banner-button" onClick={() => dismissLostLines(tabId)}>
        Dismiss
      </button>
    </div>
  );
}
