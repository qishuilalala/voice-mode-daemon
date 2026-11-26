import { cpus } from 'node:os';
import { join } from 'node:path';
import {
  KOKORO_SPEAKERS_103,
  compileEmotionPlan,
  encodeMonoPcm16Wav,
  findKokoroVoice,
} from '@voice-mode/core';
import {
  resolveInstalledBundleDir,
  type DaemonBundleId,
  type ModelCacheOptions,
} from './model-cache.js';

/**
 * Authoritative 103-speaker canonical table (`0..102`) shared with `@voice-mode/core` and `voices.bin`.
 */
export const KOKORO_SPEAKER_NAMES: ReadonlyArray<string> = KOKORO_SPEAKERS_103;
export const KOKORO_EXPOSED_VOICES: ReadonlyArray<string> = KOKORO_SPEAKERS_103;

const DEFAULT_KOKORO_SID = 3; // zf_001
const WHISPER_GAIN = 0.5;
const KOKORO_MIN_SPEED = 0.5;
const KOKORO_MAX_SPEED = 2.0;

export function resolveKokoroSpeakerId(voice: string | undefined): number {
  if (typeof voice !== 'string') return DEFAULT_KOKORO_SID;
  const trimmed = voice.trim();
  if (!trimmed) return DEFAULT_KOKORO_SID;

  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < KOKORO_SPEAKER_NAMES.length
      ? parsed
      : DEFAULT_KOKORO_SID;
  }

  const match = findKokoroVoice(trimmed);
  return match ? match.sid : DEFAULT_KOKORO_SID;
}

export function clampKokoroSpeed(speed: number | undefined): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed <= 0) {
    return 1.0;
  }
  return Math.min(KOKORO_MAX_SPEED, Math.max(KOKORO_MIN_SPEED, speed));
}

export interface KokoroTtsInstance {
  readonly sampleRate: number;
  readonly numSpeakers: number;
  synthesize(
    text: string,
    sid: number,
    speed: number,
  ): Promise<{ samples: Float32Array; sampleRate: number }>;
}

/** Incremental recognition session for the streaming (WS) transcription path. */
export interface StreamingAsrSession {
  accept(samples: Float32Array, sampleRate: number): void;
  partial(): string;
  finish(): { text: string; language?: string };
  close(): void;
}

export interface AsrRecognizerInstance {
  transcribe(
    samples: Float32Array,
    sampleRate: number,
    language?: string,
  ): Promise<{ text: string; language?: string }>;
  /** Optional streaming session factory (zipformer2 OnlineRecognizer). */
  createStreamingSession?(): StreamingAsrSession;
}

export interface NativeSpeechBackend {
  createKokoroTts(bundleDir: string, numThreads: number): Promise<KokoroTtsInstance>;
  createZipformer2Recognizer(bundleDir: string, numThreads: number): Promise<AsrRecognizerInstance>;
  createSenseVoiceRecognizer(bundleDir: string, numThreads: number): Promise<AsrRecognizerInstance>;
}

function defaultThreadCount(): number {
  const logical = cpus().length;
  return Math.max(1, Math.min(4, Math.floor(logical / 2) || 1));
}

