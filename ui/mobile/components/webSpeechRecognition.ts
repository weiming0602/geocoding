import { Platform } from 'react-native';

// The browser's built-in Web Speech API -- deliberately not the
// `expo-speech-recognition` native library. That library needs a custom
// dev client (this app currently runs on plain Expo Go/web, no ios/
// android directories), so it can't be added without also changing how
// this app is built and tested. This is web-only in exchange: Chrome
// desktop works, Safari 16+ routes through Siri, Chrome-iOS and Firefox
// have no support at all, and native (a real phone build) gets nothing
// until that native library is adopted separately.

type SpeechRecognitionResultLike = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getConstructor(): SpeechRecognitionConstructor | null {
  if (Platform.OS !== 'web') return null;
  const g = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionAvailable(): boolean {
  return getConstructor() !== null;
}

/**
 * Listens for a single utterance (up to `timeoutMs`) and resolves with the
 * transcript, or null if nothing was heard, the mic was denied, or the
 * browser doesn't support this at all. Never rejects -- every one of
 * those cases reads as "no command" to the caller, not an error to
 * handle specially.
 */
export function listenOnce(timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    const Ctor = getConstructor();
    if (!Ctor) {
      resolve(null);
      return;
    }

    const recognition = new Ctor();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // Already stopped/ended -- nothing to clean up.
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    recognition.onresult = (event) => {
      finish(event.results?.[0]?.[0]?.transcript ?? null);
    };
    recognition.onerror = () => finish(null);
    recognition.onend = () => finish(null);

    try {
      recognition.start();
    } catch {
      finish(null);
    }
  });
}

// Loose keyword match rather than an exact phrase -- speech-to-text
// transcripts vary ("save this", "save it", "keep this alert", "email
// this to me"), and the cost of a false positive here (re-emailing an
// alert the driver already has) is far lower than the cost of a false
// negative (a real "save this" going unrecognized).
const SAVE_COMMAND_KEYWORDS = ['save', 'keep', 'email'];

export function matchesSaveCommand(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  return SAVE_COMMAND_KEYWORDS.some((keyword) => lower.includes(keyword));
}
