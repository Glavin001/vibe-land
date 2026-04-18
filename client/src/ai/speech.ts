/**
 * Thin wrapper around the Web Speech API's SpeechRecognition interface so the
 * chat composer can offer voice input. The DOM lib shipped with TypeScript
 * doesn't include these types yet, so we declare the minimum shape we need.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

type SpeechRecognitionAlternative = { transcript: string; confidence: number };

type SpeechRecognitionResult = {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
};

type SpeechRecognitionResultList = {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: SpeechRecognitionResultList;
};

type SpeechRecognitionErrorEventLike = {
  error: string;
  message?: string;
};

type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const anyWindow = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return anyWindow.SpeechRecognition ?? anyWindow.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export type SpeechRecognitionHandle = {
  supported: boolean;
  listening: boolean;
  interim: string;
  error: string | null;
  /** Start a fresh dictation session. Calls onFinal with each finalized chunk. */
  start: () => void;
  /** Stop listening (commits whatever interim text is buffered). */
  stop: () => void;
  /** Cancel listening without committing. */
  cancel: () => void;
};

export type UseSpeechRecognitionOptions = {
  lang?: string;
  onFinal: (text: string) => void;
};

export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions,
): SpeechRecognitionHandle {
  const ctor = getRecognitionCtor();
  const supported = ctor !== null;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const onFinalRef = useRef(options.onFinal);

  useEffect(() => {
    onFinalRef.current = options.onFinal;
  }, [options.onFinal]);

  useEffect(() => () => {
    recognitionRef.current?.abort();
    recognitionRef.current = null;
  }, []);

  const start = useCallback(() => {
    if (!ctor) return;
    if (recognitionRef.current) return;
    const instance = new ctor();
    instance.lang = options.lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US') ?? 'en-US';
    instance.continuous = true;
    instance.interimResults = true;
    instance.onstart = () => {
      setListening(true);
      setError(null);
    };
    instance.onend = () => {
      setListening(false);
      setInterim('');
      recognitionRef.current = null;
    };
    instance.onerror = (event) => {
      setError(event.error || 'Speech recognition error');
      setListening(false);
    };
    instance.onresult = (event) => {
      let interimBuffer = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alt = result?.[0];
        if (!alt) continue;
        if (result.isFinal) {
          const finalText = alt.transcript.trim();
          if (finalText.length > 0) onFinalRef.current(finalText);
        } else {
          interimBuffer += alt.transcript;
        }
      }
      setInterim(interimBuffer);
    };
    recognitionRef.current = instance;
    try {
      instance.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      recognitionRef.current = null;
      setListening(false);
    }
  }, [ctor, options.lang]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  const cancel = useCallback(() => {
    const instance = recognitionRef.current;
    if (!instance) return;
    instance.onresult = null;
    instance.abort();
    recognitionRef.current = null;
    setListening(false);
    setInterim('');
  }, []);

  return { supported, listening, interim, error, start, stop, cancel };
}