export function createSherpaNodeBackend(): NativeSpeechBackend {
  return {
    async createKokoroTts(bundleDir: string, numThreads: number): Promise<KokoroTtsInstance> {
      const mod = await import('sherpa-onnx-node');
      const sherpa = 'default' in mod ? (mod.default as typeof mod) : mod;
      const tts = await sherpa.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: join(bundleDir, 'model.int8.onnx'),
            voices: join(bundleDir, 'voices.bin'),
            tokens: join(bundleDir, 'tokens.txt'),
            dataDir: join(bundleDir, 'espeak-ng-data'),
            lexicon: `${join(bundleDir, 'lexicon-us-en.txt')},${join(bundleDir, 'lexicon-zh.txt')}`,
          },
          numThreads,
          debug: 0,
          provider: 'cpu',
        },
        ruleFsts: [
          join(bundleDir, 'phone-zh.fst'),
          join(bundleDir, 'date-zh.fst'),
          join(bundleDir, 'number-zh.fst'),
        ].join(','),
        maxNumSentences: 1,
      });
      return {
        sampleRate: tts.sampleRate || 24_000,
        numSpeakers: tts.numSpeakers || 103,
        async synthesize(text: string, sid: number, speed: number) {
          const out = await tts.generateAsync({ text, sid, speed });
          return {
            samples: out.samples instanceof Float32Array ? out.samples : new Float32Array(0),
            sampleRate: out.sampleRate || tts.sampleRate || 24_000,
          };
        },
      };
    },

    async createZipformer2Recognizer(
      bundleDir: string,
      numThreads: number,
    ): Promise<AsrRecognizerInstance> {
      const mod = await import('sherpa-onnx-node');
      const sherpa = 'default' in mod ? (mod.default as typeof mod) : mod;
      const recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: join(bundleDir, 'encoder.int8.onnx'),
            decoder: join(bundleDir, 'decoder.onnx'),
            joiner: join(bundleDir, 'joiner.int8.onnx'),
          },
          tokens: join(bundleDir, 'tokens.txt'),
          numThreads,
          provider: 'cpu',
          debug: 0,
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: 0,
      });

      const decodeAvailable = (stream: ReturnType<typeof recognizer.createStream>): string => {
        while (recognizer.isReady(stream)) {
          recognizer.decode(stream);
        }
        const res = recognizer.getResult(stream);
        return (res.text ?? '').trim();
      };
      return {
        async transcribe(samples: Float32Array, sampleRate: number) {
          const tailPad = Math.round(sampleRate * 0.5);
          const padded = new Float32Array(samples.length + tailPad);
          padded.set(samples, 0);
          const stream = recognizer.createStream();
          stream.acceptWaveform({ samples: padded, sampleRate });
          stream.inputFinished();
          const text = decodeAvailable(stream);
          return { text, language: 'zh' };
        },
        createStreamingSession() {
          const stream = recognizer.createStream();
          return {
            accept(samples: Float32Array, sampleRate: number) {
              stream.acceptWaveform({ samples, sampleRate });
              decodeAvailable(stream);
            },
            partial() {
              const res = recognizer.getResult(stream);
              return (res.text ?? '').trim();
            },
            finish() {
              stream.inputFinished();
              const text = decodeAvailable(stream);
              return { text, language: 'zh' };
            },
            close() {},
          };
        },
      };
    },

    async createSenseVoiceRecognizer(
      bundleDir: string,
      numThreads: number,
    ): Promise<AsrRecognizerInstance> {
      const mod = await import('sherpa-onnx-node');
      const sherpa = 'default' in mod ? (mod.default as typeof mod) : mod;
      const recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: join(bundleDir, 'model.int8.onnx'),
            language: 'auto',
            useInverseTextNormalization: 1,
          },
          tokens: join(bundleDir, 'tokens.txt'),
          numThreads,
          provider: 'cpu',
          debug: 0,
        },
      });

      return {
        async transcribe(samples: Float32Array, sampleRate: number) {
          const stream = recognizer.createStream();
          stream.acceptWaveform({ samples, sampleRate });
          const res = await recognizer.decodeAsync(stream);
          const cleanLang = normalizeSenseVoiceLang(res.lang);
          return {
            text: (res.text ?? '').trim(),
            ...(cleanLang ? { language: cleanLang } : {}),
          };
        },
      };
    },
  };
}

function normalizeSenseVoiceLang(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(/^<\|/, '').replace(/\|>$/, '').trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : undefined;
}

