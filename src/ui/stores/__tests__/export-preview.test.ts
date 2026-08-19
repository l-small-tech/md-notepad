import { beforeEach, describe, expect, test } from 'vitest';
import { exportPreviewStore } from '../export-preview';
import type { DocSource } from '../../../core/export/doc-source';

const SOURCE: DocSource = {
  markdown: '# Hi',
  title: 'Hi',
  docPath: 'C:/notes/hi.md',
  suggestedBase: 'hi',
};

describe('exportPreviewStore', () => {
  beforeEach(() => {
    exportPreviewStore.setState({
      open: false,
      source: null,
      format: 'pdf',
      themeId: '',
      dark: false,
      themeSvg: true,
    });
  });

  test('openWith opens on the source and seeds theme + mode', () => {
    exportPreviewStore.getState().openWith(SOURCE, { themeId: 'dark-green', dark: true });
    const s = exportPreviewStore.getState();
    expect(s.open).toBe(true);
    expect(s.source).toEqual(SOURCE);
    expect(s.themeId).toBe('dark-green');
    expect(s.dark).toBe(true);
  });

  test('the SVG-theming toggle is sticky across opens, like the format', () => {
    exportPreviewStore.getState().setThemeSvg(false);
    exportPreviewStore.getState().openWith(SOURCE, { themeId: 'light-green', dark: false });
    exportPreviewStore.getState().close();
    expect(exportPreviewStore.getState().themeSvg).toBe(false);
  });

  test('close clears the source but keeps the sticky format', () => {
    exportPreviewStore.getState().setFormat('docx');
    exportPreviewStore.getState().openWith(SOURCE, { themeId: 'light-green', dark: false });
    exportPreviewStore.getState().close();
    const s = exportPreviewStore.getState();
    expect(s.open).toBe(false);
    expect(s.source).toBeNull();
    expect(s.format).toBe('docx');
  });

  test('re-opening re-seeds the theme (no stale carry-over)', () => {
    exportPreviewStore.getState().openWith(SOURCE, { themeId: 'a', dark: false });
    exportPreviewStore.getState().setThemeId('b');
    exportPreviewStore.getState().setDark(true);
    exportPreviewStore.getState().close();
    exportPreviewStore.getState().openWith(SOURCE, { themeId: 'a', dark: false });
    const s = exportPreviewStore.getState();
    expect(s.themeId).toBe('a');
    expect(s.dark).toBe(false);
  });
});
