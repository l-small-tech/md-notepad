/**
 * EXPERIMENTAL e2e smoke test — launch, edit, relaunch, session restore.
 *
 * Runs the real compiled app through tauri-driver (see ../wdio.conf.ts for
 * setup and the warning about mutating real appdata session state). The
 * `.e2e.ts` suffix keeps these specs out of vitest's include glob
 * (`src/**\/__tests__/**\/*.test.ts`); the e2e/ dir is also outside the root
 * tsconfig's `include`, so only e2e/tsconfig.json typechecks this file.
 *
 * NON-GATING: the CI job running this is continue-on-error (tauri-driver is
 * pre-alpha). Keep the suite to one coarse happy path — it exists to prove
 * the app boots, accepts input, and restores its session, nothing more.
 */

import { browser, $, $$ } from '@wdio/globals';

/**
 * The active tab's CodeMirror content element. EditorHost mounts EVERY open
 * tab's editor simultaneously and hides inactive ones with `display: none`
 * (invariant I7 — editors are never remounted), so `$('.cm-content')` may
 * grab a hidden editor from a background tab. Filter by displayedness to get
 * the one the user is actually looking at.
 */
async function visibleEditor(): Promise<WebdriverIO.Element> {
  let found: WebdriverIO.Element | undefined;
  await browser.waitUntil(
    async () => {
      for (const editor of await $$('.cm-content')) {
        if (await editor.isDisplayed()) {
          found = editor;
          return true;
        }
      }
      return false;
    },
    { timeout: 20000, timeoutMsg: 'no visible .cm-content editor appeared' },
  );
  return found as WebdriverIO.Element;
}

describe('smoke: launch, type, relaunch, session restore', () => {
  // Unique per run so leftover session state from a previous run (the app
  // persists tabs to real appdata) can never produce a false positive.
  const MARKER = `e2e-smoke-marker-${Date.now()}`;

  it('launches with a window and a tab bar', async () => {
    // Session creation already launched the app via tauri-driver; these waits
    // cover the webview finishing its first render + session restore.
    await $('.tabbar').waitForExist({ timeout: 20000 });
    // At least one tab: a fresh install opens an untitled tab, a dirty
    // runner restores whatever a previous run left behind. Either is fine.
    await $('[role="tab"]').waitForExist({ timeout: 15000 });
  });

  it('accepts typing in the editor', async () => {
    // Fresh tab first (Ctrl+N = new-tab on Windows): first launch may have
    // restored previous tabs whose content/mode we do not control; a new tab
    // is guaranteed empty and opens in the shipped default 'raw' (CodeMirror)
    // mode. (A local run where you changed defaultMode to wysiwyg in Settings
    // would break this — CI always starts from pristine appdata.)
    await browser.keys(['Control', 'n']);

    // Focus CodeMirror by clicking its contenteditable surface, then type.
    // browser.keys(string) sends real key events — setValue() is unreliable
    // on contenteditable elements.
    const editor = await visibleEditor();
    await editor.click();
    await browser.keys(MARKER);

    // The typed marker must round-trip into the DOM.
    await browser.waitUntil(async () => (await editor.getText()).includes(MARKER), {
      timeout: 15000,
      timeoutMsg: `typed marker "${MARKER}" never appeared in the editor DOM`,
    });
  });

  it('restores the typed text after an app relaunch', async () => {
    // The session flusher debounces writes: idleMs 1000 / maxWaitMs 5000
    // (src/ui/session/flush-restore.ts). 6.5s > maxWait guarantees the tab
    // (content + manifest) reached disk before we kill the process.
    await browser.pause(6500);

    // reloadSession deletes the WebDriver session and starts a new one;
    // tauri-driver kills the app on delete and launches a fresh process for
    // the new session — a genuine quit + relaunch, not a page reload.
    await browser.reloadSession();

    // The relaunched app restores its session; the marker tab was active at
    // flush time, so it comes back as the active (visible) editor.
    const editor = await visibleEditor();
    await browser.waitUntil(async () => (await editor.getText()).includes(MARKER), {
      timeout: 15000,
      timeoutMsg: `marker "${MARKER}" was not restored after relaunch — session persistence broke`,
    });
  });
});
