import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { captureErrorFor, SETTINGS_URIS } from '../dictation-errors';

describe('captureErrorFor — Windows', () => {
  test('dictation off: how to turn on Online speech recognition, with a settings link', () => {
    const e = captureErrorFor('STT_PRIVACY', 'windows');
    expect(e.code).toBe('STT_PRIVACY');
    expect(e.title).toMatch(/turned off/i);
    expect(e.steps.join(' ')).toMatch(/Privacy & security > Speech/);
    expect(e.steps.join(' ')).toMatch(/Online speech recognition/);
    expect(e.steps.at(-1)).toMatch(/tap the microphone again/i);
    expect(e.note).toMatch(/Microsoft/);
    expect(e.settings).toEqual({
      label: 'Open speech settings',
      uri: 'ms-settings:privacy-speech',
    });
  });

  test('microphone blocked points at the desktop-apps toggle', () => {
    const e = captureErrorFor('PERMISSION_DENIED', 'windows');
    expect(e.steps.join(' ')).toMatch(/Let desktop apps access your microphone/);
    expect(e.settings?.uri).toBe('ms-settings:privacy-microphone');
  });

  test('each Windows-specific code gets its own fix', () => {
    expect(captureErrorFor('STT_NO_MIC', 'windows').settings?.uri).toBe('ms-settings:sound');
    expect(captureErrorFor('STT_LANGUAGE', 'windows').settings?.uri).toBe('ms-settings:speech');
    expect(captureErrorFor('STT_NETWORK', 'windows').title).toMatch(/connection/i);
    expect(captureErrorFor('STT_AUDIO_QUALITY', 'windows').title).toMatch(/hear/i);
  });
});

describe('captureErrorFor — Android', () => {
  test('permission denied (by code or ERROR_INSUFFICIENT_PERMISSIONS) explains app permissions', () => {
    for (const raw of ['PERMISSION_DENIED', 'STT_ERROR:9']) {
      const e = captureErrorFor(raw, 'android');
      expect(e.steps.join(' ')).toMatch(/Apps > md-notepad > Permissions/);
      expect(e.settings).toBeUndefined(); // no ms-settings on a phone
    }
  });

  test('SpeechRecognizer numeric codes map to the shared messages', () => {
    expect(captureErrorFor('STT_ERROR:7', 'android').title).toBe("Didn't catch that");
    expect(captureErrorFor('STT_ERROR:6', 'android').title).toBe("Didn't catch that");
    expect(captureErrorFor('STT_ERROR:8', 'android').title).toMatch(/Still finishing/);
    expect(captureErrorFor('STT_ERROR:2', 'android').title).toMatch(/connection/);
    expect(captureErrorFor('STT_ERROR:13', 'android').title).toMatch(/language/);
  });
});

describe('captureErrorFor — shared', () => {
  test('an unknown code falls back to a retry, and keeps the raw code for support', () => {
    const e = captureErrorFor('STT_FAILED:0x80004005 boom', 'windows');
    expect(e.title).toBe('Speech recognition failed');
    expect(e.code).toBe('STT_FAILED:0x80004005 boom');
    expect(e.steps.length).toBeGreaterThan(0);
  });

  test('an empty rejection still produces a usable error', () => {
    expect(captureErrorFor('  ', 'android').code).toBe('UNKNOWN');
  });

  test('every error has a title and at least one step, on both engines', () => {
    const codes = [
      'STT_PRIVACY',
      'PERMISSION_DENIED',
      'PERMISSION_BRIDGE_FAILED',
      'STT_BUSY',
      'STT_UNAVAILABLE',
      'STT_NO_MIC',
      'STT_NETWORK',
      'STT_LANGUAGE',
      'STT_AUDIO_QUALITY',
      'STT_NO_MATCH',
      'STT_ERROR:1',
      'STT_ERROR:12',
      'WHATEVER',
    ];
    for (const engine of ['android', 'windows'] as const) {
      for (const code of codes) {
        const e = captureErrorFor(code, engine);
        expect(e.title.length).toBeGreaterThan(0);
        expect(e.steps.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('Settings links are allowed by the app capabilities', () => {
  test('every ms-settings URI is allow-listed for the opener plugin', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const capPath = resolve(here, '../../../src-tauri/capabilities/default.json');
    const cap = JSON.parse(readFileSync(capPath, 'utf8')) as {
      permissions: (string | { identifier: string; allow?: { url: string }[] })[];
    };
    const allowed = cap.permissions
      .filter((p): p is { identifier: string; allow?: { url: string }[] } => typeof p === 'object')
      .filter((p) => p.identifier === 'opener:allow-open-url')
      .flatMap((p) => p.allow ?? [])
      .map((a) => a.url);
    for (const uri of Object.values(SETTINGS_URIS)) {
      expect(allowed).toContain(uri);
    }
  });
});
