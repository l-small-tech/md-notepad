/**
 * The pty provider seam.
 *
 * Everything above this layer (the terminal panes) talks to a `PtyProvider`,
 * never to `ipc` directly. On desktop that is the Tauri provider below; tests
 * install a fake. The same seam is where a future ssh/tmux backend would plug
 * in without the UI noticing. Android has no pty at all — nothing there ever
 * reaches this file (`isAndroid()` hides every entry point).
 */

import {
  IpcError,
  createIpcChannel,
  ipc as defaultIpc,
  type ChannelFactory,
  type Ipc,
  type PtyMessage,
  type PtySpawnArgs,
} from './commands';

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
  resize: (cols: number, rows: number) => Promise<void>;
  kill: () => Promise<void>;
}

/**
 * The slice of `Ipc` this provider actually calls. Narrow on purpose: a test
 * fake is five functions, not the whole filesystem surface.
 */
export type PtyIpc = Pick<Ipc, 'defaultShell' | 'ptySpawn' | 'ptyWrite' | 'ptyResize' | 'ptyKill'>;

export interface PtyProvider {
  spawn: (options: PtySpawnOptions, handlers: PtyHandlers) => Promise<PtyHandle>;
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
      const channel = createChannel();
      // Registered before the await so nothing the child prints in its first
      // milliseconds can be dropped.
      channel.onmessage = (message: PtyMessage) => {
        if (isControl(message)) {
          if (message.type === 'exit') handlers.onExit?.(message.code);
          else handlers.onClose?.();
          return;
        }
        handlers.onData(toBytes(message));
      };

      const id = await ipc.ptySpawn(normalizeSpawnOptions(options), channel);

      return {
        id,
        // A dropped keystroke is a bug worth surfacing, so writes do not
        // swallow anything.
        write: (data) => ipc.ptyWrite(id, typeof data === 'string' ? encoder.encode(data) : data),

        // Resize and kill race with a shell exiting on its own — a window
        // resize a frame after the child died is normal, not an error.
        resize: async (cols, rows) => {
          try {
            await ipc.ptyResize(id, Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        },
        kill: async () => {
          try {
            await ipc.ptyKill(id);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        },
      };
    },
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
