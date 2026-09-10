/**
 * dictation-errors.ts — what to tell the user when voice-note dictation fails.
 *
 * The speech bridges (Android SpeechRecognizer, Windows dictation — see
 * src-tauri commands/android.rs and commands/dictation.rs) reject with short
 * codes. This module turns a code into something the voice-note sheet can show
 * IN PLACE, under the microphone: a title, numbered steps to fix it, an
 * optional note, and — on Windows — the exact Settings page to open. A status
 * bar notice was too easy to miss: the sheet dims everything behind it.
 *
 * Pure and platform-free (I9): the engine is passed in, and the Settings pages
 * are plain `ms-settings:` URIs the UI hands to the opener plugin. Every URI
 * here must also be allow-listed in src-tauri/capabilities/default.json (the
 * test suite checks), or the opener refuses it.
 */

/** The speech-to-text engine that captures voice notes on this platform. */
export type DictationEngine = 'android' | 'windows';

/** A failed capture, shaped for the sheet. */
export interface CaptureError {
  /** The raw bridge code, shown small for support ("STT_PRIVACY"). */
  code: string;
  /** One line: what's wrong. */
  title: string;
  /** Numbered steps to fix it, in order. The last one says how to retry. */
  steps: string[];
  /** Optional context (e.g. what enabling a setting means for privacy). */
  note?: string;
  /** A Settings page that jumps straight to the fix (Windows only). */
  settings?: { label: string; uri: string };
}

/** The `ms-settings:` pages this module may link to (mirrored in capabilities). */
export const SETTINGS_URIS = {
  speechPrivacy: 'ms-settings:privacy-speech',
  microphonePrivacy: 'ms-settings:privacy-microphone',
  speechLanguage: 'ms-settings:speech',
  sound: 'ms-settings:sound',
} as const;

const RETRY = 'Come back here and tap the microphone again.';

/** Windows: the fix for each bridge code. */
function windowsError(code: string): Omit<CaptureError, 'code'> {
  if (code.includes('STT_PRIVACY')) {
    return {
      title: 'Windows dictation is turned off',
      steps: [
        'Open Windows Settings > Privacy & security > Speech.',
        'Turn on "Online speech recognition".',
        RETRY,
      ],
      note:
        'Windows dictation only works with this setting on. While you dictate, ' +
        'Windows sends your voice to Microsoft to turn it into text. md-notepad ' +
        'never records or keeps audio.',
      settings: { label: 'Open speech settings', uri: SETTINGS_URIS.speechPrivacy },
    };
  }
  if (code.includes('PERMISSION_DENIED')) {
    return {
      title: 'Microphone access is blocked',
      steps: [
        'Open Windows Settings > Privacy & security > Microphone.',
        'Turn on "Microphone access".',
        'Turn on "Let desktop apps access your microphone".',
        RETRY,
      ],
      settings: { label: 'Open microphone settings', uri: SETTINGS_URIS.microphonePrivacy },
    };
  }
  if (code.includes('STT_NO_MIC')) {
    return {
      title: 'No microphone found',
      steps: [
        'Connect a microphone or headset.',
        'Check that it is selected under Windows Settings > System > Sound > Input.',
        RETRY,
      ],
      settings: { label: 'Open sound settings', uri: SETTINGS_URIS.sound },
    };
  }
  if (code.includes('STT_LANGUAGE')) {
    return {
      title: "Windows dictation doesn't support your speech language",
      steps: [
        'Open Windows Settings > Time & language > Speech.',
        'Choose a supported speech language, and install its speech pack if asked.',
        RETRY,
      ],
      settings: { label: 'Open speech language settings', uri: SETTINGS_URIS.speechLanguage },
    };
  }
  if (code.includes('STT_UNAVAILABLE')) {
    return {
      title: "Windows speech recognition isn't available on this PC",
      steps: [
        'Make sure Windows is up to date.',
        'Check Windows Settings > Time & language > Speech.',
        RETRY,
      ],
      settings: { label: 'Open speech language settings', uri: SETTINGS_URIS.speechLanguage },
    };
  }
  if (code.includes('STT_NETWORK')) {
    return {
      title: 'Lost the connection to Windows dictation',
      steps: ['Windows dictation needs an internet connection. Check that you are online.', RETRY],
    };
  }
  if (code.includes('STT_AUDIO_QUALITY')) {
    return {
      title: "Couldn't hear you clearly",
      steps: ['Move closer to the microphone, or somewhere quieter.', RETRY],
    };
  }
  return sharedError(code);
}

