import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WhisperModelStatus } from '../../../core/whisper-models';

/** A stand-in for Tauri's Channel: the store sets `onmessage`, the test pushes. */
class FakeChannel {
  onmessage: (event: unknown) => void = () => {};
}

const ipc = vi.hoisted(() => ({
  whisperModelsList: vi.fn(),
  whisperModelDownload: vi.fn(),
  whisperModelCancel: vi.fn(),
  whisperModelDelete: vi.fn(),
  whisperModelDir: vi.fn(),
}));
const channels = vi.hoisted(() => [] as { onmessage: (event: unknown) => void }[]);
const opener = vi.hoisted(() => ({ openPath: vi.fn() }));
const notices = vi.hoisted(() => [] as string[]);

vi.mock('../../../ipc/commands', () => ({
  ipc,
  IpcError: class IpcError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  createWhisperChannel: () => {
    const c = new FakeChannel();
    channels.push(c);
    return c;
  },
}));
vi.mock('@tauri-apps/plugin-opener', () => opener);
vi.mock('../ui', () => ({
  uiStore: { getState: () => ({ showNotice: (text: string) => notices.push(text) }) },
}));

import { IpcError } from '../../../ipc/commands';
import { whisperModelsStore } from '../whisper-models';

function model(id: string, installed: boolean): WhisperModelStatus {
  return {
    id,
    file: `ggml-${id}.bin`,
    label: id,
    bytes: 100,
    multilingual: false,
    quantized: false,
    installed,
    partialBytes: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const state = () => whisperModelsStore.getState();

beforeEach(() => {
  whisperModelsStore.setState({ models: [], loaded: false, dir: null, download: { kind: 'idle' } });
  channels.length = 0;
  notices.length = 0;
  ipc.whisperModelsList.mockReset().mockResolvedValue([model('small.en', false)]);
  ipc.whisperModelDownload.mockReset();
  ipc.whisperModelCancel.mockReset().mockResolvedValue(undefined);
  ipc.whisperModelDelete.mockReset().mockResolvedValue(undefined);
  ipc.whisperModelDir.mockReset().mockResolvedValue('C:/app/whisper');
  opener.openPath.mockReset().mockResolvedValue(undefined);
});

describe('refresh', () => {
  test('loads the list and marks it loaded; a failure keeps the old list', async () => {
    await state().refresh();
    expect(state().loaded).toBe(true);
    expect(state().models.map((m) => m.id)).toEqual(['small.en']);

    ipc.whisperModelsList.mockRejectedValueOnce(new Error('not registered'));
    await state().refresh();
    expect(state().models.map((m) => m.id)).toEqual(['small.en']);
  });
});

describe('startDownload', () => {
  test('drives the reducer from the channel and refreshes when done', async () => {
    const dl = deferred<void>();
    ipc.whisperModelDownload.mockReturnValue(dl.promise);
    ipc.whisperModelsList.mockResolvedValue([model('small.en', true)]);

    const run = state().startDownload('small.en');
    await settle();
    expect(state().download).toEqual({
      kind: 'downloading',
      id: 'small.en',
      received: 0,
      total: 0,
    });
    expect(ipc.whisperModelDownload).toHaveBeenCalledWith('small.en', channels[0]);

    channels[0]!.onmessage({ kind: 'progress', received: 40, total: 100 });
    expect(state().download).toMatchObject({ kind: 'downloading', received: 40, total: 100 });
    channels[0]!.onmessage({ kind: 'verifying' });
    expect(state().download).toEqual({ kind: 'verifying', id: 'small.en' });

    dl.resolve();
    await run;
    expect(state().download).toEqual({ kind: 'done', id: 'small.en' });
    expect(state().models[0]?.installed).toBe(true);
  });

  test('a cancel rejection ends as cancelled, any other as failed with its code', async () => {
    ipc.whisperModelDownload.mockRejectedValueOnce(
      new IpcError('WHISPER_DOWNLOAD_CANCELLED', 'cancelled'),
    );
    await state().startDownload('base.en');
    expect(state().download).toEqual({ kind: 'cancelled', id: 'base.en' });

    state().dismiss();
    expect(state().download).toEqual({ kind: 'idle' });

    ipc.whisperModelDownload.mockRejectedValueOnce(new IpcError('WHISPER_DOWNLOAD_CORRUPT', 'x'));
    await state().startDownload('base.en');
    expect(state().download).toEqual({
      kind: 'failed',
      id: 'base.en',
      code: 'WHISPER_DOWNLOAD_CORRUPT',
    });

    ipc.whisperModelDownload.mockRejectedValueOnce(new Error('network down'));
    await state().startDownload('base.en');
    expect(state().download).toMatchObject({ kind: 'failed', code: 'WHISPER_DOWNLOAD_FAILED' });
  });

  test('a second download while one runs is refused without touching the backend', async () => {
    ipc.whisperModelDownload.mockReturnValue(new Promise<void>(() => {}));
    void state().startDownload('small.en');
    await settle();
    await state().startDownload('base.en');
    expect(ipc.whisperModelDownload).toHaveBeenCalledTimes(1);
    expect(state().download).toMatchObject({ kind: 'downloading', id: 'small.en' });
  });

  test('cancelDownload asks the backend; the channel result settles the state', async () => {
    const dl = deferred<void>();
    ipc.whisperModelDownload.mockReturnValue(dl.promise);
    void state().startDownload('small.en');
    await settle();
    state().cancelDownload();
    expect(ipc.whisperModelCancel).toHaveBeenCalledTimes(1);
    expect(state().download.kind).toBe('downloading'); // until Rust confirms
    dl.reject(new IpcError('WHISPER_DOWNLOAD_CANCELLED', 'cancelled'));
    await settle();
    expect(state().download).toEqual({ kind: 'cancelled', id: 'small.en' });
  });
});

describe('remove and openFolder', () => {
  test('remove deletes then refreshes; a failure shows a notice', async () => {
    ipc.whisperModelsList.mockResolvedValue([model('small.en', false)]);
    await state().remove('small.en');
    expect(ipc.whisperModelDelete).toHaveBeenCalledWith('small.en');
    expect(state().loaded).toBe(true);

    ipc.whisperModelDelete.mockRejectedValueOnce(new Error('locked'));
    await state().remove('small.en');
    expect(notices).toEqual(['Could not delete the model file.']);
  });

  test('openFolder resolves the dir once and opens it', async () => {
    await state().openFolder();
    await state().openFolder();
    expect(ipc.whisperModelDir).toHaveBeenCalledTimes(1);
    expect(opener.openPath).toHaveBeenCalledWith('C:/app/whisper');
    expect(state().dir).toBe('C:/app/whisper');
  });
});
