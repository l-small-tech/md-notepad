/**
 * GitTab — the source-control panel behind a `kind: 'git'` tab. One per open
 * git tab, all mounted at once and hidden with `display: none` when inactive
 * (ImageView's pattern; rule I7 — nothing here is an editor, but the panel's
 * scroll positions and collapsed sections are worth keeping).
 *
 * Layout: the header (checkout, branch, network) on top; below it two
 * columns — the side (conflicts, changes + commit, worktrees, branches,
 * history; scrollable) and the detail (diff / commit / worktree files /
 * finish flow, with the output drawer at its foot). The divider drags like
 * EditorHost's Split one: the ratio is module-level, shared by every git tab
 * for the session, and applied straight to the style so dragging never
 * re-renders.
 *
 * Everything shown is `useGitStore` state; every click is a store action.
 * Mount → `ensureRepo`; becoming active → `refresh`. One keydown handler on
 * the host root takes Escape: close the dialog, else clear the selection.
 */

import { memo, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { gitStore, repoKey, useGitStore } from '../../stores/git';
import { useTabsStore } from '../../stores/tabs';
import '../../../styles/git.css';
import { BranchesSection } from './BranchesSection';
import { ChangesSection } from './ChangesSection';
import { ConflictsSection } from './ConflictsSection';
import { GitDetail } from './GitDetail';
import { GitHeader } from './GitHeader';
import { GitSkeleton, GitUnavailable } from './GitStates';
import { HistorySection } from './HistorySection';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { OutputDrawer } from './OutputDrawer';
import { WorktreesSection } from './WorktreesSection';

/** Side-column share of the body width, shared by every git tab (session only). */
let sideRatio = 0.38;
const MIN_SIDE_PX = 260;

function clampRatio(ratio: number, totalPx: number): number {
  const min = totalPx > 0 ? MIN_SIDE_PX / totalPx : 0.2;
  return Math.min(0.8, Math.max(min, ratio));
}

function GitTabImpl({ tabId, active }: { tabId: string; active: boolean }) {
  const root = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.gitRoot ?? null);
  const checkout = useTabsStore((s) => s.tabs.find((t) => t.id === tabId)?.gitCheckout ?? null);
  const key = root === null ? '' : repoKey(root);
  const unavailable = useGitStore((s) => s.repos[key]?.unavailable ?? null);
  const hasStatus = useGitStore((s) => (s.repos[key]?.status ?? null) !== null);
  const loadingStatus = useGitStore((s) => s.repos[key]?.loading.status ?? false);
  const dialogOpen = useGitStore((s) => s.repos[key]?.newWorktree.open ?? false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef<HTMLDivElement>(null);

  // Track the repository for as long as a tab shows it (forgetting is the
  // tabs-store subscription's job in git-open.ts, once the last tab closes).
  useEffect(() => {
    if (root !== null) {
      gitStore.getState().ensureRepo(root, checkout);
    }
    // Mount only: the checkout picker drives later changes through the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Coming to the front re-asks git (throttled in the store).
  useEffect(() => {
    if (active && root !== null) {
      void gitStore.getState().refresh(root);
    }
  }, [active, root]);

  // Apply the shared ratio when the side column mounts.
  useEffect(() => {
    const side = sideRef.current;
    if (side) {
      side.style.flex = `0 0 ${sideRatio * 100}%`;
    }
  });

  const startDividerDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const body = bodyRef.current;
    const side = sideRef.current;
    if (!body || !side) {
      return;
    }
    e.preventDefault();
    const divider = e.currentTarget;
    divider.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rect = body.getBoundingClientRect();
      sideRatio = clampRatio((ev.clientX - rect.left) / rect.width, rect.width);
      side.style.flex = `0 0 ${sideRatio * 100}%`;
    };
    const onUp = () => {
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
      divider.removeEventListener('pointercancel', onUp);
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
    divider.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || root === null) {
      return;
    }
    const state = gitStore.getState();
    if (dialogOpen) {
      e.preventDefault();
      e.stopPropagation();
      state.closeNewWorktree(root);
      return;
    }
    if (state.repos[key]?.selected) {
      e.preventDefault();
      e.stopPropagation();
      state.select(root, null);
    }
  };

  return (
    <div
      className="editor-host git-host"
      style={{ display: active ? 'flex' : 'none' }}
      onKeyDown={onKeyDown}
    >
      {root === null ? (
        <GitUnavailable kind="not-a-repo" root={null} tabId={tabId} />
      ) : unavailable !== null ? (
        <GitUnavailable kind={unavailable} root={root} tabId={tabId} />
      ) : (
        <>
          <GitHeader root={root} tabId={tabId} />
          <div className="git-body" ref={bodyRef}>
            <div className="git-side" ref={sideRef}>
              {!hasStatus && loadingStatus ? (
                <GitSkeleton />
              ) : (
                <>
                  <ConflictsSection root={root} />
                  <ChangesSection root={root} />
                  <WorktreesSection root={root} />
                  <BranchesSection root={root} />
                  <HistorySection root={root} />
                </>
              )}
            </div>
            <div
              className="git-divider"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startDividerDrag}
            />
            <div className="git-detail">
              <div className="git-detail-main">
                <GitDetail root={root} />
              </div>
              <OutputDrawer root={root} />
            </div>
          </div>
          <NewWorktreeDialog root={root} />
        </>
      )}
    </div>
  );
}

export const GitTab = memo(GitTabImpl);
