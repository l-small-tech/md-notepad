import { describe, expect, test } from 'vitest';

import {
  converterFor,
  imagePlaceholder,
  importFilters,
  isImportablePath,
  replaceImagePlaceholders,
} from '../registry';

describe('converterFor', () => {
  test('finds the PDF converter case-insensitively', () => {
    expect(converterFor('.pdf')?.label).toBe('PDF document');
    expect(converterFor('.PDF')?.label).toBe('PDF document');
    expect(converterFor('.pdf')?.available).not.toBe(false);
  });

  test('finds the DOCX converter case-insensitively', () => {
    expect(converterFor('.docx')?.label).toBe('Word document');
    expect(converterFor('.DOCX')?.label).toBe('Word document');
    expect(converterFor('.docx')?.available).not.toBe(false);
  });

  test('unknown extensions have no converter', () => {
    expect(converterFor('.rtf')).toBeNull();
    expect(converterFor('')).toBeNull();
  });
});

describe('isImportablePath', () => {
  test('recognizes importable extensions on a full path, any case', () => {
    expect(isImportablePath('/notes/report.pdf')).toBe(true);
    expect(isImportablePath('Memo.DOCX')).toBe(true);
  });

  test('rejects notes, images, and extensionless names', () => {
    expect(isImportablePath('note.md')).toBe(false);
    expect(isImportablePath('photo.png')).toBe(false);
    expect(isImportablePath('README')).toBe(false);
  });
});

describe('importFilters', () => {
  test('covers pdf and docx without dots', () => {
    expect(importFilters[0]?.extensions).toContain('pdf');
    expect(importFilters[0]?.extensions).toContain('docx');
  });
});

describe('replaceImagePlaceholders', () => {
  test('replaces placeholders in index order', () => {
    const md = `intro\n\n${imagePlaceholder(0)}\n\nmiddle\n\n${imagePlaceholder(1)}`;
    expect(replaceImagePlaceholders(md, ['![a](a.png)', '![b](b.png)'])).toBe(
      'intro\n\n![a](a.png)\n\nmiddle\n\n![b](b.png)',
    );
  });

  test('drops the line for a null link', () => {
    const md = `before\n${imagePlaceholder(0)}\nafter`;
    expect(replaceImagePlaceholders(md, [null])).toBe('before\nafter');
  });

  test('inline placeholders inside a line are stripped when null', () => {
    expect(replaceImagePlaceholders(`text ${imagePlaceholder(0)} more`, [null])).toBe('text  more');
  });
});
