import { describe, expect, test } from 'vitest';
import { detectPlatform, keyEventToAction, type KeyDescriptor } from '../keymap';

function key(partial: Partial<KeyDescriptor> & { key: string }): KeyDescriptor {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

describe('detectPlatform', () => {
  test('recognizes macOS platform strings', () => {
    expect(detectPlatform('MacIntel')).toBe('mac');
    expect(detectPlatform('iPhone')).toBe('mac');
  });
  test('everything else is "other"', () => {
    expect(detectPlatform('Win32')).toBe('other');
    expect(detectPlatform('Linux x86_64')).toBe('other');
  });
});

describe('keyEventToAction — mod resolves per platform', () => {
  test('Ctrl+N on non-mac is new-tab; Meta+N is not', () => {
    expect(keyEventToAction(key({ key: 'n', ctrlKey: true }), 'other')).toEqual({
      type: 'new-tab',
    });
    expect(keyEventToAction(key({ key: 'n', metaKey: true }), 'other')).toBeNull();
  });

  test('Cmd+N on mac is new-tab; Ctrl+N is not', () => {
    expect(keyEventToAction(key({ key: 'n', metaKey: true }), 'mac')).toEqual({ type: 'new-tab' });
    expect(keyEventToAction(key({ key: 'n', ctrlKey: true }), 'mac')).toBeNull();
  });
});

describe('keyEventToAction — the M1 table', () => {
  test('mod+W closes the tab', () => {
    expect(keyEventToAction(key({ key: 'w', ctrlKey: true }), 'other')).toEqual({
      type: 'close-tab',
    });
  });

  test('mod+Tab / mod+Shift+Tab cycle tabs', () => {
    expect(keyEventToAction(key({ key: 'Tab', ctrlKey: true }), 'other')).toEqual({
      type: 'next-tab',
    });
    expect(keyEventToAction(key({ key: 'Tab', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'prev-tab',
    });
  });

  test('F2 renames, with or without focus, and needs no modifier', () => {
    expect(keyEventToAction(key({ key: 'F2' }), 'other')).toEqual({ type: 'rename-tab' });
    expect(keyEventToAction(key({ key: 'F2' }), 'mac')).toEqual({ type: 'rename-tab' });
  });

  test('mod+1/2/3/4 select the four modes', () => {
    expect(keyEventToAction(key({ key: '1', ctrlKey: true }), 'other')).toEqual({
      type: 'set-mode',
      mode: 'raw',
    });
    expect(keyEventToAction(key({ key: '2', ctrlKey: true }), 'other')).toEqual({
      type: 'set-mode',
      mode: 'split',
    });
    expect(keyEventToAction(key({ key: '3', ctrlKey: true }), 'other')).toEqual({
      type: 'set-mode',
      mode: 'wysiwyg',
    });
    expect(keyEventToAction(key({ key: '4', ctrlKey: true }), 'other')).toEqual({
      type: 'set-mode',
      mode: 'read',
    });
  });
});

describe('keyEventToAction — the M3 table', () => {
  test('mod+O opens a file', () => {
    expect(keyEventToAction(key({ key: 'o', ctrlKey: true }), 'other')).toEqual({
      type: 'open-file',
    });
  });

  test('mod+S saves; mod+Shift+S saves as', () => {
    expect(keyEventToAction(key({ key: 's', ctrlKey: true }), 'other')).toEqual({ type: 'save' });
    expect(keyEventToAction(key({ key: 's', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'save-as',
    });
  });
});

describe('keyEventToAction — outline panel', () => {
  test('mod+Shift+O toggles the outline on both platforms', () => {
    expect(keyEventToAction(key({ key: 'O', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'toggle-outline',
    });
    expect(keyEventToAction(key({ key: 'O', metaKey: true, shiftKey: true }), 'mac')).toEqual({
      type: 'toggle-outline',
    });
  });

  test('plain mod+O stays open-file; bare/wrong-modifier Shift+O is ignored', () => {
    expect(keyEventToAction(key({ key: 'o', ctrlKey: true }), 'other')).toEqual({
      type: 'open-file',
    });
    expect(keyEventToAction(key({ key: 'O', shiftKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'O', metaKey: true, shiftKey: true }), 'other')).toBeNull();
  });
});

describe('keyEventToAction — the M6 table', () => {
  test('mod+, opens settings', () => {
    expect(keyEventToAction(key({ key: ',', ctrlKey: true }), 'other')).toEqual({
      type: 'open-settings',
    });
    expect(keyEventToAction(key({ key: ',', metaKey: true }), 'mac')).toEqual({
      type: 'open-settings',
    });
  });

  test('mod+= and mod++ both increase font size', () => {
    expect(keyEventToAction(key({ key: '=', ctrlKey: true }), 'other')).toEqual({
      type: 'font-inc',
    });
    expect(keyEventToAction(key({ key: '+', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'font-inc',
    });
  });

  test('mod+- and mod+_ both decrease font size', () => {
    expect(keyEventToAction(key({ key: '-', ctrlKey: true }), 'other')).toEqual({
      type: 'font-dec',
    });
    expect(keyEventToAction(key({ key: '_', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'font-dec',
    });
  });

  test('mod+0 resets font size', () => {
    expect(keyEventToAction(key({ key: '0', ctrlKey: true }), 'other')).toEqual({
      type: 'font-reset',
    });
    expect(keyEventToAction(key({ key: '0', metaKey: true }), 'mac')).toEqual({
      type: 'font-reset',
    });
  });
});

describe('keyEventToAction — command palette', () => {
  test('mod+K opens the palette on both platforms', () => {
    expect(keyEventToAction(key({ key: 'k', ctrlKey: true }), 'other')).toEqual({
      type: 'open-palette',
    });
    expect(keyEventToAction(key({ key: 'k', metaKey: true }), 'mac')).toEqual({
      type: 'open-palette',
    });
  });

  test('mod+Shift+K is NOT the palette (CM6 deleteLine owns it)', () => {
    expect(keyEventToAction(key({ key: 'k', ctrlKey: true, shiftKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'K', metaKey: true, shiftKey: true }), 'mac')).toBeNull();
  });

  test('bare K and wrong-modifier K are ignored', () => {
    expect(keyEventToAction(key({ key: 'k' }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'k', metaKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'k', ctrlKey: true }), 'mac')).toBeNull();
  });
});

describe('keyEventToAction — reader full screen', () => {
  test('bare F11 toggles fullscreen on any platform', () => {
    expect(keyEventToAction(key({ key: 'F11' }), 'other')).toEqual({ type: 'toggle-fullscreen' });
    expect(keyEventToAction(key({ key: 'F11' }), 'mac')).toEqual({ type: 'toggle-fullscreen' });
  });

  test('modified F11 is not the shortcut', () => {
    expect(keyEventToAction(key({ key: 'F11', ctrlKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'F11', shiftKey: true }), 'other')).toBeNull();
  });

  test('Ctrl+Cmd+F toggles fullscreen on mac only', () => {
    expect(keyEventToAction(key({ key: 'f', ctrlKey: true, metaKey: true }), 'mac')).toEqual({
      type: 'toggle-fullscreen',
    });
    expect(keyEventToAction(key({ key: 'f', ctrlKey: true, metaKey: true }), 'other')).toBeNull();
  });
});

describe('keyEventToAction — global workspace search', () => {
  test('mod+Shift+F opens global search on both platforms', () => {
    expect(keyEventToAction(key({ key: 'F', ctrlKey: true, shiftKey: true }), 'other')).toEqual({
      type: 'global-search',
    });
    expect(keyEventToAction(key({ key: 'F', metaKey: true, shiftKey: true }), 'mac')).toEqual({
      type: 'global-search',
    });
  });

  test('bare/wrong-modifier Shift+F is ignored', () => {
    expect(keyEventToAction(key({ key: 'F', shiftKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'F', metaKey: true, shiftKey: true }), 'other')).toBeNull();
  });

  test('the mac fullscreen chord (Ctrl+Cmd+F) still wins without Shift', () => {
    expect(keyEventToAction(key({ key: 'f', ctrlKey: true, metaKey: true }), 'mac')).toEqual({
      type: 'toggle-fullscreen',
    });
  });
});

describe('keyEventToAction — non-interception', () => {
  test('mod+F is NOT intercepted (CM6 search owns it)', () => {
    expect(keyEventToAction(key({ key: 'f', ctrlKey: true }), 'other')).toBeNull();
    expect(keyEventToAction(key({ key: 'f', metaKey: true }), 'mac')).toBeNull();
  });

  test('a bare letter is not a shortcut', () => {
    expect(keyEventToAction(key({ key: 'n' }), 'other')).toBeNull();
  });

  test('Alt disqualifies our chords', () => {
    expect(keyEventToAction(key({ key: 'n', ctrlKey: true, altKey: true }), 'other')).toBeNull();
  });

  test('mod+Shift+N (not in the table) is ignored', () => {
    expect(keyEventToAction(key({ key: 'n', ctrlKey: true, shiftKey: true }), 'other')).toBeNull();
  });
});
