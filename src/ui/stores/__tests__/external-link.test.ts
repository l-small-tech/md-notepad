import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }));

import { externalLinkStore } from '../external-link';

beforeEach(() => {
  vi.useFakeTimers();
  openUrlMock.mockReset().mockResolvedValue(undefined);
  externalLinkStore.getState().dismiss();
});

afterEach(() => {
  externalLinkStore.getState().dismiss();
  vi.useRealTimers();
});

describe('externalLinkStore', () => {
  test('request holds the URL without opening anything', () => {
    externalLinkStore.getState().request('https://example.com');
    expect(externalLinkStore.getState().pending).toBe('https://example.com');
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  test('openPending hands the URL to the OS browser and clears the prompt', () => {
    externalLinkStore.getState().request('https://example.com');
    externalLinkStore.getState().openPending();
    expect(openUrlMock).toHaveBeenCalledWith('https://example.com');
    expect(externalLinkStore.getState().pending).toBeNull();
  });

  test('openPending with nothing pending opens nothing', () => {
    externalLinkStore.getState().openPending();
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  test('dismiss drops the URL unopened', () => {
    externalLinkStore.getState().request('https://example.com');
    externalLinkStore.getState().dismiss();
    expect(externalLinkStore.getState().pending).toBeNull();
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  test('an unanswered prompt clears itself instead of sitting there', () => {
    externalLinkStore.getState().request('https://example.com');
    vi.advanceTimersByTime(15_000);
    expect(externalLinkStore.getState().pending).toBeNull();
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  test('a second request restarts the auto-dismiss clock for the new URL', () => {
    externalLinkStore.getState().request('https://one.example');
    vi.advanceTimersByTime(14_000);
    externalLinkStore.getState().request('https://two.example');
    vi.advanceTimersByTime(14_000);
    expect(externalLinkStore.getState().pending).toBe('https://two.example');
  });
});
