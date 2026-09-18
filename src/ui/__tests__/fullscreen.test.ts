import { beforeEach, describe, expect, test, vi } from 'vitest';

// Control the runtime the fullscreen module sees. `vi.hoisted` gives the mock
// factory a mutable flag we can flip per test.
const platform = vi.hoisted(() => ({ android: false }));

vi.mock('../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform')>()),
  isAndroid: () => platform.android,
}));

// The OS-window side effects only fire on desktop's full-screen boundary; stub
// the Tauri window so those paths are inert and the test needs no webview.
// `os` records the order of every window call that matters (setFullscreen
// targets, unmaximize/maximize) plus an artificial delay in the state read an
// `enter` awaits first, so a test can provoke the enter/exit race the
// serialization fixes.
const os = vi.hoisted(() => ({
  calls: [] as (boolean | 'unmaximize' | 'maximize')[],
  enterDelayMs: 0,
  maximized: false,
}));

vi.mock('@tauri-apps/api/window', () => ({
  // Reports a monitor the (mocked) window already fills, so the post-enter
  // bounds check is satisfied on its first look.
  currentMonitor: async () => ({ position: { x: 0, y: 0 }, size: { width: 0, height: 0 } }),
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: 0, y: 0 }),
    innerSize: async () => ({ width: 0, height: 0 }),
    isMaximized: async () => {
      if (os.enterDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, os.enterDelayMs));
      }
      return os.maximized;
    },
    setFullscreen: async (value: boolean) => {
      os.calls.push(value);
    },
    setPosition: async () => {},
    setSize: async () => {},
    maximize: async () => {
      os.calls.push('maximize');
    },
    unmaximize: async () => {
      os.calls.push('unmaximize');
    },
  }),
}));

import { uiStore } from '../stores/ui';
import {
  escapeFullscreen,
  setDistractionFree,
  setOsFullscreen,
  toggleDistractionFree,
  toggleFullscreen,
} from '../fullscreen';

const distractionFree = () => uiStore.getState().distractionFree;
const osFullscreen = () => uiStore.getState().osFullscreen;

/**
 * Let the serialized OS-transition chain drain. Transitions are fire-and-forget
 * from the toggles' view, so wait out the (mocked) enter delay before
 * asserting on the final OS state.
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
  os.maximized = false;
  uiStore.getState().setDistractionFree(false);
  uiStore.getState().setOsFullscreen(false);
});

describe('two independent toggles — desktop', () => {
  test('full screen (F11) never touches the chrome', async () => {
    toggleFullscreen();
    expect(osFullscreen()).toBe(true);
    expect(distractionFree()).toBe(false);
    toggleFullscreen();
    expect(osFullscreen()).toBe(false);
    await drainOsTransitions();
    expect(os.calls).toEqual([true, false]);
  });

  test('distraction-free never touches the OS window', async () => {
    toggleDistractionFree();
    expect(distractionFree()).toBe(true);
    expect(osFullscreen()).toBe(false);
    toggleDistractionFree();
    expect(distractionFree()).toBe(false);
    await drainOsTransitions();
    expect(os.calls).toEqual([]);
  });

  test('both can be on at once, and each is left independently', () => {
    setDistractionFree(true);
    setOsFullscreen(true);
    expect(distractionFree()).toBe(true);
    expect(osFullscreen()).toBe(true);

    setDistractionFree(false);
    expect(osFullscreen()).toBe(true);
    setOsFullscreen(false);
    expect(distractionFree()).toBe(false);
  });

  test('setting a flag to its current value is a no-op for the OS window', async () => {
    setOsFullscreen(true);
    setOsFullscreen(true);
    await drainOsTransitions();
    expect(os.calls).toEqual([true]);
  });
});

describe('Escape leaves the innermost view first', () => {
  test('distraction-free goes first, full screen second, then Escape is not ours', () => {
    setOsFullscreen(true);
    setDistractionFree(true);

    expect(escapeFullscreen()).toBe(true);
    expect(distractionFree()).toBe(false);
    expect(osFullscreen()).toBe(true);

    expect(escapeFullscreen()).toBe(true);
    expect(osFullscreen()).toBe(false);

    expect(escapeFullscreen()).toBe(false);
  });
});

describe('a maximized window is restored before going fullscreen (Windows taskbar strip)', () => {
  test('enter unmaximizes first; exit re-maximizes after leaving', async () => {
    os.maximized = true;
    setOsFullscreen(true);
    await drainOsTransitions();
    expect(os.calls).toEqual(['unmaximize', true]);

    setOsFullscreen(false);
    await drainOsTransitions();
    expect(os.calls).toEqual(['unmaximize', true, false, 'maximize']);
  });

  test('a free-floating window is not unmaximized', async () => {
    setOsFullscreen(true);
    await drainOsTransitions();
    expect(os.calls).toEqual([true]);
  });
});

describe('OS-fullscreen transitions are serialized (rapid toggles)', () => {
  test('an exit that follows a slow enter still lands last (window not stranded)', async () => {
    // The enter awaits a state read (delayed) before setFullscreen(true).
    // Fire-and-forget, an interleaved exit's setFullscreen(false) could win the
    // race and leave the OS fullscreen while the UI says otherwise;
    // serialized, the exit runs only after the enter completes, so false
    // lands last.
    os.enterDelayMs = 30;
    setOsFullscreen(true);
    setOsFullscreen(false);
    await drainOsTransitions();

    expect(osFullscreen()).toBe(false);
    expect(os.calls).toEqual([true, false]);
  });

  test('the final OS state matches the latest requested flag', async () => {
    os.enterDelayMs = 20;
    setOsFullscreen(true);
    setOsFullscreen(false);
    setOsFullscreen(true);
    await drainOsTransitions();

    expect(osFullscreen()).toBe(true);
    expect(os.calls.at(-1)).toBe(true);
  });
});

describe('going distraction-free clears what it is meant to hide', () => {
  test('the side panels close on the way in, and only on the way in', () => {
    uiStore.getState().openExplorer();
    uiStore.getState().openOutline();

    setDistractionFree(true);
    expect(uiStore.getState().explorerOpen).toBe(false);
    expect(uiStore.getState().outlineOpen).toBe(false);

    // Opened FROM distraction-free (the tap-and-hold menu's job), a panel must
    // survive an unrelated full-screen change — the CSS no longer hides it.
    uiStore.getState().openOutline();
    setOsFullscreen(true);
    expect(uiStore.getState().outlineOpen).toBe(true);
  });

  test('full screen alone leaves the panels exactly as they were', () => {
    uiStore.getState().openExplorer();
    setOsFullscreen(true);
    expect(uiStore.getState().explorerOpen).toBe(true);
  });

  test('the tap-and-hold menu never outlives the view it was summoned from', () => {
    setDistractionFree(true);
    uiStore.getState().openFullscreenMenu({ x: 10, y: 20 });
    expect(uiStore.getState().fullscreenMenu).toEqual({ x: 10, y: 20 });

    setDistractionFree(false);
    expect(uiStore.getState().fullscreenMenu).toBeNull();
  });
});

describe('Android has no OS full screen', () => {
  beforeEach(() => {
    platform.android = true;
  });

  test('a full-screen request folds into distraction-free', async () => {
    setOsFullscreen(true);
    expect(distractionFree()).toBe(true);
    expect(osFullscreen()).toBe(false);
    await drainOsTransitions();
    expect(os.calls).toEqual([]);
  });

  test('F11 (the palette command) toggles distraction-free', () => {
    toggleFullscreen();
    expect(distractionFree()).toBe(true);
    toggleFullscreen();
    expect(distractionFree()).toBe(false);
  });
});
