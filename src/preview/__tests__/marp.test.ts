/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { readFileBase64Mock, readTextFileMock } = vi.hoisted(() => ({
  readFileBase64Mock: vi.fn(),
  readTextFileMock: vi.fn(),
}));
vi.mock('../../ipc/commands', () => ({
  ipc: { readFileBase64: readFileBase64Mock, readTextFile: readTextFileMock },
}));

import {
  createImageResolver,
  inlineDeckImages,
  mountSlide,
  renderDeck,
  resetMarpForTests,
} from '../marp';

const DECK = ['---', 'marp: true', '---', '# One', '', '<!-- say hi -->', '', '---', '# Two'].join(
  '\n',
);

beforeEach(() => {
  readFileBase64Mock.mockReset().mockResolvedValue('QUJD');
  readTextFileMock.mockReset().mockResolvedValue({ text: '', mtimeMs: 0 });
});

afterEach(() => {
  resetMarpForTests();
});

describe('renderDeck', () => {
  test('one inline-SVG slide per ruler, with the speaker notes and the slide size', async () => {
    const deck = await renderDeck(DECK);
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0]!.html).toMatch(/^<svg data-marpit-svg=""/);
    expect(deck.slides[0]!.html).toContain('<h1 id="one">One</h1>');
    expect(deck.slides[0]!.notes).toEqual(['say hi']);
    expect(deck.slides[1]!.notes).toEqual([]);
    expect(deck.width).toBe(1280);
    expect(deck.height).toBe(720);
    expect(deck.css).toContain('div.marpit > svg > foreignObject > section');
  });

  test('author HTML passes the allowlist: layout markup stays, scripts and handlers do not', async () => {
    const deck = await renderDeck(
      [
        '---',
        'marp: true',
        '---',
        '<script>alert(1)</script>',
        '',
        '<div class="cols"><p class="kicker" style="color:#9a6a16" onclick="alert(2)">Kicker</p></div>',
        '',
        '<a href="javascript:alert(3)">x</a> <iframe src="https://example.com"></iframe>',
      ].join('\n'),
    );
    const html = deck.slides[0]!.html;
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<div class="cols">');
    expect(html).toContain('<p class="kicker" style="color:#9a6a16">Kicker</p>');
    expect(html).not.toContain('&lt;div');
  });

  test('a theme file beside the document registers under its @theme name', async () => {
    readTextFileMock.mockResolvedValue({
      text: '/* @theme brand */\n@import "default";\nsection { background: #123456; }',
      mtimeMs: 0,
    });
    const deck = await renderDeck('---\nmarp: true\ntheme: ./themes/brand.css\n---\n# Hi', {
      docPath: '/talks/deck.md',
    });
    expect(readTextFileMock).toHaveBeenCalledWith('/talks/themes/brand.css');
    expect(deck.slides[0]!.html).toContain('data-theme="brand"');
    expect(deck.css).toContain('#123456');
  });

  test('a missing theme file falls back to the default theme', async () => {
    readTextFileMock.mockRejectedValue(new Error('ENOENT'));
    const deck = await renderDeck('---\nmarp: true\ntheme: ./nope.css\n---\n# Hi', {
      docPath: '/talks/deck.md',
    });
    expect(deck.slides).toHaveLength(1);
    expect(deck.slides[0]!.html).not.toContain('data-theme="nope"');
  });

  test('a half-written document still renders (never breaks mid-edit)', async () => {
    const deck = await renderDeck('---\nmarp: true\n---\n# One\n\n---\n\n```js\nconst x =');
    expect(deck.slides).toHaveLength(2);
  });
});

describe('mountSlide', () => {
  test('puts the theme and the slide into a shadow root once, and reuses both', () => {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    expect(mountSlide(root, '.a{}', '<svg data-marpit-svg="">1</svg>')).toBe(true);
    const style = root.querySelector('style')!;
    const stage = root.querySelector('div.marpit')!;
    expect(style.textContent).toContain('.a{}');
    expect(style.textContent).toContain(':host { all: initial');
    expect(stage.innerHTML).toBe('<svg data-marpit-svg="">1</svg>');
    // Same markup: nothing is touched (no flash while an agent writes).
    expect(mountSlide(root, '.a{}', '<svg data-marpit-svg="">1</svg>')).toBe(false);
    expect(root.querySelector('style')).toBe(style);
    expect(root.querySelector('div.marpit')).toBe(stage);
    // New markup replaces the slide in place, keeping the elements.
    expect(mountSlide(root, '.b{}', '<svg data-marpit-svg="">2</svg>')).toBe(true);
    expect(root.querySelector('div.marpit')).toBe(stage);
    expect(stage.innerHTML).toBe('<svg data-marpit-svg="">2</svg>');
    expect(style.textContent).toContain('.b{}');
  });
});

describe('inlineDeckImages', () => {
  test('inlines local <img> sources and url() backgrounds, leaving the rest alone', async () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<img src="./a.png"><img src="https://x/y.png">' +
      '<figure style="background-image:url(&quot;./bg.jpg&quot;);"></figure>' +
      '<section style="background-image:url(data:image/png;base64,AAA)"></section>';
    const seen: string[] = [];
    await inlineDeckImages(root, '/talks', async (abs) => {
      seen.push(abs);
      return `data:x;base64,${abs.length}`;
    });
    expect(seen).toEqual(['/talks/a.png', '/talks/bg.jpg']);
    const imgs = root.querySelectorAll('img');
    expect(imgs[0]!.getAttribute('src')).toBe('data:x;base64,12');
    expect(imgs[1]!.getAttribute('src')).toBe('https://x/y.png');
    expect(root.querySelector('figure')!.getAttribute('style')).toBe(
      'background-image:url("data:x;base64,13");',
    );
    expect(root.querySelector('section')!.getAttribute('style')).toContain('base64,AAA');
  });

  test('does nothing for an unsaved document (no directory)', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<img src="./a.png">';
    const resolve = vi.fn();
    await inlineDeckImages(root, null, resolve);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('createImageResolver', () => {
  test('reads each image once, and remembers a miss', async () => {
    const resolve = createImageResolver();
    expect(await resolve('/t/a.png')).toBe('data:image/png;base64,QUJD');
    expect(await resolve('/t/a.png')).toBe('data:image/png;base64,QUJD');
    expect(readFileBase64Mock).toHaveBeenCalledTimes(1);
    readFileBase64Mock.mockRejectedValue(new Error('ENOENT'));
    expect(await resolve('/t/b.png')).toBeNull();
    expect(await resolve('/t/b.png')).toBeNull();
    expect(readFileBase64Mock).toHaveBeenCalledTimes(2);
  });
});

describe('createImageResolver with an SVG transform', () => {
  test('rewrites an .svg through the transform and caches the result', async () => {
    readTextFileMock.mockResolvedValue({ text: '<svg class="wb-board"/>', mtimeMs: 0 });
    const transform = vi.fn((text: string) => text.replace('<svg', '<svg style="--wb-c0:red"'));
    const resolve = createImageResolver(transform);
    const url = await resolve('/t/board.svg');
    expect(url).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg style="--wb-c0:red" class="wb-board"/>')}`,
    );
    await resolve('/t/board.svg');
    expect(transform).toHaveBeenCalledTimes(1);
    // Raster images never see the transform.
    await resolve('/t/a.png');
    expect(transform).toHaveBeenCalledTimes(1);
  });
});
