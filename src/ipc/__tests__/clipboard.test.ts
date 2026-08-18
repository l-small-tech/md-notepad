import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDomClipboard,
  createMemoryClipboard,
  createTauriClipboard,
  getClipboard,
  setClipboardProvider,
} from '../clipboard';

const plugin = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string | null>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => plugin);

/** Install a fake `navigator.clipboard` and hand back its state. */
function fakeNavigatorClipboard(
  behavior: { read?: () => Promise<string>; write?: () => void } = {},
) {
  const state = { text: '', writes: 0 };
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      readText: behavior.read ?? (() => Promise.resolve(state.text)),
      writeText: (text: string) => {
        state.writes++;
        behavior.write?.();
        state.text = text;
        return Promise.resolve();
      },
    },
  });
  return state;
}

afterEach(() => {
  setClipboardProvider(null);
  vi.clearAllMocks();
});

describe('createMemoryClipboard', () => {
  it('reads back what it writes', async () => {
    const clipboard = createMemoryClipboard('seed');
    expect(await clipboard.read()).toBe('seed');
    await clipboard.write('next');
    expect(await clipboard.read()).toBe('next');
  });
});

describe('createDomClipboard', () => {
  it('goes through navigator.clipboard', async () => {
    const state = fakeNavigatorClipboard();
    const clipboard = createDomClipboard();
    await clipboard.write('copied');
    expect(state.text).toBe('copied');
    expect(await clipboard.read()).toBe('copied');
  });
});

describe('createTauriClipboard', () => {
  it('prefers the plugin over the web view', async () => {
    const state = fakeNavigatorClipboard();
    plugin.readText.mockResolvedValue('from plugin');
    plugin.writeText.mockResolvedValue(undefined);
    const clipboard = createTauriClipboard();
    await clipboard.write('out');
    expect(plugin.writeText).toHaveBeenCalledWith('out');
    expect(state.writes).toBe(0);
    expect(await clipboard.read()).toBe('from plugin');
  });

  it('falls back to the web view when the plugin is not there', async () => {
    // What `pnpm dev` in a browser gets, and what a build missing the plugin
    // would get: neither should leave the user without a clipboard.
    const state = fakeNavigatorClipboard();
    plugin.readText.mockRejectedValue(new Error('no plugin'));
    plugin.writeText.mockRejectedValue(new Error('no plugin'));
    const clipboard = createTauriClipboard();
    await clipboard.write('out');
    expect(state.text).toBe('out');
    expect(await clipboard.read()).toBe('out');
  });

  it('reads an empty clipboard as empty rather than throwing', async () => {
    // WebKitGTK rejects a read it will not permit, and some platforms reject an
    // empty clipboard outright. Neither is an error worth raising mid-keystroke.
    fakeNavigatorClipboard({ read: () => Promise.reject(new Error('denied')) });
    plugin.readText.mockRejectedValue(new Error('empty'));
    expect(await createTauriClipboard().read()).toBe('');
  });

  it('null from the plugin is an empty clipboard, not a crash', async () => {
    plugin.readText.mockResolvedValue(null);
    expect(await createTauriClipboard().read()).toBe('');
  });
});

describe('getClipboard', () => {
  it('hands back the installed provider', async () => {
    const memory = createMemoryClipboard('installed');
    setClipboardProvider(memory);
    expect(getClipboard()).toBe(memory);
    expect(await getClipboard().read()).toBe('installed');
  });
});
