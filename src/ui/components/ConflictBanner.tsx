/**
 * ConflictBanner — per-tab "File changed on disk" notice (M3).
 *
 * Non-blocking: it sits above the editor pane without unmounting or covering
 * it (src/ui/README component inventory). Reload replaces the
 * model with the on-disk content; Keep mine dismisses the banner so the next
 * save overwrites instead of re-flagging the same conflict.
 */

import { keepMineTab, reloadTab } from '../session';
import { useTabsStore } from '../stores/tabs';

export function ConflictBanner({ tabId }: { tabId: string }) {
  const conflict = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.conflict ?? false);

  if (!conflict) {
    return null;
  }

  return (
    <div className="conflict-banner" role="alert">
      <span className="conflict-banner-message">File changed on disk</span>
      <button className="conflict-banner-button" onClick={() => reloadTab(tabId)}>
        Reload
      </button>
      <button className="conflict-banner-button" onClick={() => keepMineTab(tabId)}>
        Keep mine
      </button>
    </div>
  );
}
