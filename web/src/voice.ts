export type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';

export interface VoiceOptions {
  rate: number;
  pitch: number;
  voiceURI: string;
  silenceMs: number;
  bargeIn: boolean;
  handsFree: boolean;
  autoListen: boolean;
}

type RecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  onspeechend: (() => void) | null;
};

/**
 * VoiceEngine owns the mic + speaker lifecycle. It is deliberately independent
 * of React so the conversation survives re-renders, and it exposes a state
 * machine the UI can mirror.
 */
export class VoiceEngine {
  state: VoiceState = 'idle';
  supported = false;
  muted = false;

  onState?: (state: VoiceState) => void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
  onError?: (message: string) => void;
  onLevel?: (level: number) => void;

  private recognition: RecognitionLike | null = null;
  private listening = false;
  private wantListening = false;
  private speaking = false;
  private queue: string[] = [];
  private buffer = '';
  private silenceTimer: number | null = null;
  private interimText = '';
  private lastCommitted = { text: '', at: 0 };
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private vadFrame = 0;
  private options: VoiceOptions;

  constructor(options: VoiceOptions) {
    this.options = options;
    const Recognition =
      (window as unknown as { SpeechRecognition?: new () => RecognitionLike }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => RecognitionLike }).webkitSpeechRecognition;
    this.supported = Boolean(Recognition) && Boolean(window.speechSynthesis);
    this.RecognitionCtor = Recognition ?? null;
  }

  private RecognitionCtor: (new () => RecognitionLike) | null;

  setOptions(options: Partial<VoiceOptions>): void {
    this.options = { ...this.options, ...options };
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.onState?.(state);
  }

  private buildRecognition(): RecognitionLike | null {
    if (this.recognition) return this.recognition;
    if (!this.RecognitionCtor) return null;
    const recognition = new this.RecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = String(result[0]?.transcript ?? '').trim();
        if (!text) continue;
        if (result.isFinal) {
          this.commit(text);
        } else {
          interim += `${text} `;
        }
      }
      this.interimText = interim.trim();
      if (this.interimText) {
        this.onInterim?.(this.interimText);
        this.armSilenceCommit();
      }
    };

    recognition.onerror = (event: any) => {
      const code = String(event?.error ?? '');
      if (code === 'no-speech' || code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.onError?.(
          'Microphone access was blocked. Allow the microphone for this site, or use the text chat instead.',
        );
        this.wantListening = false;
        this.listening = false;
        this.setState('idle');
        return;
      }
      if (code === 'network') {
        this.onError?.('Speech recognition lost its network connection. Retrying…');
        return;
      }
      this.onError?.(`Speech recognition problem: ${code || 'unknown error'}`);
    };

    recognition.onend = () => {
      this.listening = false;
      if (this.wantListening && !this.speaking && !this.muted) {
        // Continuous sessions: keep listening without the owner pressing anything.
        window.setTimeout(() => {
          if (this.wantListening && !this.speaking) this.startRecognition();
        }, 220);
      } else if (!this.speaking && this.state === 'listening' && !this.wantListening) {
        this.setState('idle');
      }
    };

    this.recognition = recognition;
    return recognition;
  }

  private startRecognition(): void {
    const recognition = this.buildRecognition();
    if (!recognition || this.listening) return;
    this.interimText = '';
    try {
      recognition.start();
      this.listening = true;
      this.setState('listening');
    } catch {
      /* start() throws if already running; the onend handler will retry */
    }
  }

  private armSilenceCommit(): void {
    if (this.silenceTimer) window.clearTimeout(this.silenceTimer);
    const delay = Math.max(600, this.options.silenceMs);
    this.silenceTimer = window.setTimeout(() => {
      if (this.interimText) {
        const text = this.interimText;
        this.interimText = '';
        this.onInterim?.('');
        this.commit(text);
      }
    }, delay);
  }

  private commit(text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const now = Date.now();
    if (clean === this.lastCommitted.text && now - this.lastCommitted.at < 1500) return;
    this.lastCommitted = { text: clean, at: now };
    this.interimText = '';
    if (this.silenceTimer) window.clearTimeout(this.silenceTimer);
    this.onFinal?.(clean);
  }

  /** Begin a voice session: mic on, VAD on. */
  async start(): Promise<void> {
    if (!this.supported) {
      this.onError?.(
        'This browser has no speech recognition. Chrome, Edge or Safari support it — text chat still works everywhere.',
      );
      return;
    }
    this.muted = false;
    this.wantListening = true;
    await this.startAnalyser();
    this.startRecognition();
  }

  /** End the session completely. */
  stop(): void {
    this.wantListening = false;
    this.muted = false;
    this.cancelSpeech();
    if (this.silenceTimer) window.clearTimeout(this.silenceTimer);
    try {
      this.recognition?.stop();
    } catch {
      /* ignore */
    }
    this.listening = false;
    this.stopAnalyser();
    this.setState('idle');
  }

  /** Stop speaking and go straight back to listening (barge-in). */
  interrupt(): void {
    this.cancelSpeech();
    if (this.wantListening && !this.muted) this.startRecognition();
  }

  mute(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.cancelSpeech();
      try {
        this.recognition?.stop();
      } catch {
        /* ignore */
      }
      this.listening = false;
      this.setState('idle');
    } else if (this.wantListening) {
      this.startRecognition();
    }
  }

  pauseListening(): void {
    if (this.silenceTimer) window.clearTimeout(this.silenceTimer);
    try {
      this.recognition?.stop();
    } catch {
      /* ignore */
    }
    this.listening = false;
  }

  resumeListening(): void {
    if (this.wantListening && !this.muted) this.startRecognition();
  }

  setThinking(): void {
    this.setState('thinking');
  }

  /* ------------------------------ speech ------------------------------ */

  speak(text: string): void {
    const clean = text.trim();
    if (!clean || this.muted) return;
    this.queue.push(clean);
    if (!this.speaking) this.next();
  }

  speakStream(delta: string): void {
    if (!delta || this.muted) return;
    this.buffer += delta;
    const match = /^([\s\S]{18,}?[.!?…])(\s|$)/.exec(this.buffer);
    if (match) {
      const sentence = match[1];
      this.buffer = this.buffer.slice(match[0].length);
      this.speak(sentence);
      return;
    }
    if (this.buffer.length > 220) {
      const cut = this.buffer.lastIndexOf(' ');
      if (cut > 80) {
        const sentence = this.buffer.slice(0, cut);
        this.buffer = this.buffer.slice(cut + 1);
        this.speak(sentence);
      }
    }
  }

  flushSpeech(): void {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.speak(rest);
  }

  /** Called when a model turn ends: speak the tail, then listen again if idle. */
  finishTurn(): void {
    this.flushSpeech();
    if (!this.speaking && this.queue.length === 0 && !this.buffer) {
      if (this.wantListening && !this.muted) this.startRecognition();
    }
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    if (this.options.voiceURI) {
      const match = voices.find((voice) => voice.voiceURI === this.options.voiceURI);
      if (match) return match;
    }
    const preferred = voices.find((voice) => /en(-|_)(US|GB)/i.test(voice.lang) && /female|samantha|jenny|aria|zira/i.test(voice.name));
    return preferred ?? voices.find((voice) => voice.lang.startsWith('en')) ?? voices[0];
  }

  private next(): void {
    const text = this.queue.shift();
    if (!text) {
      this.speaking = false;
      if (this.wantListening && !this.muted) this.startRecognition();
      else this.setState('idle');
      return;
    }
    if (this.muted) {
      this.queue = [];
      this.speaking = false;
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.pickVoice();
    if (voice) utterance.voice = voice;
    utterance.rate = Math.min(2, Math.max(0.5, this.options.rate || 1));
    utterance.pitch = Math.min(2, Math.max(0, this.options.pitch || 1));

    utterance.onstart = () => {
      this.speaking = true;
      this.pauseListening();
      this.setState('speaking');
    };
    utterance.onend = () => {
      this.next();
    };
    utterance.onerror = () => {
      this.next();
    };
    window.speechSynthesis.speak(utterance);
  }

  cancelSpeech(): void {
    this.queue = [];
    this.buffer = '';
    this.speaking = false;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    if (this.state === 'speaking') this.setState(this.wantListening ? 'listening' : 'idle');
  }

  /* ------------------------------ VAD ------------------------------ */

  private async startAnalyser(): Promise<void> {
    if (this.analyser) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.mediaStream = stream;
      const context = new AudioContext();
      this.audioContext = context;
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.analyser = analyser;

      const data = new Uint8Array(analyser.fftSize);
      const tick = (): void => {
        if (!this.analyser) return;
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const value = (data[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / data.length);
        this.onLevel?.(Math.min(1, rms * 4));
        if (this.state === 'speaking' && this.options.bargeIn && rms > 0.14) {
          // The owner is talking over BLOBS: stop immediately and listen.
          this.bargeWindow += 1;
          if (this.bargeWindow > 4) {
            this.bargeWindow = 0;
            this.interrupt();
          }
        } else {
          this.bargeWindow = 0;
        }
        this.vadFrame = requestAnimationFrame(tick);
      };
      this.vadFrame = requestAnimationFrame(tick);
    } catch {
      // A missing mic must not break the session; recognition will report its own error.
    }
  }

  private bargeWindow = 0;

  private stopAnalyser(): void {
    cancelAnimationFrame(this.vadFrame);
    this.analyser = null;
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
  }
}

export const speechSupported = (): boolean =>
  typeof window !== 'undefined' &&
  Boolean(
    (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition,
  );
