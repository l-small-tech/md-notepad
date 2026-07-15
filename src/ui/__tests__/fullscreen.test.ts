import { beforeEach, describe, expect, test, vi } from 'vitest';

// Control the runtime the fullscreen module sees. `vi.hoisted` gives the mock
// factory a mutable flag we can flip per test.
const platform = vi.hoisted(() => ({ android: false }));

vi.mock('../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform')>()),
  isAndroid: () => platform.android,
}));

// The OS-window side effects only fire on desktop's 'screen' boundary; stub the
// Tauri window so those paths are inert and the test needs no webview. `os`
// records the order (and target) of setFullscreen calls plus an artificial
// delay before the geometry reads an `enter` awaits, so a test can provoke the
// enter/exit race the serialization fixes.
const os = vi.hoisted(() => ({ calls: [] as boolean[], enterDelayMs: 0 }));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => {
      if (os.enterDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, os.enterDelayMs));
      }
      return { x: 0, y: 0 };
    },
    innerSize: async () => ({ width: 0, height: 0 }),
    isMaximized: async () => false,
    setFullscreen: async (value: boolean) => {
      os.calls.push(value);
    },
    setPosition: async () => {},
    setSize: async () => {},
    maximize: async () => {},
  }),
}));

import { uiStore } from '../stores/ui';
import { cycleFullscreen, setFullscreen } from '../fullscreen';

const stage = () => uiStore.getState().fullscreenView;

/**
 * Let the serialized OS-transition chain drain. Transitions are fire-and-forget
 * from apply()'s view, so wait out the (mocked) enter delay plus the exit's
 * single geometry-restore tick before asserting on the final OS state.
 */
async function drainOsTransitions(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, os.enterDelayMs * 3 + 200));
}

beforeEach(async () => {
  // The op chain is module-level state: wait out any transitions a prior test
  // fire-and-forgot before clearing the recorder, so they can't leak into the
  // next test's `os.calls`.
  await drainOsTransitions();
  platform.android = false;
  os.calls.length = 0;
  os.enterDelayMs = 0;
  uiStore.getState().setFullscreenView('normal');
});

describe('fullscreen stages — desktop', () => {
  test('setFullscreen keeps all three stages reachable', () => {
    setFullscreen('window');
    expect(stage()).toBe('window');
    setFullscreen('screen');
    expect(stage()).toBe('screen');
    setFullscreen('normal');
    expect(stage()).toBe('normal');
  });

  test('cycle advances normal → window → screen → normal', () => {
    cycleFullscreen();
    expect(stage()).toBe('window');
    cycleFullscreen();
    expect(stage()).toBe('screen');
    cycleFullscreen();
    expect(stage()).toBe('normal');
  });
});

describe('OS-fullscreen transitions are serialized (rapid toggles)', () => {
  test('an exit that follows a slow enter still lands last (window not stranded)', async () => {
    // The enter awaits geometry reads (delayed) before setFullscreen(true).
    // Fire-and-forget, an interleaved exit's setFullscreen(false) could win the
    // race and leave the OS fullscreen while the UI shows chrome; serialized,
    // the exit runs only after the enter completes, so false lands last.
    os.enterDelayMs = 30;
    setFullscreen('screen');
    setFullscreen('normal');
    await drainOsTransitions();

    expect(stage()).toBe('normal');
    expect(os.calls).toEqual([true, false]);
    expect(os.calls.at(-1)).toBe(false);
  });

  test('the final OS state matches the latest requested UI stage', async () => {
    os.enterDelayMs = 20;
    setFullscreen('screen');
    setFullscreen('normal');
    setFullscreen('screen');
    await drainOsTransitions();

    expect(stage()).toBe('screen');
    expect(os.calls.at(-1)).toBe(true);
  });
});

describe('fullscreen stages — Android (single stage)', () => {
  beforeEach(() => {
    platform.android = true;
  });

  test("a 'screen' request folds back to 'window'", () => {
    setFullscreen('screen');
    expect(stage()).toBe('window');
  });

  test('cycle is just normal ⇄ window (skips screen)', () => {
    cycleFullscreen();
    expect(stage()).toBe('window');
    cycleFullscreen();
    expect(stage()).toBe('normal');
  });
});
