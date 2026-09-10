/**
 * Live Edit — the session side. `isTabLive` answers "does this tab merge
 * instead of raising the conflict banner?" from settings + the tab's own
 * override (policy in core/live-edit.ts); `mergeDiskChange` is what the
 * conflict probe calls INSTEAD of `setConflict(true)` for such a tab:
 *
 *   base   = the snapshot `theirs` grew from (pickMergeBase over our history)
 *   mine   = model.getText()              what the editor holds now
 *   theirs = the fresh read from disk     what the other person saved
 *
 * Disk wins where both sides changed the same lines (core/merge.ts explains
 * why), but nothing vanishes unannounced: if the merge will remove lines,
 * the source editor flashes them red FIRST and the text changes
 * `REMOVE_FLASH_MS` later (the merge is recomputed then, against whatever
 * the author typed meanwhile); lines that arrive flash green; and the
 * author's own overwritten lines go to `liveEditStore.lost`, where the
 * Restore-mine banner offers `restoreLostLines` — which puts them back right
 * after their replacement, so the two versions sit together to reconcile.
 *
 * While a tab's red flash is pending, its live save is held (`hasPendingMerge`)
 * so our stale text is not written over the change we are about to adopt.
 *
 * The merged text goes into the model as a 'programmatic' push — the CM6
 * adapter applies it as a minimal change set so the caret survives — and the
 * tab's 'file' baseline becomes `theirs` (adoptMergedText), so the tab is
 * dirty exactly when the merge left something disk lacks, and the next live
 * save writes it.
 */

import { isLiveEditTab } from '../../core/live-edit';
import { mergeThreeWay, pickMergeBase, restoreLostBlocks } from '../../core/merge';
import { getSourceAdapter } from '../editor-registry';
import { liveEditStore } from '../stores/live-edit';
import { settingsStore } from '../stores/settings';
import { tabsStore, type TabEntry } from '../stores/tabs';
import { uiStore } from '../stores/ui';
import type { SessionCtx } from './context';

/** How long removed lines show red before the merged text replaces them. */
export const REMOVE_FLASH_MS = 1500;

/** Tabs whose merge is showing its red flash and has not landed yet. */
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Is this tab in Live Edit mode right now (override, else its workspace)? */
export function isTabLive(tab: Pick<TabEntry, 'kind' | 'filePath' | 'liveEdit'>): boolean {
  return isLiveEditTab(tab, settingsStore.getState().settings.workspaces);
}

/** A merge is mid-flash for this tab: hold its live save until it lands. */
export function hasPendingMerge(tabId: string): boolean {
  return pending.has(tabId);
}

/**
 * Merge `diskText` (read at `mtimeMs`) into the tab. Resolves with false when
 * the merge could not be applied (the caller falls back to the banner). A
 * probe that fires while the red flash is showing is absorbed: the pending
 * apply re-reads the model, and the next poll re-reads the disk.
 */
export function mergeDiskChange(
  ctx: SessionCtx,
  tab: TabEntry,
  diskText: string,
  mtimeMs: number,
): boolean {
  if (pending.has(tab.id)) {
    return true;
  }
  const base = pickMergeBase(
    [tab.model.getPersisted('file'), ...tab.model.getPersistedHistory('file')],
    diskText,
  );
  const preview = mergeThreeWay(base, tab.model.getText(), diskText);
  const adapter = getSourceAdapter(tab.id);
  if (preview.removed.length > 0 && adapter) {
    // Show what is about to go, then land the merge.
    adapter.flashRanges(preview.removed, 'removed');
    pending.set(
      tab.id,
      setTimeout(() => {
        pending.delete(tab.id);
        const live = tabsStore.getState().tabs.find((t) => t.id === tab.id);
        if (live) {
          applyMerge(ctx, live, base, diskText, mtimeMs);
        }
      }, REMOVE_FLASH_MS),
    );
    return true;
  }
  return applyMerge(ctx, tab, base, diskText, mtimeMs);
}

function applyMerge(
  ctx: SessionCtx,
  tab: TabEntry,
  base: string,
  diskText: string,
  mtimeMs: number,
): boolean {
  const result = mergeThreeWay(base, tab.model.getText(), diskText);
  if (result.changed) {
    tab.model.pushText(result.text, 'programmatic');
    if (tab.model.getText() !== result.text) {
      return false; // an editor refused the push — let the banner handle it
    }
  }
  tabsStore.getState().adoptMergedText(tab.id, { diskText, mtimeMs });
  liveEditStore.getState().recordMerge(tab.id, ctx.now());
  const adapter = getSourceAdapter(tab.id);
  adapter?.clearFlash('removed');
  if (result.theirs.length > 0) {
    adapter?.flashRanges(result.theirs, 'added');
  }
  if (result.lost.length > 0) {
    liveEditStore.getState().setLost(tab.id, result.lost);
    const n = result.lost.reduce((sum, b) => sum + b.lines.length, 0);
    uiStore
      .getState()
      .showNotice(
        `Another editor replaced ${n} line${n === 1 ? '' : 's'} you wrote in "${tab.title}" — Restore mine is above the editor.`,
      );
  }
  return true;
}

/** Restore-mine: reinsert the author's overwritten lines after their replacement. */
export function restoreLostLines(tabId: string): void {
  const tab = tabsStore.getState().tabs.find((t) => t.id === tabId);
  const blocks = liveEditStore.getState().lost[tabId];
  if (!tab || !blocks || blocks.length === 0) {
    return;
  }
  const { text, inserted } = restoreLostBlocks(tab.model.getText(), blocks);
  tab.model.pushText(text, 'programmatic');
  liveEditStore.getState().setLost(tabId, []);
  getSourceAdapter(tabId)?.flashRanges(inserted, 'added');
  // The push above marks the tab dirty; the next flush live-saves it.
}

/** Dismiss the Restore-mine offer without changing the text. */
export function dismissLostLines(tabId: string): void {
  liveEditStore.getState().setLost(tabId, []);
}
