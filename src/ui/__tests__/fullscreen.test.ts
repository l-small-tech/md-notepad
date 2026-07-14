import { beforeEach, describe, expect, test, vi } from 'vitest';

// Control the runtime the fullscreen module sees. `vi.hoisted` gives the mock
// factory a mutable flag we can flip per test.
const platform = vi.hoisted(() => ({ android: false }));

vi.mock('../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform')>()),
  isAndroid: () => platform.android,
}));

// The OS-window side effects only fire on desktop's 'screen' boundary; stub the
// Tauri window so those paths are inert and the test needs no webview.
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    outerPosition: async () => ({ x: 0, y: 0 }),
    innerSize: async () => ({ width: 0, height: 0 }),
    isMaximized: async () => false,
    setFullscreen: async () => {},
    setPosition: async () => {},
    setSize: async () => {},
    maximize: async () => {},
  }),
}));

import { uiStore } from '../stores/ui';
import { cycleFullscreen, setFullscreen } from '../fullscreen';

const stage = () => uiStore.getState().fullscreenView;

beforeEach(() => {
  platform.android = false;
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
