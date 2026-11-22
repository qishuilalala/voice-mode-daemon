import {
  CloudDictationSession,
  FocusTextInjector,
  PlaybackQueue,
  type AudioSink,
  type CloudDictationSessionOptions,
} from '@voice-mode/browser';
import {
  DEFAULT_DAEMON_BASE_URL,
  DaemonClient,
  KOKORO_DEFAULT_SPEAKERS,
  OpenAiCompatAsrTransport,
  OpenAiCompatTtsEngine,
  SentenceSegmenter,
  compileEmotionPlan,
  createAsrReplacer,
  redactSecrets,
  validateReplacements,
  type AsrReplacement,
  type AsrReplacer,
  type AsrTransport,
  type DaemonHealthResult,
  type OpenAiCompatAsrOptions,
  type OpenAiCompatTtsOptions,
  type TtsEngine,
  type TtsSynthOptions,
  type TtsSynthResult,
} from '@voice-mode/core';

export const SPEECH_SYNTHESIS_MIME = 'application/x-speech-synthesis';
export const DEFAULT_EXTENSION_PROBE_TIMEOUT_MS = 500;

const PENDING_SPEECH_TEXT = new WeakMap<Uint8Array, string>();

export type SpeakWithBrowserFn = (plainText: string, rate: number, signal?: AbortSignal) => Promise<void>;

export function createDefaultBrowserSpeaker(): SpeakWithBrowserFn {
  return async (plainText: string, rate: number, signal?: AbortSignal): Promise<void> => {
    if (
      typeof globalThis.speechSynthesis === 'undefined' ||
      typeof globalThis.SpeechSynthesisUtterance === 'undefined' ||
      !plainText.trim()
    ) {
      return;
    }

    const synth = globalThis.speechSynthesis;
    const voices = typeof synth.getVoices === 'function' ? synth.getVoices() : [];
    if (voices.length === 0) {
      // Headless / Chrome for Testing environments without OS TTS voices resolve immediately without hanging.
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        try {
          synth.cancel();
        } catch {
          // Ignore teardown errors.
        }
        finish();
      };
      const utterance = new globalThis.SpeechSynthesisUtterance(plainText);
      utterance.rate = Math.min(2.0, Math.max(0.5, rate));
      utterance.onend = finish;
      utterance.onerror = finish;
      signal?.addEventListener('abort', onAbort, { once: true });
      const safetyTimer = setTimeout(finish, Math.max(1_500, plainText.length * 120));
      try {
        synth.speak(utterance);
      } catch {
        finish();
      }
    });
  };
}

export function createBrowserWebAudioSink(
  onBrowserFallbackPayload: (payload: TtsSynthResult, signal: AbortSignal) => Promise<void>,
): AudioSink {
  let activeAudioCtx: AudioContext | null = null;
  let activeSource: AudioBufferSourceNode | null = null;

  return {
    async play(payload: TtsSynthResult, signal: AbortSignal): Promise<void> {
      if (signal.aborted) return;
      if (payload.mime === SPEECH_SYNTHESIS_MIME) {
        await onBrowserFallbackPayload(payload, signal);
        return;
      }
      if (payload.audio.byteLength === 0) return;

      const AudioCtxCtor =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (typeof AudioCtxCtor !== 'function') {
        return;
      }

      if (!activeAudioCtx || activeAudioCtx.state === 'closed') {
        activeAudioCtx = new AudioCtxCtor();
      }
      if (activeAudioCtx.state === 'suspended') {
        await activeAudioCtx.resume().catch(() => undefined);
      }

      const copy = new ArrayBuffer(payload.audio.byteLength);
      new Uint8Array(copy).set(payload.audio);
      const decoded = await activeAudioCtx.decodeAudioData(copy);
      if (signal.aborted) return;

      await new Promise<void>((resolve) => {
        let settled = false;
        const src = activeAudioCtx!.createBufferSource();
        src.buffer = decoded;
        src.connect(activeAudioCtx!.destination);
        activeSource = src;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (activeSource === src) activeSource = null;
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          try {
            src.stop();
          } catch {
            // Already stopped.
          }
          finish();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        src.onended = finish;
        try {
          src.start(0);
        } catch {
          finish();
        }
      });
    },
    pause() {
      void activeAudioCtx?.suspend().catch(() => undefined);
    },
    resume() {
      void activeAudioCtx?.resume().catch(() => undefined);
    },
    stop() {
      try {
        activeSource?.stop();
      } catch {
        // Ignore.
      }
      activeSource = null;
      if (typeof globalThis.speechSynthesis !== 'undefined') {
        try {
          globalThis.speechSynthesis.cancel();
        } catch {
          // Ignore.
        }
      }
    },
  };
}

