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
  KOKORO_F0,
  KOKORO_NAMED,
  KOKORO_PINNED,
  KOKORO_POPULAR_MALE,
  KOKORO_SPEAKERS_103,
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
import { message } from './i18n.ts';

export const SPEECH_SYNTHESIS_MIME = 'text/x-speech-synthesis-utf8';
export const DEFAULT_EXTENSION_PROBE_TIMEOUT_MS = 500;

const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8');

export interface VoiceSelectOption {
  value: string;
  label: string;
}

const ZH_MALE_STYLES: Readonly<Record<string, string>> = {
  deep: '低沉男声',
  rich: '浑厚男声',
  clear: '清亮男声',
  magnetic: '磁性男声',
};

/**
 * Build dynamic `<select>` options for all 103 Kokoro voices (`health.voices`),
 * ordering curated defaults & popular voices first while keeping all 103 voices selectable.
 */
export function buildKokoroVoiceSelectOptions(
  voices: readonly string[] = KOKORO_SPEAKERS_103,
  language: 'en' | 'zh-CN' = 'en',
): VoiceSelectOption[] {
  const source = voices.length > 0 ? voices : KOKORO_SPEAKERS_103;
  const chinese = language === 'zh-CN';
  const sidByName = new Map<string, number>();
  KOKORO_SPEAKERS_103.forEach((id, sid) => sidByName.set(id.toLowerCase(), sid));

  const formatLabel = (voiceId: string): string => {
    const sid = sidByName.get(voiceId.toLowerCase());
    if (sid === undefined) return voiceId;
    const named = KOKORO_NAMED[sid];
    const maleStyle = KOKORO_POPULAR_MALE[sid];
    const hz = KOKORO_F0[sid];
    const parts = [voiceId];
    if (named) parts.push(chinese ? named.zh : `${named.en}/${named.zh}`);
    if (maleStyle) parts.push(chinese ? (ZH_MALE_STYLES[maleStyle] ?? '男声') : `${maleStyle} male`);
    else if (voiceId.startsWith('af_')) parts.push(chinese ? '美式英语女声' : 'EN-US female');
    else if (voiceId.startsWith('bf_')) parts.push(chinese ? '英式英语' : 'EN-GB');
    else if (typeof hz === 'number') {
      if (chinese) parts.push(`${hz < 180 ? '男声' : '女声'} ${hz} Hz`);
      else parts.push(`${hz < 180 ? 'male' : 'female'} ${hz}Hz`);
    }
    return parts.join(' · ');
  };

  const priorityIds = [
    ...KOKORO_DEFAULT_SPEAKERS.map((s) => KOKORO_SPEAKERS_103[s.sid] ?? s.id),
    ...KOKORO_PINNED.map((sid) => KOKORO_SPEAKERS_103[sid]).filter((v): v is string => Boolean(v)),
  ];

  const ordered: string[] = [];
  const seen = new Set<string>();
  const available = new Set(source);

  for (const id of priorityIds) {
    if (available.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const id of source) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }

  return ordered.map((value) => ({ value, label: formatLabel(value) }));
}

export type SpeakWithBrowserFn = (
  plainText: string,
  rate: number,
  signal?: AbortSignal,
) => Promise<void>;

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
    if (typeof options?.rate === 'number' && Number.isFinite(options.rate) && options.rate > 0) {
      this.rate = options.rate;
    }
    return {
      audio: UTF8_ENCODER.encode(plan.plainText),
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

function unavailableAsrError(): Error {
  return new Error(
    message(
      'asrFallbackUnavailable',
      undefined,
      'Local voice-daemon is offline; configure BYOK ASR in Side Panel or use browser SpeechRecognition dictation.',
    ),
  );
}

class UnconfiguredFallbackAsr implements AsrTransport {
  readonly kind = 'openai-compat' as const;
  async start(): Promise<void> {
    throw unavailableAsrError();
  }
  pushAudio(): void {}
  async finalize(): Promise<never> {
    throw unavailableAsrError();
  }
  async transcribe(): Promise<never> {
    throw unavailableAsrError();
  }
  abort(): void {}
  async close(): Promise<void> {}
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
    | ((ev: {
        resultIndex?: number;
        results: ArrayLike<{ isFinal?: boolean; 0?: { transcript?: string } }>;
      }) => void)
    | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface WebSpeechDictationOptions {
  SpeechRecognitionCtor?: new () => SpeechRecognitionLike;
  language?: string;
  replacements?: ReadonlyArray<AsrReplacement>;
  onFinalTranscript: (text: string) => void;
  onStateChange?: (active: boolean) => void;
  onError?: (err: Error) => void;
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
  private hasByokAsr = false;
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

    this.hasByokAsr = Boolean(options.byokAsr);
    const fallbackAsr: AsrTransport = options.byokAsr
      ? new OpenAiCompatAsrTransport({
          fetchImpl: boundBrowserFetch,
          ...options.byokAsr,
        })
      : new UnconfiguredFallbackAsr();

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

  hasConfiguredByokAsr(): boolean {
    return this.hasByokAsr;
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

  async playBrowserFallbackPayload(payload: TtsSynthResult, signal?: AbortSignal): Promise<void> {
    const text = UTF8_DECODER.decode(payload.audio).trim();
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

  startWebSpeechFallbackDictation(opts: WebSpeechDictationOptions): { stop(): void } {
    const g = globalThis as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = opts.SpeechRecognitionCtor ?? g.SpeechRecognition ?? g.webkitSpeechRecognition;
    if (!Ctor) {
      throw new Error(
        message(
          'browserAsrUnavailable',
          undefined,
          'Browser SpeechRecognition is unavailable; start local voice-daemon or configure BYOK ASR.',
        ),
      );
    }

    const effectiveReplacer = opts.replacements
      ? createAsrReplacer(opts.replacements)
      : this.replacer;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    if (opts.language) {
      recognition.lang = opts.language;
    }

    recognition.onresult = (ev) => {
      const startIdx = ev.resultIndex ?? 0;
      for (let i = startIdx; i < ev.results.length; i += 1) {
        const item = ev.results[i];
        if (item?.isFinal === false) continue;
        const raw = item?.[0]?.transcript?.trim() ?? '';
        if (raw) {
          opts.onFinalTranscript(effectiveReplacer(raw, true));
        }
      }
    };
    recognition.onerror = (ev) => {
      const details = ev.error ?? 'unknown';
      const fallback = `Browser SpeechRecognition error: ${details}`;
      let errorMessage = message('browserAsrError', [details], fallback);
      if (details === 'not-allowed' || details === 'service-not-allowed') {
        errorMessage = message('browserAsrNotAllowed', undefined, errorMessage);
      } else if (details === 'audio-capture') {
        errorMessage = message('browserAsrNoCapture', undefined, errorMessage);
      } else if (details === 'no-speech') {
        errorMessage = message('browserAsrNoSpeech', undefined, errorMessage);
      }
      opts.onError?.(new Error(errorMessage));
    };
    recognition.onend = () => {
      opts.onStateChange?.(false);
    };

    recognition.start();
    opts.onStateChange?.(true);

    return {
      stop() {
        try {
          recognition.stop();
        } catch {
          // Ignore teardown errors.
        }
      },
    };
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
