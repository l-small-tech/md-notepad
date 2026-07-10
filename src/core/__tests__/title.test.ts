import { describe, expect, test } from 'vitest';
import {
  deriveTitle,
  dropTrailingExtension,
  sanitizeFileBaseName,
  slugifyTitle,
  stripExtension,
} from '../title';

describe('deriveTitle', () => {
  test('uses the first non-blank line', () => {
    expect(deriveTitle('\n\n  \nMy note\nsecond line')).toBe('My note');
  });

  test('strips heading markers', () => {
    expect(deriveTitle('## Meeting notes')).toBe('Meeting notes');
  });

  test('strips list markers', () => {
    expect(deriveTitle('- buy milk')).toBe('buy milk');
    expect(deriveTitle('* buy milk')).toBe('buy milk');
    expect(deriveTitle('12. twelfth item')).toBe('twelfth item');
  });

  test('strips (nested) blockquote markers', () => {
    expect(deriveTitle('> > quoted idea')).toBe('quoted idea');
  });

  test('strips inline emphasis characters', () => {
    expect(deriveTitle('**bold** and `code`')).toBe('bold and code');
  });

  test('handles CRLF documents', () => {
    expect(deriveTitle('\r\nTitle here\r\nbody')).toBe('Title here');
  });

  test('skips lines that are only markdown syntax', () => {
    expect(deriveTitle('---\nreal title')).toBe('real title');
  });

  test('empty or whitespace-only text falls back to Untitled', () => {
    expect(deriveTitle('')).toBe('Untitled');
    expect(deriveTitle('   \n\t\n')).toBe('Untitled');
  });

  test('truncates long titles with an ellipsis at 60 chars', () => {
    const title = deriveTitle('x'.repeat(100));
    expect(title.length).toBe(60);
    expect(title.endsWith('…')).toBe(true);
  });
});

describe('slugifyTitle', () => {
  test('kebab-cases and lowercases', () => {
    expect(slugifyTitle('My Great Note!')).toBe('my-great-note');
  });

  test('strips diacritics via NFKD', () => {
    expect(slugifyTitle('Café Menü')).toBe('cafe-menu');
  });

  test('collapses runs of non-alphanumerics', () => {
    expect(slugifyTitle('a --- b // c')).toBe('a-b-c');
  });

  test('empty and non-latin titles fall back to untitled', () => {
    expect(slugifyTitle('')).toBe('untitled');
    expect(slugifyTitle('!!!')).toBe('untitled');
    expect(slugifyTitle('메모')).toBe('untitled');
  });

  test('Windows-reserved basenames get a suffix', () => {
    // con.md is unwritable on Windows regardless of extension.
    expect(slugifyTitle('CON')).toBe('con-note');
    expect(slugifyTitle('lpt1')).toBe('lpt1-note');
  });

  test('truncates to 50 chars without a trailing dash', () => {
    const slug = slugifyTitle(`${'a'.repeat(49)} b`);
    expect(slug.length).toBeLessThanOrEqual(50);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('stripExtension', () => {
  test('drops a trailing extension', () => {
    expect(stripExtension('report.md')).toBe('report');
    expect(stripExtension('Budget Q3.markdown')).toBe('Budget Q3');
  });

  test('leaves a name with no extension alone', () => {
    expect(stripExtension('README')).toBe('README');
  });

  test('only removes the final extension', () => {
    expect(stripExtension('archive.tar.gz')).toBe('archive.tar');
  });

  test('keeps a leading-dot name (no basename to strip)', () => {
    expect(stripExtension('.gitignore')).toBe('.gitignore');
  });
});

describe('dropTrailingExtension', () => {
  test('drops the extension when it duplicates the one to be re-appended', () => {
    expect(dropTrailingExtension('notes.md', '.md')).toBe('notes');
  });

  test('is case-insensitive on the extension', () => {
    expect(dropTrailingExtension('notes.MD', '.md')).toBe('notes');
    expect(dropTrailingExtension('notes.md', '.MD')).toBe('notes');
  });

  test('leaves a non-matching extension as part of the base', () => {
    // Renaming a .txt file: "cheatsheet.md" keeps the ".md".
    expect(dropTrailingExtension('cheatsheet.md', '.txt')).toBe('cheatsheet.md');
  });

  test('leaves a bare name (no extension typed) alone', () => {
    expect(dropTrailingExtension('notes', '.md')).toBe('notes');
    // "md" typed as a name, not an extension, is kept.
    expect(dropTrailingExtension('md', '.md')).toBe('md');
  });

  test('an empty extension (folder) is a no-op', () => {
    expect(dropTrailingExtension('archive.md', '')).toBe('archive.md');
  });

  test('only removes one extension (the matching one)', () => {
    expect(dropTrailingExtension('archive.tar.md', '.md')).toBe('archive.tar');
  });
});

describe('sanitizeFileBaseName', () => {
  test('preserves casing and spaces (unlike slugifyTitle)', () => {
    expect(sanitizeFileBaseName('Budget Q3')).toBe('Budget Q3');
  });

  test('preserves hyphens', () => {
    expect(sanitizeFileBaseName('my-report')).toBe('my-report');
  });

  test('drops filesystem-illegal characters', () => {
    expect(sanitizeFileBaseName('a/b:c*d?e')).toBe('a b c d e');
  });

  test('trims trailing dots and spaces (Windows rejects them)', () => {
    expect(sanitizeFileBaseName('notes... ')).toBe('notes');
  });

  test('returns empty when nothing usable remains', () => {
    expect(sanitizeFileBaseName('   ')).toBe('');
    expect(sanitizeFileBaseName('/\\?*')).toBe('');
  });

  test('suffixes Windows-reserved device names', () => {
    expect(sanitizeFileBaseName('CON')).toBe('CON-note');
  });
});