class BrowserSpeechFallbackTts implements TtsEngine {
  readonly kind = 'system' as const;
  readonly mime = SPEECH_SYNTHESIS_MIME;
  private rate = 1.0;

  updateVoice(_voice: string, rate?: number): void {
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
      this.rate = rate;
    }
  }

  async prepare(): Promise<void> {}

  status() {
    return { engine: this.kind, ready: true, loading: false };
  }

  interrupt(): void {
    if (typeof globalThis.speechSynthesis !== 'undefined') {
      try {
        globalThis.speechSynthesis.cancel();
      } catch {
        // Ignore.
      }
    }
  }

  async synthesize(text: string, options?: TtsSynthOptions): Promise<TtsSynthResult> {
    const plan = compileEmotionPlan(text, 'strip');
    const marker = new Uint8Array(1);
    PENDING_SPEECH_TEXT.set(marker, plan.plainText);
    if (typeof options?.rate === 'number' && Number.isFinite(options.rate) && options.rate > 0) {
      this.rate = options.rate;
    }
    return {
      audio: marker,
      mime: SPEECH_SYNTHESIS_MIME,
    };
  }

  getRate(): number {
    return this.rate;
  }

  async close(): Promise<void> {
    this.interrupt();
  }
}

class OfflineFallbackAsr implements AsrTransport {
  readonly kind = 'openai-compat' as const;
  async start(): Promise<void> {}
  pushAudio(): void {}
  async finalize() {
    return { text: '', isFinal: true, durationMs: 0 };
  }
  async transcribe(pcm16k: Float32Array, options?: { sampleRate?: number }) {
    const sr = options?.sampleRate ?? 16_000;
    return {
      text: '',
      isFinal: true,
      durationMs: Math.round((pcm16k.length / sr) * 1000),
    };
  }
  abort(): void {}
  async close(): Promise<void> {}
}

export interface VoiceExtensionCoordinatorOptions {
  daemonBaseUrl?: string;
  daemonToken?: string;
  voice?: string;
  rate?: number;
  asrModel?: 'zipformer2' | 'sensevoice';
  language?: string;
  probeTimeoutMs?: number;
  replacements?: ReadonlyArray<AsrReplacement>;
  byokTts?: OpenAiCompatTtsOptions;
  byokAsr?: OpenAiCompatAsrOptions;
  sink?: AudioSink;
  speakWithBrowserSynthesis?: SpeakWithBrowserFn;
  onSentencePlayStart?: (sentence: string) => void;
  onFallback?: (surface: 'asr' | 'tts', reason: string) => void;
  onError?: (message: string) => void;
}

export interface TranscriptionSummary {
  rawText: string;
  replacedText: string;
  language?: string;
  durationMs: number;
  usedFallback: boolean;
  fallbackReason?: string;
}

export class VoiceExtensionCoordinator {
  private daemonClient: DaemonClient;
  private readonly playbackQueue: PlaybackQueue;
  private readonly browserFallbackTts = new BrowserSpeechFallbackTts();
  private readonly speakBrowserFn: SpeakWithBrowserFn;
  private replacer: AsrReplacer;
  private readonly onFallbackHook?: (surface: 'asr' | 'tts', reason: string) => void;
  private readonly onErrorHook?: (message: string) => void;

