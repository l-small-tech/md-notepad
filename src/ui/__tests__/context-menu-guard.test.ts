/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { installContextMenuGuard } from '../context-menu-guard';

let uninstall: () => void;

beforeEach(() => {
  uninstall = installContextMenuGuard();
});

afterEach(() => {
  uninstall();
  document.body.innerHTML = '';
});

/** Right-click `el`; returns true when the webview's own menu was cancelled. */
function rightClick(el: Element): boolean {
  return !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

/** `html` appended to the body; returns the element matching `selector`. */
function mount(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.body.querySelector(selector)!;
}

describe('installContextMenuGuard', () => {
  test('app chrome — the window-control buttons — never gets the native menu', () => {
    const button = mount(
      '<div class="window-controls"><button class="wc-btn" aria-label="Minimize"><svg></svg></button></div>',
      'svg',
    );
    expect(rightClick(button)).toBe(true);
  });

  test('a plain element with no menu of its own is swallowed', () => {
    expect(rightClick(mount('<div class="statusbar">Ln 1</div>', '.statusbar'))).toBe(true);
  });

  test('inputs and textareas keep the native copy/paste menu', () => {
    expect(rightClick(mount('<input value="x" />', 'input'))).toBe(false);
    expect(rightClick(mount('<textarea></textarea>', 'textarea'))).toBe(false);
  });

  test('a contenteditable editor keeps it, including deep inside its subtree', () => {
    const span = mount('<div contenteditable="true"><p><span>text</span></p></div>', 'span');
    expect(rightClick(span)).toBe(false);
  });

  test('a non-editable island inside an editor still counts as editable', () => {
    const widget = mount(
      '<div contenteditable="true"><span contenteditable="false">widget</span></div>',
      '[contenteditable="false"]',
    );
    expect(rightClick(widget)).toBe(false);
  });

  test('contenteditable="false" on its own is chrome, not text entry', () => {
    expect(rightClick(mount('<div contenteditable="false">x</div>', 'div'))).toBe(true);
  });

  test('a surface that owns the right-click is left alone', () => {
    const own = mount('<div class="tabbar"></div>', '.tabbar');
    // The app's own handler runs first and opens its menu; the guard must not
    // treat that as its business (it stays prevented either way).
    own.addEventListener('contextmenu', (e) => e.preventDefault());
    expect(rightClick(own)).toBe(true);
  });

  test('uninstalling restores the default', () => {
    uninstall();
    expect(rightClick(mount('<div class="statusbar"></div>', '.statusbar'))).toBe(false);
  });
});
