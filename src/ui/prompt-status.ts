/**
 * prompt-status.ts — the store behind the prompt strip and the Workspace
 * status panel: every workspace's `STATUSES.md`, as parsed rows.
 *
 * The file is written by agents in the user's own terminal (see
 * `core/prompt-status.ts`), so the app's job is to READ it — `refresh()` runs
 * at boot, whenever the workspace list changes and on every `fs-changed`
 * (main.tsx). The one write the app makes is "Copy as prompt" marking a
 * prompt `queued`; it re-reads the file first so an agent's row written a
 * moment ago is not lost.
 *
 * A workspace with no STATUSES.md is simply absent from `byRoot`, which is
 * also what hides the strip there: the feature exists only where Initialize
 * Workspace (or the user) put the file.
 */

import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import {
  STATUS_FILE,
  parseStatuses,
  promptKey,
  promptText,
  serializeStatuses,
  statusStamp,
  upsertStatus,
  type PromptSection,
  type StatusRow,
} from '../core/prompt-status';
import { joinPath, relativePath } from '../core/session/plan-flush';
import { pathKey, workspaceEntryForPath } from '../core/tab-workspaces';

export interface WorkspaceStatuses {
  root: string;
  rows: StatusRow[];
}

export interface PromptStatusState {
  /** Keyed by `pathKey(root)`. */
  byRoot: Record<string, WorkspaceStatuses>;
  panelOpen: boolean;
}

export interface PromptStatusDeps {
  roots: () => string[];
  /** Null when the file does not exist / cannot be read. */
  read: (path: string) => Promise<string | null>;
  write: (path: string, text: string) => Promise<void>;
  copy: (text: string) => Promise<void>;
  now: () => Date;
}

export function createPromptStatus(deps: PromptStatusDeps) {
  const store = createStore<PromptStatusState>()(() => ({ byRoot: {}, panelOpen: false }));

  async function refresh(): Promise<void> {
    const byRoot: Record<string, WorkspaceStatuses> = {};
    await Promise.all(
      deps.roots().map(async (root) => {
        const text = await deps.read(joinPath(root, STATUS_FILE));
        if (text !== null) {
          byRoot[pathKey(root)] = { root, rows: parseStatuses(text) };
        }
      }),
    );
    // Skip the set when nothing moved: fs-changed fires for every save.
    if (JSON.stringify(byRoot) !== JSON.stringify(store.getState().byRoot)) {
      store.setState({ byRoot });
    }
  }

  /** The tracked workspace a file lives in and its path relative to it. */
  function locate(filePath: string | null): { ws: WorkspaceStatuses; rel: string } | null {
    const ws = workspaceEntryForPath(
      filePath,
      Object.values(store.getState().byRoot).map((w) => ({ ...w, path: w.root })),
    );
    const rel = ws && filePath ? relativePath(ws.root, filePath) : null;
    return ws && rel ? { ws, rel: promptKey(rel) } : null;
  }

  /**
   * Put the prompt on the clipboard and mark it `queued`. A prompt an agent
   * is on right now keeps its row — copying again must not hide live work.
   */
  async function copyAsPrompt(
    filePath: string,
    markdown: string,
    section: PromptSection | null,
  ): Promise<boolean> {
    const at = locate(filePath);
    if (!at) {
      return false;
    }
    await deps.copy(promptText(markdown, at.rel, section));
    const file = joinPath(at.ws.root, STATUS_FILE);
    const rows = parseStatuses((await deps.read(file)) ?? '');
    const key = promptKey(at.rel, section?.slug);
    const current = rows.find((r) => r.key === key);
    if (current?.status !== 'running' && current?.status !== 'needs-input') {
      const next = upsertStatus(rows, {
        key,
        status: 'queued',
        updated: statusStamp(deps.now()),
        summary: '',
      });
      await deps.write(file, serializeStatuses(next));
    }
    await refresh();
    return true;
  }

  return {
    store,
    refresh,
    locate,
    copyAsPrompt,
    setPanelOpen: (panelOpen: boolean) => store.setState({ panelOpen }),
  };
}

export type PromptStatusApi = ReturnType<typeof createPromptStatus>;

let instance: PromptStatusApi | null = null;

/** Wired once at boot (main.tsx). */
export function initPromptStatus(deps: PromptStatusDeps): PromptStatusApi {
  instance = createPromptStatus(deps);
  return instance;
}

export function promptStatus(): PromptStatusApi {
  if (!instance) {
    throw new Error('prompt status used before initPromptStatus');
  }
  return instance;
}

export const usePromptStatus = <T>(selector: (s: PromptStatusState) => T): T =>
  useStore(promptStatus().store, selector);
