import { cpus } from 'node:os';
import { join } from 'node:path';
import { compileEmotionPlan, encodeMonoPcm16Wav } from '@voice-mode/core';
import {
  resolveInstalledBundleDir,
  type DaemonBundleId,
  type ModelCacheOptions,
} from './model-cache.js';

/**
 * Exact 103-speaker canonical table embedded in `csukuangfj/kokoro-int8-multi-lang-v1_1` (`0..102`).
 */
export const KOKORO_SPEAKER_NAMES: ReadonlyArray<string> = [
  'af_maple',
  'af_sol',
  'bf_vale',
  'zf_001',
  'zf_002',
  'zf_003',
  'zf_004',
  'zf_005',
  'zf_006',
  'zf_007',
  'zf_008',
  'zf_017',
  'zf_018',
  'zf_019',
  'zf_021',
  'zf_022',
  'zf_023',
  'zf_024',
  'zf_026',
  'zf_027',
  'zf_028',
  'zf_032',
  'zf_036',
  'zf_038',
  'zf_039',
  'zf_040',
  'zf_042',
  'zf_043',
  'zf_044',
  'zf_046',
  'zf_047',
  'zf_048',
  'zf_049',
  'zf_051',
  'zf_059',
  'zf_060',
  'zf_067',
  'zf_070',
  'zf_071',
  'zf_072',
  'zf_073',
  'zf_074',
  'zf_075',
  'zf_076',
  'zf_077',
  'zf_078',
  'zf_079',
  'zf_083',
  'zf_084',
  'zf_085',
  'zf_086',
  'zf_087',
  'zf_088',
  'zf_090',
  'zf_092',
  'zf_093',
  'zf_094',
  'zf_099',
  'zm_009',
  'zm_010',
  'zm_011',
  'zm_012',
  'zm_013',
  'zm_014',
  'zm_015',
  'zm_016',
  'zm_020',
  'zm_025',
  'zm_029',
  'zm_030',
  'zm_031',
  'zm_033',
  'zm_034',
  'zm_035',
  'zm_037',
  'zm_041',
  'zm_045',
  'zm_050',
  'zm_052',
  'zm_053',
  'zm_054',
  'zm_055',
  'zm_056',
  'zm_057',
  'zm_058',
  'zm_061',
  'zm_062',
  'zm_063',
  'zm_064',
  'zm_065',
  'zm_066',
  'zm_068',
  'zm_069',
  'zm_080',
  'zm_081',
  'zm_082',
  'zm_089',
  'zm_091',
  'zm_095',
  'zm_096',
  'zm_097',
  'zm_098',
  'zm_100',
];

export const KOKORO_VOICE_ALIASES: Readonly<Record<string, number>> = {
  af_heart: 0,
  af_bella: 1,
  bf_emma: 2,
  am_adam: 62,
  zf_xiaobei: 48,
  zf_xiaoni: 49,
  zf_xiaoxiao: 50,
  zf_xiaoyi: 51,
};

export const KOKORO_EXPOSED_VOICES: ReadonlyArray<string> = [
  ...KOKORO_SPEAKER_NAMES,
  ...Object.keys(KOKORO_VOICE_ALIASES),
];

const SPEAKER_NAME_TO_ID = new Map<string, number>(
  KOKORO_SPEAKER_NAMES.map((name, idx) => [name.toLowerCase(), idx]),
);

const DEFAULT_KOKORO_SID = 3; // zf_001
const WHISPER_GAIN = 0.5;
const KOKORO_MIN_SPEED = 0.5;
const KOKORO_MAX_SPEED = 2.0;

export function resolveKokoroSpeakerId(voice: string | undefined): number {
  if (typeof voice !== 'string') return DEFAULT_KOKORO_SID;
  const trimmed = voice.trim().toLowerCase();
  if (!trimmed) return DEFAULT_KOKORO_SID;

  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < KOKORO_SPEAKER_NAMES.length
      ? parsed
      : DEFAULT_KOKORO_SID;
  }

  const exact = SPEAKER_NAME_TO_ID.get(trimmed);
  if (exact !== undefined) return exact;

  if (Object.hasOwn(KOKORO_VOICE_ALIASES, trimmed)) {
    return KOKORO_VOICE_ALIASES[trimmed] ?? DEFAULT_KOKORO_SID;
  }

  return DEFAULT_KOKORO_SID;
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

export interface AsrRecognizerInstance {
  transcribe(
    samples: Float32Array,
    sampleRate: number,
    language?: string,
  ): Promise<{ text: string; language?: string }>;
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
      const sherpa = ('default' in mod ? (mod.default as typeof mod) : mod);
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
      const sherpa = ('default' in mod ? (mod.default as typeof mod) : mod);
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