export class ModelNotInstalledError extends Error {
  readonly bundleId: DaemonBundleId;
  constructor(bundleId: DaemonBundleId) {
    super(
      `Model bundle "${bundleId}" is not installed in shared cache. Run: voice-daemon models download ${bundleId}`,
    );
    this.name = 'ModelNotInstalledError';
    this.bundleId = bundleId;
  }
}

class LazyModelSlot<T> {
  private instance: T | null = null;
  private inflight: Promise<T> | null = null;
  readonly bundleId: DaemonBundleId;
  private readonly loadFn: () => Promise<T>;

  constructor(bundleId: DaemonBundleId, loadFn: () => Promise<T>) {
    this.bundleId = bundleId;
    this.loadFn = loadFn;
  }

  isLoaded(): boolean {
    return this.instance !== null;
  }

  ensure(): Promise<T> {
    if (this.instance !== null) return Promise.resolve(this.instance);
    if (!this.inflight) {
      this.inflight = this.loadFn()
        .then((inst) => {
          this.instance = inst;
          return inst;
        })
        .catch((err: unknown) => {
          this.inflight = null;
          throw err;
        });
    }
    return this.inflight;
  }
}

export interface SpeechEngineRegistryOptions extends ModelCacheOptions {
  backend?: NativeSpeechBackend;
  numThreads?: number;
  resolveBundleDir?: (bundleId: DaemonBundleId) => Promise<string | null>;
}

export class SpeechEngineRegistry {
  private readonly backend: NativeSpeechBackend;
  private readonly numThreads: number;
  private readonly resolveDirFn: (bundleId: DaemonBundleId) => Promise<string | null>;

  private readonly kokoroSlot: LazyModelSlot<KokoroTtsInstance>;
  private readonly zipformerSlot: LazyModelSlot<AsrRecognizerInstance>;
  private readonly senseVoiceSlot: LazyModelSlot<AsrRecognizerInstance>;

