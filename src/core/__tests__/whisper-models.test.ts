import { describe, expect, test } from 'vitest';
import {
  acceleratorLabel,
  captureLimitReached,
  concatPcm,
  downloadPercent,
  downloadReducer,
  formatBytes,
  IDLE_DOWNLOAD,
  isInstalled,
  LEGACY_MODEL_IDS,
  MAX_CAPTURE_SECONDS,
  migrateModelId,
  pcmSeconds,
  recommendedModel,
  shouldOfferSetup,
  speedHint,
  WHISPER_SAMPLE_RATE,
  type DownloadState,
  type WhisperModelStatus,
} from '../whisper-models';

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

describe('recommended model and install state', () => {
  test('a fresh install points at the quantized Small model', () => {
    expect(recommendedModel()).toBe('small.en-q5_1');
  });

  test('ids from the earlier manifest migrate to their replacement; others pass through', () => {
    expect(migrateModelId('small.en')).toBe('small.en-q5_1');
    expect(migrateModelId('tiny.en')).toBe('tiny.en-q5_1');
    expect(migrateModelId('medium.en-q5_0')).toBe('large-v3-turbo-q5_0');
    expect(migrateModelId('large-v3-turbo')).toBe('large-v3-turbo-q5_0');
    expect(migrateModelId('small.en-q5_1')).toBe('small.en-q5_1');
    expect(migrateModelId('mystery')).toBe('mystery');
    for (const id of Object.keys(LEGACY_MODEL_IDS)) {
      expect(LEGACY_MODEL_IDS[id]).toMatch(/-q5_/);
    }
  });

  test('isInstalled is per id and only true for a verified file', () => {
    const models = [model('tiny.en', false), model('small.en', true)];
    expect(isInstalled(models, 'small.en')).toBe(true);
    expect(isInstalled(models, 'tiny.en')).toBe(false);
    expect(isInstalled(models, 'nope')).toBe(false);
  });

  test('every model family has a speed hint, faster on a GPU; unknown ids get none', () => {
    for (const id of ['tiny.en-q5_1', 'base.en-q5_1', 'small.en-q5_1', 'large-v3-turbo-q5_0']) {
      expect(speedHint(id)).toMatch(/per 30 s/);
      expect(speedHint(id, true)).toMatch(/per 30 s/);
      expect(speedHint(id, true)).not.toBe(speedHint(id));
    }
    expect(speedHint('mystery')).toBe('');
  });

  test('the accelerator row names the GPU, or says why there is none', () => {
    expect(acceleratorLabel('vulkan', true)).toBe('GPU (Vulkan)');
    expect(acceleratorLabel('metal', true)).toBe('GPU (Metal)');
    expect(acceleratorLabel('vulkan', false)).toMatch(/GPU off/);
    expect(acceleratorLabel('none', true)).toMatch(/CPU only/);
  });
});

describe('shouldOfferSetup: the first-launch download offer', () => {
  const none = [model('small.en-q5_1', false)];
  test('offers once, on desktop, once the list is known and nothing is installed', () => {
    expect(shouldOfferSetup({ offered: false, android: false, loaded: true, models: none })).toBe(
      true,
    );
    expect(shouldOfferSetup({ offered: true, android: false, loaded: true, models: none })).toBe(
      false,
    );
    expect(shouldOfferSetup({ offered: false, android: true, loaded: true, models: none })).toBe(
      false,
    );
    expect(shouldOfferSetup({ offered: false, android: false, loaded: false, models: [] })).toBe(
      false,
    );
  });

  test('never when any model is already installed (an upgrade, a restored folder)', () => {
    const some = [model('tiny.en-q5_1', true), model('small.en-q5_1', false)];
    expect(shouldOfferSetup({ offered: false, android: false, loaded: true, models: some })).toBe(
      false,
    );
  });
});