      return {
        async transcribe(samples: Float32Array, sampleRate: number) {
          const tailPad = Math.round(sampleRate * 0.5);
          const padded = new Float32Array(samples.length + tailPad);
          padded.set(samples, 0);
          const stream = recognizer.createStream();
          stream.acceptWaveform({ samples: padded, sampleRate });
          stream.inputFinished();
          while (recognizer.isReady(stream)) {
            recognizer.decode(stream);
          }
          const res = recognizer.getResult(stream);
          return {
            text: (res.text ?? '').trim(),
            language: 'zh',
          };
        },
      };
    },

    async createSenseVoiceRecognizer(
      bundleDir: string,
      numThreads: number,
    ): Promise<AsrRecognizerInstance> {
      const mod = await import('sherpa-onnx-node');
      const sherpa = ('default' in mod ? (mod.default as typeof mod) : mod);
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

export interface SpeechEngineRegistryOptions extends ModelCacheOptions {
  backend?: NativeSpeechBackend;
  numThreads?: number;
  resolveBundleDir?: (bundleId: DaemonBundleId) => Promise<string | null>;
}

export class SpeechEngineRegistry {
  private readonly backend: NativeSpeechBackend;
  private readonly numThreads: number;
  private readonly resolveDirFn: (bundleId: DaemonBundleId) => Promise<string | null>;

  private kokoroInstance: KokoroTtsInstance | null = null;
  private kokoroPromise: Promise<KokoroTtsInstance> | null = null;

  private zipformerInstance: AsrRecognizerInstance | null = null;
  private zipformerPromise: Promise<AsrRecognizerInstance> | null = null;

  private senseVoiceInstance: AsrRecognizerInstance | null = null;
  private senseVoicePromise: Promise<AsrRecognizerInstance> | null = null;

  // Serialize native ONNX TTS calls across concurrent HTTP clients on the single shared instance
  private ttsQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SpeechEngineRegistryOptions = {}) {
    this.backend = options.backend ?? createSherpaNodeBackend();
    this.numThreads = options.numThreads ?? defaultThreadCount();
    this.resolveDirFn =
      options.resolveBundleDir ??
      ((bundleId) => resolveInstalledBundleDir(bundleId, options));
  }

  modelsLoaded(): DaemonBundleId[] {
    const out: DaemonBundleId[] = [];
    if (this.kokoroInstance) out.push('kokoro-int8');
    if (this.zipformerInstance) out.push('zipformer2');
    if (this.senseVoiceInstance) out.push('sensevoice-int8');
    return out;
  }

  instanceCount(): number {
    return (
      (this.kokoroInstance ? 1 : 0) +
      (this.zipformerInstance ? 1 : 0) +
      (this.senseVoiceInstance ? 1 : 0)
    );
  }

  private async ensureKokoro(): Promise<KokoroTtsInstance> {
    if (this.kokoroInstance) return this.kokoroInstance;
    if (!this.kokoroPromise) {
      this.kokoroPromise = (async () => {
        const dir = await this.resolveDirFn('kokoro-int8');
        if (!dir) throw new ModelNotInstalledError('kokoro-int8');
        const inst = await this.backend.createKokoroTts(dir, this.numThreads);
        this.kokoroInstance = inst;
        return inst;
      })().catch((err: unknown) => {
        this.kokoroPromise = null;
        throw err;
      });
    }
    return this.kokoroPromise;
  }

  private async ensureZipformer2(): Promise<AsrRecognizerInstance> {
    if (this.zipformerInstance) return this.zipformerInstance;
    if (!this.zipformerPromise) {
      this.zipformerPromise = (async () => {
        const dir = await this.resolveDirFn('zipformer2');
        if (!dir) throw new ModelNotInstalledError('zipformer2');
        const inst = await this.backend.createZipformer2Recognizer(dir, this.numThreads);
        this.zipformerInstance = inst;
        return inst;
      })().catch((err: unknown) => {
        this.zipformerPromise = null;
        throw err;
      });
    }
    return this.zipformerPromise;
  }

  private async ensureSenseVoice(): Promise<AsrRecognizerInstance> {
    if (this.senseVoiceInstance) return this.senseVoiceInstance;
    if (!this.senseVoicePromise) {
      this.senseVoicePromise = (async () => {
        const dir = await this.resolveDirFn('sensevoice-int8');
        if (!dir) throw new ModelNotInstalledError('sensevoice-int8');
        const inst = await this.backend.createSenseVoiceRecognizer(dir, this.numThreads);
        this.senseVoiceInstance = inst;
        return inst;
      })().catch((err: unknown) => {
        this.senseVoicePromise = null;
        throw err;
      });
    }
    return this.senseVoicePromise;
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
    const tts = await this.ensureKokoro();

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
      ? await this.ensureZipformer2()
      : await this.ensureSenseVoice();
    const res = await recognizer.transcribe(input.samples, input.sampleRate, input.language);
    const effectiveLang = normalizeSenseVoiceLang(res.language ?? input.language);

    return {
      text: res.text,
      ...(effectiveLang ? { language: effectiveLang } : {}),
      durationMs,
    };
  }
}
