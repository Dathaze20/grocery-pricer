import { useCallback, useEffect, useRef, useState } from 'react';

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Whether this browser can listen at all.
 *
 * Checked rather than assumed, because support is genuinely uneven: the API is prefixed on
 * some browsers, absent on others, and present-but-useless in some in-app webviews. Where it
 * is missing the microphone button is simply not shown, and the phone's own keyboard
 * dictation still works in the text field - every mobile keyboard has it, and it needs nothing
 * from this app.
 */
export function dictationAvailable(): boolean {
  return recognitionCtor() !== null;
}

export interface Dictation {
  readonly listening: boolean;
  readonly error: string | null;
  start: () => void;
  stop: () => void;
}

/**
 * Speech to text, into the box rather than straight out the door.
 *
 * What comes back lands in the text field for the owner to read and fix before sending. A
 * misheard product name that is sent on the spot is a wrong question answered confidently,
 * and in a shop that means a wrong price.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<RecognitionLike | null>(null);
  const sink = useRef(onText);
  sink.current = onText;

  const stop = useCallback(() => {
    session.current?.stop();
    session.current = null;
    setListening(false);
  }, []);

  // A microphone left live after the screen is gone is both a bug and a thing nobody wants.
  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (Ctor === null) {
      setError('This browser cannot listen. Use the microphone on your keyboard instead.');
      return;
    }
    setError(null);

    try {
      // Constructed only now, on a tap. Permission is asked for when the owner asks to speak,
      // never when the screen merely opens.
      const recognition = new Ctor();
      recognition.lang = navigator.language || 'en-US';
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onresult = (event) => {
        let heard = '';
        for (let i = 0; i < event.results.length; i += 1) {
          heard += event.results[i]?.[0]?.transcript ?? '';
        }
        if (heard.trim().length > 0) sink.current(heard.trim());
      };
      recognition.onerror = (event) => {
        setError(
          event.error === 'not-allowed'
            ? 'Microphone permission was declined. You can type instead.'
            : 'Could not hear that. Try again, or type it.',
        );
        setListening(false);
      };
      recognition.onend = () => setListening(false);

      session.current = recognition;
      recognition.start();
      setListening(true);
    } catch {
      setError('The microphone could not be started. You can type instead.');
      setListening(false);
    }
  }, []);

  return { listening, error, start, stop };
}