  // Serialize native ONNX TTS calls across concurrent HTTP clients on the single shared instance
  private ttsQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SpeechEngineRegistryOptions = {}) {
    this.backend = options.backend ?? createSherpaNodeBackend();
    this.numThreads = options.numThreads ?? defaultThreadCount();
    this.resolveDirFn =
      options.resolveBundleDir ??
      ((bundleId) => resolveInstalledBundleDir(bundleId, options));

    this.kokoroSlot = new LazyModelSlot('kokoro-int8', async () => {
      const dir = await this.resolveDirFn('kokoro-int8');
      if (!dir) throw new ModelNotInstalledError('kokoro-int8');
      return this.backend.createKokoroTts(dir, this.numThreads);
    });
    this.zipformerSlot = new LazyModelSlot('zipformer2', async () => {
      const dir = await this.resolveDirFn('zipformer2');
      if (!dir) throw new ModelNotInstalledError('zipformer2');
      return this.backend.createZipformer2Recognizer(dir, this.numThreads);
    });
    this.senseVoiceSlot = new LazyModelSlot('sensevoice-int8', async () => {
      const dir = await this.resolveDirFn('sensevoice-int8');
      if (!dir) throw new ModelNotInstalledError('sensevoice-int8');
      return this.backend.createSenseVoiceRecognizer(dir, this.numThreads);
    });
  }

  /** Open a streaming ASR session on the shared zipformer2 OnlineRecognizer. */
  async createStreamingAsrSession(): Promise<StreamingAsrSession> {
    const recognizer = await this.zipformerSlot.ensure();
    if (!recognizer.createStreamingSession) {
      throw new Error('zipformer2 recognizer does not support streaming sessions');
    }
    return recognizer.createStreamingSession();
  }

  modelsLoaded(): DaemonBundleId[] {
    const out: DaemonBundleId[] = [];
    for (const slot of [this.kokoroSlot, this.zipformerSlot, this.senseVoiceSlot]) {
      if (slot.isLoaded()) out.push(slot.bundleId);
    }
    return out;
  }

  instanceCount(): number {
    return this.modelsLoaded().length;
  }

  async synthesizeSpeechWav(input: {
    text: string;
    voice?: string;
    speed?: number;
  }): Promise<{ wav: Uint8Array; sampleRate: number; sid: number }> {
    const plan = compileEmotionPlan(input.text, 'pcm-segments');
    if (plan.segments.length === 0) {
      return {
        wav: encodeMonoPcm16Wav(new Float32Array(0), 24_000),
        sampleRate: 24_000,
        sid: resolveKokoroSpeakerId(input.voice),
      };
    }

    const sid = resolveKokoroSpeakerId(input.voice);
    const speed = clampKokoroSpeed(input.speed);
    const tts = await this.kokoroSlot.ensure();

    const runSynthesis = async () => {
      const startsWithBreak = /^\s*<\s*break\b/i.test(input.text);
      const chunks: Float32Array[] = [];
      let totalSamples = 0;
      let effectiveRate = tts.sampleRate || 24_000;

      for (let idx = 0; idx < plan.segments.length; idx += 1) {
        const seg = plan.segments[idx];
        if (!seg) continue;

        const pauseSamples =
          seg.preBreakMs && seg.preBreakMs > 0
            ? Math.round((seg.preBreakMs / 1000) * effectiveRate)
            : 0;

        if (pauseSamples > 0 && idx === 0 && startsWithBreak) {
          chunks.push(new Float32Array(pauseSamples));
          totalSamples += pauseSamples;
        }

        const generated = await tts.synthesize(seg.text, sid, speed);
        effectiveRate = generated.sampleRate || effectiveRate;
        const pcm = generated.samples;
        if (seg.whisper) {
          const whispered = new Float32Array(pcm.length);
          for (let i = 0; i < pcm.length; i += 1) {
            whispered[i] = (pcm[i] ?? 0) * WHISPER_GAIN;
          }
          chunks.push(whispered);
          totalSamples += whispered.length;
        } else {
          chunks.push(pcm);
          totalSamples += pcm.length;
        }

        if (pauseSamples > 0 && !(idx === 0 && startsWithBreak)) {
          const postBreakSamples = Math.round((seg.preBreakMs! / 1000) * effectiveRate);
          chunks.push(new Float32Array(postBreakSamples));
          totalSamples += postBreakSamples;
        }
      }

      const combined = new Float32Array(totalSamples);
      let offset = 0;
      for (const ch of chunks) {
        combined.set(ch, offset);
        offset += ch.length;
      }

      return {
        wav: encodeMonoPcm16Wav(combined, effectiveRate),
        sampleRate: effectiveRate,
        sid,
      };
    };

    const next = this.ttsQueue.then(runSynthesis, runSynthesis);
    this.ttsQueue = next.catch(() => undefined);
    return next;
  }

  async transcribeAudio(input: {
    samples: Float32Array;
    sampleRate: number;
    model?: string;
    language?: string;
  }): Promise<{ text: string; language?: string; durationMs: number }> {
    const durationMs =
      input.sampleRate > 0 ? Math.round((input.samples.length / input.sampleRate) * 1000) : 0;
    if (input.samples.length === 0) {
      return { text: '', durationMs: 0 };
    }

    const normalizedModel = (input.model ?? 'sensevoice').trim().toLowerCase();
    const useZipformer =
      normalizedModel === 'zipformer2' ||
      normalizedModel === 'zipformer' ||
      normalizedModel === 'streaming-zipformer';

    const recognizer = useZipformer
      ? await this.zipformerSlot.ensure()
      : await this.senseVoiceSlot.ensure();
    const res = await recognizer.transcribe(input.samples, input.sampleRate, input.language);
    const effectiveLang = normalizeSenseVoiceLang(res.language ?? input.language);

    return {
      text: res.text,
      ...(effectiveLang ? { language: effectiveLang } : {}),
      durationMs,
    };
  }
}
