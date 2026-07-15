import { describe, expect, test } from 'vitest';
import { localImageToInline } from '../images';

describe('localImageToInline', () => {
  test('resolves a relative image against the doc directory', () => {
    expect(localImageToInline('/ws', 'images/shot.png')).toBe('/ws/images/shot.png');
  });

  test('resolves ../ segments', () => {
    expect(localImageToInline('/ws/sub', '../pics/a.jpg')).toBe('/ws/pics/a.jpg');
  });

  test('leaves external images alone (null)', () => {
    expect(localImageToInline('/ws', 'https://x.test/a.png')).toBeNull();
    expect(localImageToInline('/ws', 'http://x.test/a.png')).toBeNull();
  });

  test('leaves an already-inlined data URL alone (null)', () => {
    expect(localImageToInline('/ws', 'data:image/png;base64,QUJD')).toBeNull();
  });

  test('an unsaved doc (no directory) resolves nothing', () => {
    expect(localImageToInline(null, 'images/shot.png')).toBeNull();
    expect(localImageToInline('', 'images/shot.png')).toBeNull();
  });

  test('a non-image target is left alone (null)', () => {
    expect(localImageToInline('/ws', 'notes/other.md')).toBeNull();
  });

  test('an empty src resolves nothing', () => {
    expect(localImageToInline('/ws', '')).toBeNull();
  });

  test('decodes percent-escapes before resolving', () => {
    expect(localImageToInline('/ws', 'images/my%20shot.png')).toBe('/ws/images/my shot.png');
  });

  test('resolves a synced-folder saf:// image id without mangling the tree token', () => {
    // A DOCX-import/paste in a synced (Android SAF) workspace writes an absolute
    // saf:// src; it must round-trip so the bytes can be read off that tree.
    const saf = 'saf://content%3A%2F%2Ftree%2Fabc';
    expect(localImageToInline(`${saf}/notes`, `${saf}/notes/images/shot.png`)).toBe(
      `${saf}/notes/images/shot.png`,
    );
  });
});
