import { describe, expect, test } from 'vitest';
import { shouldShowNormalizationHint } from '../wysiwyg-normalize';

describe('shouldShowNormalizationHint', () => {
  test('shows once when normalizing and not yet shown', () => {
    expect(shouldShowNormalizationHint(true, false)).toBe(true);
  });

  test('never shows when the doc would not be reformatted', () => {
    expect(shouldShowNormalizationHint(false, false)).toBe(false);
  });

  test('never shows a second time for the same tab', () => {
    expect(shouldShowNormalizationHint(true, true)).toBe(false);
  });
});