/** Android: the fix for each bridge code (`STT_ERROR:<n>` = SpeechRecognizer.ERROR_*). */
function androidError(code: string): Omit<CaptureError, 'code'> {
  const numeric = /STT_ERROR:(-?\d+)/.exec(code);
  const n = numeric ? Number(numeric[1]) : null;
  if (code.includes('PERMISSION_DENIED') || n === 9) {
    return {
      title: 'Microphone permission is off',
      steps: [
        'Open Android Settings > Apps > md-notepad > Permissions.',
        'Set Microphone to "Allow only while using the app".',
        RETRY,
      ],
    };
  }
  if (code.includes('STT_UNAVAILABLE')) {
    return {
      title: "Speech recognition isn't available on this device",
      steps: [
        'Install or update "Speech Recognition & Synthesis from Google" in the Play Store.',
        RETRY,
      ],
    };
  }
  if (n === 1 || n === 2) {
    return {
      title: 'Speech recognition needs a connection',
      steps: [
        "Connect to the internet, or download offline speech for your language in your keyboard's voice typing settings.",
        RETRY,
      ],
    };
  }
  if (n === 12 || n === 13) {
    return {
      title: 'No speech model for your language',
      steps: [
        "Download offline speech for your language in your keyboard's voice typing settings, or connect to the internet.",
        RETRY,
      ],
    };
  }
  if (n === 6 || n === 7) {
    return sharedError('STT_NO_MATCH');
  }
  if (n === 8) {
    return sharedError('STT_BUSY');
  }
  return sharedError(code);
}

/** Codes both bridges use, and the fallback. */
function sharedError(code: string): Omit<CaptureError, 'code'> {
  if (code.includes('STT_NO_MATCH')) {
    return {
      title: "Didn't catch that",
      steps: [
        'Tap the microphone and start speaking right away.',
        'Tap it again when you are done.',
      ],
    };
  }
  if (code.includes('STT_BUSY')) {
    return {
      title: 'Still finishing the last recording',
      steps: ['Wait a moment, then tap the microphone again.'],
    };
  }
  if (code.includes('STT_START_TIMEOUT')) {
    return {
      title: "Dictation didn't start",
      steps: [
        'Wait a few seconds, then tap the microphone again.',
        'If it keeps happening, close md-notepad and open it again.',
      ],
    };
  }
  if (code.includes('STT_STOP_TIMEOUT')) {
    return {
      title: "Dictation didn't finish",
      steps: [
        'Tap the microphone to record the note again.',
        'If it keeps happening, close md-notepad and open it again.',
      ],
    };
  }
  if (code.includes('PERMISSION_BRIDGE_FAILED')) {
    return {
      title: "Couldn't ask for microphone permission",
      steps: ['Close this sheet, open it again, and tap the microphone.'],
    };
  }
  return {
    title: 'Speech recognition failed',
    steps: ['Tap the microphone to try again.'],
  };
}

/** The sheet-ready error for a bridge rejection on the given engine. */
export function captureErrorFor(raw: string, engine: DictationEngine): CaptureError {
  const code = raw.trim() || 'UNKNOWN';
  const shaped = engine === 'windows' ? windowsError(code) : androidError(code);
  return { code, ...shaped };
}
