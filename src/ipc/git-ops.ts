/**
 * The streaming half of the git tab's network operations (fetch / pull /
 * push) — the channel plumbing above the raw `ipc.git*` wrappers, the way
 * `pty.ts` sits above `ipc.ptySpawn`.
 *
 * A network op is long (up to 120 s in Rust) and talkative (git's progress
 * arrives on stderr, carriage returns and all), so it streams lines over a
 * Tauri `Channel` and can be cancelled while it runs. `opId` is allocated
 * HERE, before the invoke, so a cancel that lands before Rust has even
 * spawned git still finds the flag it should set.
 *
 * Nothing in this file prompts, types, or shells out: a failure is a result
 * (`ok:false` + stderr) the caller turns into text.
 */

import type { Channel } from '@tauri-apps/api/core';
import {
  createGitOutputChannel,
  ipc as defaultIpc,
  type GitNetResult,
  type GitOutputEvent,
  type Ipc,
} from './commands';

export type GitNetKind = 'fetch' | 'pull' | 'push';

export interface GitNetOptions {
  /** The checkout to run in (absolute path). */
  root: string;
  /** fetch / push: the remote, or null for git's default (`--all` on fetch). */
  remote?: string | null;
  /** fetch: `--prune`. */
  prune?: boolean;
  /** push: `-u <remote> HEAD` — publishing a branch that tracks nothing yet. */
  setUpstream?: boolean;
}

export interface GitNetOp {
  /** Resolves with git's result; rejects only on an IPC error (`GIT_BUSY`, `GIT_CANCELLED`, …). */
  done: Promise<GitNetResult>;
  /** Ask Rust to kill git. Idempotent; a no-op once `done` has settled. */
  cancel: () => void;
}

/** The slice of `Ipc` a runner needs — a test fake is four functions. */
export type GitNetIpc = Pick<Ipc, 'gitFetch' | 'gitPull' | 'gitPush' | 'gitOpCancel'>;

export interface GitNetRunnerDeps {
  ipc?: GitNetIpc;
  /** Injectable: the real `Channel` needs a Tauri runtime to construct. */
  channel?: () => Channel<GitOutputEvent>;
  /** Injectable op-id source (monotonic per window is all Rust needs). */
  nextId?: () => number;
}

/** `(kind, options, onLine) => op` — what the git store is handed as `deps.net`. */
export type GitNetRunner = (
  kind: GitNetKind,
  options: GitNetOptions,
  onLine: (line: { stream: 'out' | 'err'; text: string }) => void,
) => GitNetOp;

let lastOpId = 0;
const defaultNextId = (): number => {
  lastOpId += 1;
  return lastOpId;
};

export function createGitNetRunner(deps: GitNetRunnerDeps = {}): GitNetRunner {
  const ipc = deps.ipc ?? defaultIpc;
  const makeChannel = deps.channel ?? createGitOutputChannel;
  const nextId = deps.nextId ?? defaultNextId;

  return (kind, options, onLine) => {
    const opId = nextId();
    const channel = makeChannel();
    let settled = false;
    channel.onmessage = (event: GitOutputEvent) => {
      if (event.kind === 'line' && !settled) {
        onLine({ stream: event.stream, text: event.text });
      }
    };

    let done: Promise<GitNetResult>;
    switch (kind) {
      case 'fetch':
        done = ipc.gitFetch(
          options.root,
          options.remote ?? null,
          options.prune ?? false,
          opId,
          channel,
        );
        break;
      case 'pull':
        done = ipc.gitPull(options.root, opId, channel);
        break;
      case 'push':
        done = ipc.gitPush(
          options.root,
          options.remote ?? null,
          options.setUpstream ?? false,
          opId,
          channel,
        );
        break;
    }
    done = done.finally(() => {
      settled = true;
    });

    return {
      done,
      cancel: () => {
        if (!settled) {
          void ipc.gitOpCancel(opId).catch(() => {
            /* the op may already be over — nothing to cancel */
          });
        }
      },
    };
  };
}

/** The app's runner: real IPC, real channels. */
export const startGitNetOp: GitNetRunner = createGitNetRunner();