  public lastFallbackSurface: 'asr' | 'tts' | null = null;
  public lastFallbackReason: string | null = null;

  constructor(options: VoiceExtensionCoordinatorOptions = {}) {
    this.speakBrowserFn = options.speakWithBrowserSynthesis ?? createDefaultBrowserSpeaker();
    this.replacer = createAsrReplacer(options.replacements ?? []);
    if (options.onFallback) this.onFallbackHook = options.onFallback;
    if (options.onError) this.onErrorHook = options.onError;

    this.daemonClient = this.buildDaemonClient(options);

    const effectiveSink =
      options.sink ??
      createBrowserWebAudioSink((payload, sig) => this.playBrowserFallbackPayload(payload, sig));

    this.playbackQueue = new PlaybackQueue({
      prefetchDepth: 2,
      sink: effectiveSink,
      synthesize: async (sentence, signal) => {
        return this.daemonClient.tts.synthesize(sentence, { signal });
      },
      ...(options.onSentencePlayStart ? { onPlayStart: options.onSentencePlayStart } : {}),
      onError: (err) => {
        const safe = redactSecrets(err instanceof Error ? err.message : String(err));
        this.onErrorHook?.(safe);
      },
    });
  }

  private buildDaemonClient(options: VoiceExtensionCoordinatorOptions): DaemonClient {
    const boundBrowserFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

    const fallbackTts: TtsEngine = options.byokTts
      ? new OpenAiCompatTtsEngine({
          fetchImpl: boundBrowserFetch,
          ...options.byokTts,
        })
      : this.browserFallbackTts;

    const fallbackAsr: AsrTransport = options.byokAsr
      ? new OpenAiCompatAsrTransport({
          fetchImpl: boundBrowserFetch,
          ...options.byokAsr,
        })
      : new OfflineFallbackAsr();

    return new DaemonClient({
      baseUrl: options.daemonBaseUrl ?? DEFAULT_DAEMON_BASE_URL,
      ...(options.daemonToken ? { token: options.daemonToken } : {}),
      voice: options.voice ?? KOKORO_DEFAULT_SPEAKERS[0]?.id ?? 'zf_001',
      rate: options.rate ?? 1.0,
      asrModel: options.asrModel ?? 'zipformer2',
      ...(options.language ? { language: options.language } : {}),
      probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_EXTENSION_PROBE_TIMEOUT_MS,
      cooldownMs: 3_000,
      healthTtlMs: 5_000,
      fetchImpl: boundBrowserFetch,
      fallbackTts,
      fallbackAsr,
      onFallback: (surface, reason) => {
        const safeReason = redactSecrets(reason);
        this.lastFallbackSurface = surface;
        this.lastFallbackReason = safeReason;
        this.onFallbackHook?.(surface, safeReason);
      },
    });
  }

  async reconfigure(options: VoiceExtensionCoordinatorOptions): Promise<void> {
    this.playbackQueue.cancel();
    await this.daemonClient.close();
    if (options.replacements) {
      this.updateReplacements(options.replacements);
    }
    this.lastFallbackSurface = null;
    this.lastFallbackReason = null;
    this.daemonClient = this.buildDaemonClient(options);
  }

  updateReplacements(rules: unknown): { ok: boolean; error?: string } {
    const validated = validateReplacements(rules);
    if (!validated.ok) {
      return { ok: false, error: validated.error };
    }
    this.replacer = createAsrReplacer(validated.rules);
    return { ok: true };
  }

  async probeHealth(): Promise<DaemonHealthResult> {
    this.daemonClient.resetHealthCache();
    return this.daemonClient.probeHealth();
  }

