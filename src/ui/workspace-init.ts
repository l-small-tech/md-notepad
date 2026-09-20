/**
 * workspace-init.ts — the state and side effects behind the Initialize
 * Workspace dialog (`components/InitWorkspaceDialog.tsx`).
 *
 * The decisions are `core/workspace-modules.ts` (what AGENTS.md becomes, which
 * files get written, what is never overwritten); this file only gathers its
 * inputs — the folder, the user's modules folder, the files already there —
 * and performs the writes it plans. Opened with a `root` it is the
 * "Workspace directives…" re-run on an existing workspace: the ticks start
 * from the modules AGENTS.md already carries.
 */

import { openPath } from '@tauri-apps/plugin-opener';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { errorDetail } from '../core/error-text';
import { baseName, joinPath } from '../core/session/plan-flush';
import { pickUnusedColor } from '../core/settings';
import { pathKey } from '../core/tab-workspaces';
import {
  BUILTIN_MODULES,
  HARNESS_STUBS,
  initPlanPaths,
  installedModuleIds,
  planWorkspaceInit,
  userModuleFrom,
  type WorkspaceModule,
} from '../core/workspace-modules';
import { ipc } from '../ipc/commands';
import { pickDirectory } from '../ipc/dialog';
import { resolveAgentModulesDir } from '../ipc/paths';
import { promptStatus } from './prompt-status';
import { getDefaultWorkspacePath, openNotePath } from './session';
import { settingsStore } from './stores/settings';
import { uiStore } from './stores/ui';

export interface WorkspaceInitState {
  open: boolean;
  /** The folder being initialized; null until one is picked. */
  root: string | null;
  /** True when opened on an existing workspace (the folder is fixed). */
  rerun: boolean;
  modules: WorkspaceModule[];
  selected: string[];
  /** Module ids AGENTS.md in `root` already carries. */
  installed: string[];
  stubs: string[];
  modulesDir: string | null;
  busy: boolean;
  error: string | null;
}

const initial: WorkspaceInitState = {
  open: false,
  root: null,
  rerun: false,
  modules: [...BUILTIN_MODULES],
  selected: [],
  installed: [],
  stubs: HARNESS_STUBS.map((s) => s.path),
  modulesDir: null,
  busy: false,
  error: null,
};

export const workspaceInitStore = createStore<WorkspaceInitState>()(() => initial);

export const useWorkspaceInit = <T>(selector: (s: WorkspaceInitState) => T): T =>
  useStore(workspaceInitStore, selector);

const set = (patch: Partial<WorkspaceInitState>) => workspaceInitStore.setState(patch);

async function readOrNull(path: string): Promise<string | null> {
  try {
    return (await ipc.readTextFile(path)).text;
  } catch {
    return null;
  }
}

/** Built-ins plus every `.md` in the user's modules folder (created on first use). */
async function loadModules(): Promise<{ modules: WorkspaceModule[]; dir: string | null }> {
  const modules = [...BUILTIN_MODULES];
  try {
    const dir = await resolveAgentModulesDir();
    await ipc.createDir(dir).catch(() => {});
    for (const entry of await ipc.listDir(dir, true)) {
      if (entry.isDir || !/\.(md|markdown)$/i.test(entry.path)) {
        continue;
      }
      const text = await readOrNull(entry.path);
      const mod = text === null ? null : userModuleFrom(baseName(entry.path), text);
      if (mod && !modules.some((m) => m.id === mod.id)) {
        modules.push(mod);
      }
    }
    return { modules, dir };
  } catch {
    return { modules, dir: null };
  }
}

/** Point the dialog at a folder: tick what its AGENTS.md already has, else the recommended set. */
async function adoptRoot(root: string): Promise<void> {
  const agents = await readOrNull(joinPath(root, 'AGENTS.md'));
  const installed = agents === null ? [] : installedModuleIds(agents);
  const { modules } = workspaceInitStore.getState();
  set({
    root,
    installed,
    selected:
      installed.length > 0
        ? installed.filter((id) => modules.some((m) => m.id === id))
        : modules.filter((m) => m.recommended).map((m) => m.id),
  });
}

export async function openWorkspaceInit(root?: string): Promise<void> {
  set({ ...initial, open: true, rerun: root !== undefined });
  const { modules, dir } = await loadModules();
  set({
    modules,
    modulesDir: dir,
    selected: modules.filter((m) => m.recommended).map((m) => m.id),
  });
  if (root !== undefined) {
    await adoptRoot(root);
  }
}

export function closeWorkspaceInit(): void {
  set({ open: false });
}

export async function pickInitFolder(): Promise<void> {
  const picked = await pickDirectory(null, 'Choose or create the workspace folder');
  if (picked) {
    await adoptRoot(picked);
  }
}

/** Show the user's directives folder in the OS file manager. */
export async function openModulesFolder(): Promise<void> {
  const dir = workspaceInitStore.getState().modulesDir;
  if (dir) {
    await openPath(dir).catch(() => {
      uiStore.getState().showNotice('Could not open the directives folder.');
    });
  }
}

export function toggleInitModule(id: string): void {
  const { selected } = workspaceInitStore.getState();
  set({ selected: selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id] });
}

export function toggleInitStub(path: string): void {
  const { stubs } = workspaceInitStore.getState();
  set({ stubs: stubs.includes(path) ? stubs.filter((s) => s !== path) : [...stubs, path] });
}

/** Add `root` to the explorer unless it (or the default workspace) already is one. */
function registerWorkspace(root: string): void {
  const { settings, update } = settingsStore.getState();
  const key = pathKey(root);
  const defaultPath = getDefaultWorkspacePath();
  const known =
    (defaultPath !== null && pathKey(defaultPath) === key) ||
    settings.workspaces.some((w) => pathKey(w.path) === key);
  if (!known) {
    const color = pickUnusedColor([
      settings.defaultWorkspaceColor,
      ...settings.workspaces.map((w) => w.color),
    ]);
    update({
      workspaces: [...settings.workspaces, { name: baseName(root) || root, path: root, color }],
    });
  }
  uiStore.getState().setSelectedExplorerDir(root);
}

export async function applyWorkspaceInit(): Promise<void> {
  const state = workspaceInitStore.getState();
  const root = state.root;
  if (!root || state.busy) {
    return;
  }
  set({ busy: true, error: null });
  try {
    // Selection order follows the checklist, not the order of clicks.
    const chosen = state.modules.filter((m) => state.selected.includes(m.id));
    const existing = new Map<string, string>();
    for (const rel of new Set(initPlanPaths(chosen))) {
      const text = await readOrNull(joinPath(root, rel));
      if (text !== null) {
        existing.set(rel, text);
      }
    }
    const writes = planWorkspaceInit({
      workspaceName: baseName(root) || 'Workspace',
      modules: chosen,
      knownIds: new Set(state.modules.map((m) => m.id)),
      stubs: state.stubs,
      existing,
    });
    for (const write of writes) {
      await ipc.atomicWriteText(joinPath(root, write.path), write.text);
    }

    registerWorkspace(root);
    await promptStatus().refresh();
    uiStore.getState().refreshExplorer();
    const example = writes.find((w) => w.path.startsWith('prompts/'));
    if (example) {
      openNotePath(joinPath(root, example.path));
    }
    uiStore
      .getState()
      .showNotice(
        writes.length === 0
          ? 'Workspace already up to date.'
          : `Workspace ready — ${writes.length} file${writes.length === 1 ? '' : 's'} written.`,
      );
    set({ open: false, busy: false });
  } catch (error) {
    set({ busy: false, error: errorDetail(error) || 'Could not write the workspace files.' });
  }
}