describe('formatBytes', () => {
  test('picks the unit a person would', () => {
    expect(formatBytes(487_614_201)).toBe('488 MB');
    expect(formatBytes(1_533_774_781)).toBe('1.5 GB');
    expect(formatBytes(12_000_000_000)).toBe('12 GB');
    expect(formatBytes(32_166_155)).toBe('32 MB');
    expect(formatBytes(2_048)).toBe('2 KB');
    expect(formatBytes(12)).toBe('12 B');
  });

  test('garbage in, "0 B" out', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('downloadReducer', () => {
  const run = (actions: Parameters<typeof downloadReducer>[1][]): DownloadState =>
    actions.reduce(downloadReducer, IDLE_DOWNLOAD);

  test('the happy path: start → progress → verifying → done', () => {
    expect(run([{ type: 'start', id: 'small.en' }])).toEqual({
      kind: 'downloading',
      id: 'small.en',
      received: 0,
      total: 0,
    });
    const mid = run([
      { type: 'start', id: 'small.en' },
      { type: 'progress', received: 50, total: 200 },
    ]);
    expect(mid).toEqual({ kind: 'downloading', id: 'small.en', received: 50, total: 200 });
    expect(downloadPercent(mid)).toBe(25);
    const verifying = downloadReducer(mid, { type: 'verifying' });
    expect(verifying).toEqual({ kind: 'verifying', id: 'small.en' });
    expect(downloadPercent(verifying)).toBe(100);
    expect(downloadReducer(verifying, { type: 'done' })).toEqual({ kind: 'done', id: 'small.en' });
  });

  test('failure and cancellation keep the id and the code', () => {
    expect(
      run([
        { type: 'start', id: 'base.en' },
        { type: 'failed', code: 'WHISPER_DOWNLOAD_CORRUPT' },
      ]),
    ).toEqual({ kind: 'failed', id: 'base.en', code: 'WHISPER_DOWNLOAD_CORRUPT' });
    expect(run([{ type: 'start', id: 'base.en' }, { type: 'cancelled' }])).toEqual({
      kind: 'cancelled',
      id: 'base.en',
    });
  });

  test('a second start while one is active is ignored; a start after a terminal state is not', () => {
    const busy = run([
      { type: 'start', id: 'a' },
      { type: 'start', id: 'b' },
    ]);
    expect(busy).toMatchObject({ kind: 'downloading', id: 'a' });
    const again = run([
      { type: 'start', id: 'a' },
      { type: 'cancelled' },
      { type: 'start', id: 'b' },
    ]);
    expect(again).toMatchObject({ kind: 'downloading', id: 'b' });
  });

  test('late progress from a finished download cannot revive the bar', () => {
    const done = run([{ type: 'start', id: 'a' }, { type: 'done' }]);
    expect(downloadReducer(done, { type: 'progress', received: 1, total: 2 })).toBe(done);
    expect(downloadReducer(done, { type: 'verifying' })).toBe(done);
    expect(downloadReducer(IDLE_DOWNLOAD, { type: 'failed', code: 'X' })).toBe(IDLE_DOWNLOAD);
  });

  test('reset clears a terminal state but never an active one', () => {
    expect(downloadReducer({ kind: 'done', id: 'a' }, { type: 'reset' })).toBe(IDLE_DOWNLOAD);
    const active: DownloadState = { kind: 'downloading', id: 'a', received: 1, total: 2 };
    expect(downloadReducer(active, { type: 'reset' })).toBe(active);
  });

  test('percent is null without a total and clamps to 0..100', () => {
    expect(downloadPercent(IDLE_DOWNLOAD)).toBeNull();
    expect(downloadPercent({ kind: 'downloading', id: 'a', received: 5, total: 0 })).toBeNull();
    expect(downloadPercent({ kind: 'downloading', id: 'a', received: 500, total: 200 })).toBe(100);
  });
});

describe('capture limits', () => {
  test('ten minutes at 16 kHz is the cap', () => {
    expect(MAX_CAPTURE_SECONDS).toBe(600);
    expect(pcmSeconds(WHISPER_SAMPLE_RATE * 30, WHISPER_SAMPLE_RATE)).toBe(30);
    expect(captureLimitReached(WHISPER_SAMPLE_RATE * 600 - 1, WHISPER_SAMPLE_RATE)).toBe(false);
    expect(captureLimitReached(WHISPER_SAMPLE_RATE * 600, WHISPER_SAMPLE_RATE)).toBe(true);
  });

  test('concatPcm joins frames in order', () => {
    const joined = concatPcm([
      new Float32Array([1, 2]),
      new Float32Array([]),
      new Float32Array([3]),
    ]);
    expect(Array.from(joined)).toEqual([1, 2, 3]);
    expect(concatPcm([]).length).toBe(0);
  });

  test('a zero sample rate never trips the limit (and never divides by zero)', () => {
    expect(pcmSeconds(100, 0)).toBe(0);
    expect(captureLimitReached(1e9, 0)).toBe(false);
  });
});
