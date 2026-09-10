/**
 * The pty provider seam.
 *
 * Everything above this layer (the terminal panes) talks to a `PtyProvider`,
 * never to `ipc` directly. On desktop that is the Tauri provider below; tests
 * install a fake. The same seam is where a future ssh/tmux backend would plug
 * in without the UI noticing. Android has no pty at all — nothing there ever
 * reaches this file (`isAndroid()` hides every entry point).
 */

import type { Channel } from '@tauri-apps/api/core';
import {
  IpcError,
  createIpcChannel,
  ipc as defaultIpc,
  type ChannelFactory,
  type Ipc,
  type PtyMessage,
  type PtySpawnArgs,
} from './commands';

/** A pane's grid, in cells. */
export interface PtyGrid {
  cols: number;
  rows: number;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  program?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PtyHandlers {
  /** A coalesced run of child output. Never called after `onClose`. */
  onData: (bytes: Uint8Array) => void;
  /** The child process exited. Output may still follow (see src-tauri/src/pty.rs). */
  onExit?: (code: number) => void;
  /** The pty drained and the session is gone. Nothing follows this. */
  onClose?: () => void;
}

export interface PtyHandle {
  readonly id: number;
  write: (data: Uint8Array | string) => Promise<void>;
  /**
   * The TERMINAL answering a query the shell asked (cursor position, device
   * attributes, colors) — as opposed to `write`, which is the user typing.
   *
   * Dropped while a handover replay is in flight, which is the whole reason
   * this is separate from `write`: replayed output still contains the queries
   * the shell asked in the window the tab came from (ConPTY's stream opens
   * with `ESC[6n`), and answering one NOW sends a stale cursor report into a
   * live shell. ConPTY re-syncs to it and draws from the wrong column — the
   * caret lands inside the prompt and typing overwrites it.
   */
  report: (data: Uint8Array) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  kill: () => Promise<void>;
  /**
   * Stop listening without killing the shell — how a pane lets go of a pty
   * that is being handed to another window. Output buffers in the backend
   * until something attaches.
   */
  detach: () => Promise<void>;
}

/**
 * The slice of `Ipc` this provider actually calls. Narrow on purpose: a test
 * fake is five functions, not the whole filesystem surface.
 */
export type PtyIpc = Pick<
  Ipc,
  'defaultShell' | 'ptySpawn' | 'ptyWrite' | 'ptyResize' | 'ptyKill' | 'ptyAttach' | 'ptyDetach'
>;

export interface PtyProvider {
  spawn: (options: PtySpawnOptions, handlers: PtyHandlers) => Promise<PtyHandle>;
  /**
   * Take over an EXISTING pty — a shell handed to this window with its tab.
   * The backend resizes it to `grid` and then replays what it buffered, so
   * `handlers.onData` repaints the screen — in the geometry it is landing in
   * — before any new output arrives. Rejects with a `NOT_FOUND` IpcError when
   * that shell is gone, which the caller answers by spawning.
   */
  attach: (id: number, grid: PtyGrid, handlers: PtyHandlers) => Promise<PtyHandle>;
  defaultShell: () => Promise<string>;
}

const encoder = new TextEncoder();

/** A control message is a plain object; output is always an ArrayBuffer. */
function isControl(message: PtyMessage): message is Exclude<PtyMessage, ArrayBuffer> {
  return !(message instanceof ArrayBuffer) && typeof message === 'object' && 'type' in message;
}

/**
 * Tauri delivers small raw payloads through `eval` and large ones through its
 * fetch channel; both end up as an ArrayBuffer. The extra shapes are accepted
 * defensively so a runtime change degrades to slow rather than broken.
 */
export function toBytes(message: ArrayBuffer | Uint8Array | number[]): Uint8Array {
  if (message instanceof Uint8Array) return message;
  if (Array.isArray(message)) return Uint8Array.from(message);
  return new Uint8Array(message);
}

/** A pty with no columns is nonsense the Rust side would have to clamp anyway. */
export function normalizeSpawnOptions(options: PtySpawnOptions): PtySpawnArgs {
  return {
    cols: Math.max(1, Math.floor(options.cols)),
    rows: Math.max(1, Math.floor(options.rows)),
    ...(options.program ? { program: options.program } : {}),
    args: options.args ?? [],
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env ?? {},
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof IpcError && error.code === 'NOT_FOUND';
}

export function createTauriPtyProvider(
  ipc: PtyIpc = defaultIpc,
  createChannel: ChannelFactory = createIpcChannel,
): PtyProvider {
  return {
    defaultShell: () => ipc.defaultShell(),

    async spawn(options, handlers) {
      // Nothing is replayed into a shell that is starting now.
      const replay = { active: false };
      const channel = wire(createChannel(), handlers, replay);
      const id = await ipc.ptySpawn(normalizeSpawnOptions(options), channel);
      return handleFor(ipc, id, SPAWN_EPOCH, replay);
    },

    async attach(id, grid, handlers) {
      // Mute before the await, for the same reason spawn wires its channel
      // there: the backend replays from inside the attach call, so the first
      // replayed byte can arrive before this resolves.
      const replay = { active: true };
      const channel = wire(createChannel(), handlers, replay);
      try {
        const epoch = await ipc.ptyAttach(id, cells(grid.cols), cells(grid.rows), channel);
        return handleFor(ipc, id, epoch, replay);
      } catch (error) {
        // No replay is coming; leave nothing muted behind.
        replay.active = false;
        throw error;
      }
    },
  };
}

/** A grid dimension the Rust side would have to clamp anyway. */
function cells(n: number): number {
  return Math.max(1, Math.floor(n));
}

/**
 * Whether a handover replay is still being delivered on a pty's channel. One
 * object is shared by the channel that clears it and the handle that reads it.
 */
interface ReplayState {
  active: boolean;
}

/** Route one channel's messages at `handlers`. */
function wire(
  channel: Channel<PtyMessage>,
  handlers: PtyHandlers,
  replay: ReplayState,
): Channel<PtyMessage> {
  // Registered before the spawn/attach await so nothing the child prints in
  // its first milliseconds can be dropped.
  channel.onmessage = (message: PtyMessage) => {
    if (isControl(message)) {
      if (message.type === 'exit') handlers.onExit?.(message.code);
      // Everything after the marker is live, so the terminal may answer again.
      else if (message.type === 'replayEnd') replay.active = false;
      else handlers.onClose?.();
      return;
    }
    handlers.onData(toBytes(message));
  };
  return channel;
}

/** The epoch the backend gives the window that spawned a pty. */
const SPAWN_EPOCH = 0;

function handleFor(ipc: PtyIpc, id: number, epoch: number, replay: ReplayState): PtyHandle {
  /** A shell that exited on its own is already gone — not an error here. */
  const tolerateMissing = async (action: Promise<void>): Promise<void> => {
    try {
      await action;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  };
  return {
    id,
    // A dropped keystroke is a bug worth surfacing, so writes do not swallow
    // anything.
    write: (data) => ipc.ptyWrite(id, typeof data === 'string' ? encoder.encode(data) : data),

    // Unlike a keystroke, an unanswerable query is not worth surfacing: the
    // engine answers whatever the stream asked, including a shell that has
    // since exited.
    report: (data) => (replay.active ? Promise.resolve() : tolerateMissing(ipc.ptyWrite(id, data))),

    // Resize, kill and detach race with a shell exiting on its own — a window
    // resize a frame after the child died is normal, not an error.
    resize: (cols, rows) => tolerateMissing(ipc.ptyResize(id, cells(cols), cells(rows))),
    kill: () => tolerateMissing(ipc.ptyKill(id)),
    detach: () => tolerateMissing(ipc.ptyDetach(id, epoch)),
  };
}

let installed: PtyProvider | null = null;

export function setPtyProvider(provider: PtyProvider | null): void {
  installed = provider;
}

export function getPtyProvider(): PtyProvider {
  installed ??= createTauriPtyProvider();
  return installed;
}