  async synthesizeOnce(
    text: string,
    opts?: { voice?: string; rate?: number },
  ): Promise<{ result: TtsSynthResult; usedFallback: boolean; elapsedMs: number }> {
    this.lastFallbackSurface = null;
    this.lastFallbackReason = null;
    const t0 = performance.now();
    const synthOpts: TtsSynthOptions = {};
    if (opts?.voice !== undefined) synthOpts.voice = opts.voice;
    if (opts?.rate !== undefined) synthOpts.rate = opts.rate;
    const result = await this.daemonClient.tts.synthesize(text, synthOpts);
    const elapsedMs = Math.round(performance.now() - t0);
    return {
      result,
      usedFallback: this.lastFallbackSurface === 'tts',
      elapsedMs,
    };
  }

  async playBrowserFallbackPayload(payload: TtsSynthResult, signal?: AbortSignal): Promise<void> {
    const text = PENDING_SPEECH_TEXT.get(payload.audio) ?? '';
    if (!text) return;
    await this.speakBrowserFn(text, this.browserFallbackTts.getRate(), signal);
  }

  async readMarkdownAloud(markdown: string): Promise<string[]> {
    const segmenter = new SentenceSegmenter({ tablePolicy: 'skip' });
    const sentences = [...segmenter.feed(markdown), ...segmenter.flush()];
    for (const sentence of sentences) {
      this.playbackQueue.enqueue(sentence);
    }
    return sentences;
  }

  pausePlayback(): boolean {
    return this.playbackQueue.pause();
  }

  resumePlayback(): boolean {
    return this.playbackQueue.resume();
  }

  stopPlayback(): void {
    this.playbackQueue.cancel();
    this.daemonClient.tts.interrupt?.();
  }

  async waitUntilPlaybackIdle(): Promise<void> {
    await this.playbackQueue.waitUntilDrained();
  }

  async transcribeAudio(
    pcm16k: Float32Array,
    sampleRate: number = 16_000,
  ): Promise<TranscriptionSummary> {
    this.lastFallbackSurface = null;
    this.lastFallbackReason = null;
    const event = await this.daemonClient.asr.transcribe!(pcm16k, { sampleRate });
    const replaced = this.replacer(event.text, true);
    const usedFallback = this.lastFallbackSurface === 'asr';
    return {
      rawText: event.text,
      replacedText: replaced,
      ...(event.language ? { language: event.language } : {}),
      durationMs: event.durationMs ?? 0,
      usedFallback,
      ...(usedFallback && this.lastFallbackReason
        ? { fallbackReason: this.lastFallbackReason }
        : {}),
    };
  }

  createDictationSession(
    hooks: Pick<
      CloudDictationSessionOptions,
      'captureAudio' | 'onStateChange' | 'onSpeechActivity' | 'onFinalTranscript' | 'onError'
    >,
  ): CloudDictationSession {
    return new CloudDictationSession({
      transport: this.daemonClient.asr,
      ...hooks,
      onFinalTranscript: (rawText, info) => {
        const replaced = this.replacer(rawText, true);
        hooks.onFinalTranscript?.(replaced, info);
      },
    });
  }

  async dispose(): Promise<void> {
    this.playbackQueue.dispose();
    await this.daemonClient.close();
  }
}

const CHAT_REPLY_SELECTORS = [
  '[data-message-author-role="assistant"]',
  '.ds-markdown',
  'message-content',
  '.markdown-body',
  'article',
  'main',
];

export function extractReadableSelectionOrReply(doc: Document): string {
  const selected = doc.getSelection?.()?.toString().trim() ?? '';
  if (selected.length > 0) {
    return selected;
  }

  for (const selector of CHAT_REPLY_SELECTORS) {
    const nodes = doc.querySelectorAll(selector);
    if (nodes.length > 0) {
      const lastNode = nodes[nodes.length - 1];
      const text = lastNode?.textContent?.trim() ?? '';
      if (text.length > 0) {
        return text;
      }
    }
  }
  return '';
}

export function injectDictatedTextIntoPage(
  doc: Document,
  text: string,
  rules: ReadonlyArray<AsrReplacement> = [],
): boolean {
  const replacer = rules.length > 0 ? createAsrReplacer(rules) : undefined;
  const injector = new FocusTextInjector(replacer ? { replacer } : {});
  return injector.inject(doc, text);
}
