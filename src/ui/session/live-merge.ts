/**
 * Live Edit — the session side. `isTabLive` answers "does this tab merge
 * instead of raising the conflict banner?" from settings + the tab's own
 * override (policy in core/live-edit.ts); `mergeDiskChange` is what the
 * conflict probe calls INSTEAD of `setConflict(true)` for such a tab:
 *
 *   base   = model.getPersisted('file')   what we last wrote or loaded
 *   mine   = model.getText()              what the editor holds now
 *   theirs = the fresh read from disk     what the other person saved
 *
 * The merged text goes into the model as a 'programmatic' push — the CM6
 * adapter applies it as a minimal change set so the caret survives — and the
 * tab's 'file' baseline becomes `theirs` (adoptMergedText), so the tab is
 * dirty exactly when the merge added something disk lacks, and the next live
 * save (flush cadence) writes it back. An overlapping edit keeps both
 * versions and says so in the status bar.
 */

import { isLiveEditTab } from '../../core/live-edit';
import { mergeThreeWay, pickMergeBase } from '../../core/merge';
import { getSourceAdapter } from '../editor-registry';
import { liveEditStore } from '../stores/live-edit';
import { settingsStore } from '../stores/settings';
import { tabsStore, type TabEntry } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';

/** Is this tab in Live Edit mode right now (override, else its workspace)? */
export function isTabLive(tab: Pick<TabEntry, 'kind' | 'filePath' | 'liveEdit'>): boolean {
  return isLiveEditTab(tab, settingsStore.getState().settings.workspaces);
}

/**
 * Merge `diskText` (read at `mtimeMs`) into the tab. Resolves with false when
 * the merge could not be applied (the caller falls back to the banner).
 */
export function mergeDiskChange(
  ctx: SessionCtx,
  tab: TabEntry,
  diskText: string,
  mtimeMs: number,
): boolean {
  const base = pickMergeBase(
    [tab.model.getPersisted('file'), ...tab.model.getPersistedHistory('file')],
    diskText,
  );
  const mine = tab.model.getText();
  const result = mergeThreeWay(base, mine, diskText);
  if (result.changed) {
    tab.model.pushText(result.text, 'programmatic');
    if (tab.model.getText() !== result.text) {
      return false; // an editor refused the push — let the banner handle it
    }
  }
  tabsStore.getState().adoptMergedText(tab.id, { diskText, mtimeMs });
  liveEditStore.getState().recordMerge(tab.id, ctx.now(), result.overlaps > 0);
  if (result.theirs.length > 0) {
    getSourceAdapter(tab.id)?.flashRanges(result.theirs.map(({ from, to }) => ({ from, to })));
  }
  if (result.overlaps > 0) {
    uiStore
      .getState()
      .showNotice(
        `Merged an overlapping edit into "${tab.title}" — both versions were kept; tidy up the duplicate lines.`,
      );
  }
  return true;
}
