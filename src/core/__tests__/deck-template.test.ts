import { describe, expect, it } from 'vitest';
import { isMarpDocument, frontmatterValue, splitSlides } from '../deck';
import { DECK_TEMPLATE_BASENAME, EXAMPLE_DECK, EXAMPLE_DECK_PATH } from '../deck-template';

describe('EXAMPLE_DECK', () => {
  it('is a Marp deck on the built-in default theme with several slides', () => {
    expect(isMarpDocument(EXAMPLE_DECK)).toBe(true);
    expect(frontmatterValue(EXAMPLE_DECK, 'theme')).toBe('default');
    expect(frontmatterValue(EXAMPLE_DECK, 'paginate')).toBe('true');
    expect(splitSlides(EXAMPLE_DECK).length).toBeGreaterThanOrEqual(5);
  });

  it('demonstrates what it explains: spot directives, speaker notes, and the modes', () => {
    expect(EXAMPLE_DECK).toMatch(/^<!-- _class: lead -->$/m);
    expect(EXAMPLE_DECK).toMatch(/^<!-- _class: invert -->$/m);
    // A note is a comment that is not a directive.
    expect(EXAMPLE_DECK).toMatch(/<!--\nSpeaker notes/);
    for (const word of ['Split', 'Edit', 'Present', 'Presenter view', 'Export']) {
      expect(EXAMPLE_DECK).toContain(word);
    }
  });

  it('never carries the things the app strips or cannot load', () => {
    expect(EXAMPLE_DECK).not.toMatch(
      /<script|<iframe|data:image|https?:\/\/[^\s)]+\.(png|jpg|svg)/i,
    );
  });

  it('names its files plainly', () => {
    expect(DECK_TEMPLATE_BASENAME).toBe('presentation');
    expect(EXAMPLE_DECK_PATH).toMatch(/^decks\/.+\.md$/);
  });
});
