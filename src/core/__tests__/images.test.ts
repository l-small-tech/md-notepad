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
});
