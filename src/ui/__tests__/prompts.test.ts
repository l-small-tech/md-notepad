/**
 * The Help… › Prompts catalog: well-formed entries whose text is the bundled
 * docs page, and the copy action's clipboard + notice behaviour.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

// prompts.ts reaches the session facade (whose module graph touches Tauri
// plugins); only `openDocs` is exercised, so stub the module.
vi.mock('../session', () => ({
  openDocs: vi.fn(),
}));

import { createMemoryClipboard, setClipboardProvider } from '../../ipc/clipboard';
import { openDocs } from '../session';
import { uiStore } from '../stores/ui';
import { PROMPTS, PROMPTS_DOC_PAGE, copyPrompt, openPromptsDocs, promptDocPage } from '../prompts';

describe('PROMPTS', () => {
  test('ids are unique and kebab-case, labels and titles are set', () => {
    const ids = PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const prompt of PROMPTS) {
      expect(prompt.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(prompt.label.length).toBeGreaterThan(0);
      expect(prompt.title.length).toBeGreaterThan(0);
    }
  });

  test('the Marp prompt carries the themable-board contract the app recognises', () => {
    const prompt = PROMPTS.find((p) => p.id === 'theme-marp-deck');
    expect(prompt).toBeDefined();
    const { text } = prompt!;
    // The root class core/whiteboard/theme-inject.ts looks for, the opt-out
    // token it honours, and every palette variable the app injects.
    expect(text).toContain('class="wb-board"');
    expect(text).toContain('wb-fixed');
    for (const name of ['--wb-bg', '--wb-c0', '--wb-c7']) {
      expect(text).toContain(name);
    }
    // The blank the user fills in, and the deck-side rule that keeps the
    // theme's own variables untouched.
    expect(text).toContain('[path to the .md file]');
    expect(text).toMatch(/Never define/);
  });

  test('every prompt names its own docs page', () => {
    for (const prompt of PROMPTS) {
      expect(promptDocPage(prompt)).toBe(`prompts/${prompt.id}.md`);
    }
    expect(PROMPTS_DOC_PAGE).toBe('prompts.md');
  });
});

describe('copyPrompt', () => {
  beforeEach(() => {
    uiStore.getState().clearNotice();
    vi.mocked(openDocs).mockClear();
  });

  test('writes the text to the clipboard and shows a notice', async () => {
    const clipboard = createMemoryClipboard();
    setClipboardProvider(clipboard);
    const prompt = PROMPTS[0]!;
    await copyPrompt(prompt);
    expect(await clipboard.read()).toBe(prompt.text);
    expect(uiStore.getState().notice).toMatch(/copied/i);
  });

  test('a refusing clipboard is reported, not thrown', async () => {
    setClipboardProvider({
      read: () => Promise.resolve(''),
      write: () => Promise.reject(new Error('denied')),
    });
    await expect(copyPrompt(PROMPTS[0]!)).resolves.toBeUndefined();
    expect(uiStore.getState().notice).toMatch(/could not copy/i);
  });
});

describe('openPromptsDocs', () => {
  test("opens the guide, or one prompt's page", () => {
    openPromptsDocs();
    expect(openDocs).toHaveBeenLastCalledWith('prompts.md');
    openPromptsDocs(PROMPTS[0]!);
    expect(openDocs).toHaveBeenLastCalledWith('prompts/theme-marp-deck.md');
  });
});
