import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WhisperModelStatus } from '../../../core/whisper-models';

const platform = vi.hoisted(() => ({ android: false }));
const settings = vi.hoisted(() => ({ whisperSetupOffered: false }));
const updates = vi.hoisted(() => [] as Record<string, unknown>[]);
const models = vi.hoisted(() => ({
  loaded: false,
  models: [] as WhisperModelStatus[],
  download: { kind: 'idle' } as { kind: string },
  refresh: vi.fn(),
  startDownload: vi.fn(),
}));

vi.mock('../../platform', () => ({ isAndroid: () => platform.android }));
vi.mock('../settings', () => ({
  settingsStore: {
    getState: () => ({
      settings,
      update: (partial: Record<string, unknown>) => {
        updates.push(partial);
        Object.assign(settings, partial);
      },
    }),
  },
}));
vi.mock('../whisper-models', () => ({
  whisperModelsStore: { getState: () => models },
}));

import { whisperSetupStore } from '../whisper-setup';

function model(id: string, installed: boolean): WhisperModelStatus {
  return {
    id,
    file: `ggml-${id}.bin`,
    label: id,
    bytes: 1,
    multilingual: false,
    installed,
    partialBytes: 0,
  };
}

const state = () => whisperSetupStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  whisperSetupStore.setState({ visible: false });
  platform.android = false;
  settings.whisperSetupOffered = false;
  updates.length = 0;
  models.loaded = false;
  models.models = [model('small.en-q5_1', false)];
  models.download = { kind: 'idle' };
  models.refresh.mockReset().mockImplementation(async () => {
    models.loaded = true;
  });
  models.startDownload.mockReset().mockImplementation(async () => {
    models.download = { kind: 'done' };
  });
});

describe('consider', () => {
  test('fetches the list once and shows the offer on a fresh desktop install', async () => {
    await state().consider();
    expect(models.refresh).toHaveBeenCalledTimes(1);
    expect(state().visible).toBe(true);
    await state().consider(); // idempotent while up
    expect(models.refresh).toHaveBeenCalledTimes(1);
  });

  test('stays hidden once offered, on Android, or when a model is installed', async () => {
    settings.whisperSetupOffered = true;
    await state().consider();
    expect(state().visible).toBe(false);

    settings.whisperSetupOffered = false;
    platform.android = true;
    await state().consider();
    expect(state().visible).toBe(false);

    platform.android = false;
    models.models = [model('tiny.en-q5_1', true)];
    await state().consider();
    expect(state().visible).toBe(false);
  });

  test('a list that never loads is no offer (the bar must not promise a download it cannot make)', async () => {
    models.refresh.mockImplementation(async () => {});
    await state().consider();
    expect(state().visible).toBe(false);
  });
});

describe('accept and decline', () => {
  test('accept marks the offer made, downloads the recommended model, and lingers on success', async () => {
    await state().consider();
    await state().accept();
    expect(updates).toEqual([{ whisperSetupOffered: true }]);
    expect(models.startDownload).toHaveBeenCalledWith('small.en-q5_1');
    expect(state().visible).toBe(true); // "ready" line is showing
    vi.advanceTimersByTime(8_000);
    expect(state().visible).toBe(false);
  });

  test('a failed download keeps the bar up for its Close / Open settings buttons', async () => {
    models.startDownload.mockImplementation(async () => {
      models.download = { kind: 'failed' };
    });
    await state().consider();
    await state().accept();
    vi.advanceTimersByTime(60_000);
    expect(state().visible).toBe(true);
    state().decline();
    expect(state().visible).toBe(false);
  });

  test('decline marks the offer made (once) and hides', async () => {
    await state().consider();
    state().decline();
    expect(state().visible).toBe(false);
    expect(updates).toEqual([{ whisperSetupOffered: true }]);
    state().decline();
    expect(updates).toHaveLength(1);
  });
});
