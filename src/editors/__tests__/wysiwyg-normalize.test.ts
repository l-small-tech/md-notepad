import { describe, expect, test } from 'vitest';
import {
  markdownNormalizes,
  NORMALIZATION_HINT,
  shouldShowNormalizationHint,
} from '../wysiwyg-normalize';

describe('markdownNormalizes', () => {
  test('identical round-trip does not normalize', () => {
    expect(markdownNormalizes('# Title\n', '# Title\n')).toBe(false);
  });

  test('a reformatted round-trip normalizes', () => {
    // e.g. Crepe rewrites `*` bullets to `-`, or tightens list whitespace.
    expect(markdownNormalizes('* a\n* b\n', '- a\n- b\n')).toBe(true);
  });

  test('empty documents never normalize', () => {
    expect(markdownNormalizes('', '')).toBe(false);
  });
});

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

describe('NORMALIZATION_HINT', () => {
  test('matches the plan wording (content is preserved)', () => {
    expect(NORMALIZATION_HINT).toContain('content is preserved');
  });
});
