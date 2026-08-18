/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { openUrlMock } = vi.hoisted(() => ({ openUrlMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: openUrlMock }));

import { installLinkGuard } from '../link-guard';
import { externalLinkStore } from '../stores/external-link';

let uninstall: () => void;

beforeEach(() => {
  openUrlMock.mockReset().mockResolvedValue(undefined);
  externalLinkStore.getState().dismiss();
  uninstall = installLinkGuard();
});

afterEach(() => {
  uninstall();
  externalLinkStore.getState().dismiss();
  document.body.innerHTML = '';
});

/** Dispatch `type` on `el`; returns true when the default was prevented. */
function fire(el: Element, type: 'click' | 'auxclick' = 'click'): boolean {
  return !el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
}

function anchor(href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = 'link';
  document.body.appendChild(a);
  return a;
}

describe('installLinkGuard', () => {
  test('an http(s) anchor never navigates and raises the confirmation prompt', () => {
    expect(fire(anchor('https://example.com/a'))).toBe(true);
    expect(externalLinkStore.getState().pending).toBe('https://example.com/a');
    expect(openUrlMock).not.toHaveBeenCalled(); // nothing opens without confirming
  });

  test('a click on content INSIDE an anchor is caught too', () => {
    const a = anchor('https://example.com');
    const strong = document.createElement('strong');
    a.textContent = '';
    a.appendChild(strong);
    expect(fire(strong)).toBe(true);
    expect(externalLinkStore.getState().pending).toBe('https://example.com');
  });

  test('a middle click is cancelled as well (it would open a new webview window)', () => {
    expect(fire(anchor('https://example.com'), 'auxclick')).toBe(true);
    expect(externalLinkStore.getState().pending).toBe('https://example.com');
  });

  test('non-http anchors are cancelled but inert — no prompt', () => {
    for (const href of ['mailto:a@b.com', '#heading']) {
      expect(fire(anchor(href))).toBe(true);
      expect(externalLinkStore.getState().pending).toBeNull();
    }
  });

  test('a click a closer handler already claimed is left alone', () => {
    const a = anchor('https://example.com');
    // Stand in for the preview pane, which owns its own link policy.
    a.addEventListener('click', (event) => event.preventDefault());
    fire(a);
    expect(externalLinkStore.getState().pending).toBeNull();
  });

  test('a click on a non-anchor is untouched', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(fire(div)).toBe(false);
    expect(externalLinkStore.getState().pending).toBeNull();
  });

  test('uninstalling stops the guard', () => {
    uninstall();
    expect(fire(anchor('https://example.com'))).toBe(false);
    expect(externalLinkStore.getState().pending).toBeNull();
  });
});
