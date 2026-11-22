declare module 'sherpa-onnx-node' {
  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface TtsGenerateRequest {
    text: string;
    sid: number;
    speed: number;
  }

  export interface OfflineTtsKokoroConfig {
    model: string;
    voices: string;
    tokens: string;
    dataDir: string;
    lexicon?: string;
    lang?: string;
    lengthScale?: number;
  }

  export interface OfflineTtsConfig {
    model: {
      kokoro?: OfflineTtsKokoroConfig;
      numThreads?: number;
      debug?: number;
      provider?: string;
    };
    ruleFsts?: string;
    maxNumSentences?: number;
  }

  export class OfflineTts {
    readonly sampleRate: number;
    readonly numSpeakers: number;
    constructor(config: OfflineTtsConfig);
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    generate(req: TtsGenerateRequest): GeneratedAudio;
    generateAsync(req: TtsGenerateRequest): Promise<GeneratedAudio>;
  }

  export interface WaveformInput {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface OfflineStream {
    acceptWaveform(waveform: WaveformInput): void;
  }

  export interface OfflineRecognizerResult {
    text: string;
    lang?: string;
  }

  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      senseVoice?: {
        model: string;
        language?: string;
        useInverseTextNormalization?: number;
      };
      tokens: string;
      numThreads?: number;
      provider?: string;
      debug?: number;
    };
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  export interface OnlineStream {
    acceptWaveform(waveform: WaveformInput): void;
    inputFinished(): void;
  }

  export interface OnlineRecognizerResult {
    text: string;
  }

  export interface OnlineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer?: {
        encoder: string;
        decoder: string;
        joiner: string;
      };
      tokens: string;
      numThreads?: number;
      provider?: string;
      debug?: number;
    };
    decodingMethod?: string;
    enableEndpoint?: number;
  }

  export class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    getResult(stream: OnlineStream): OnlineRecognizerResult;
  }
}
