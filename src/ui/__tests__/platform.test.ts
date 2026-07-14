import { describe, expect, test } from 'vitest';
import { isAndroidUA } from '../platform';

describe('isAndroidUA', () => {
  test('recognizes Android WebView user-agents', () => {
    expect(
      isAndroidUA(
        'Mozilla/5.0 (Linux; Android 14; SM-X230) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120 Mobile Safari/537.36',
      ),
    ).toBe(true);
    expect(isAndroidUA('Mozilla/5.0 (Linux; Android 11)')).toBe(true);
  });

  test('rejects desktop user-agents', () => {
    expect(isAndroidUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
    expect(isAndroidUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    expect(isAndroidUA('Mozilla/5.0 (X11; Linux x86_64)')).toBe(false);
  });
});
