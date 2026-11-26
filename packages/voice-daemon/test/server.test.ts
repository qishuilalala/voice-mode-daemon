import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DaemonClient, KOKORO_SPEAKERS_103, encodeMonoPcm16Wav } from '@voice-mode/core';
import {
  KOKORO_EXPOSED_VOICES,
  KOKORO_SPEAKER_NAMES,
  SpeechEngineRegistry,
  decodePcm16Wav,
  resolveKokoroSpeakerId,
  startVoiceDaemonServer,
  type NativeSpeechBackend,
} from '../dist/index.js';

function createDeterministicBackend() {
  const loadCounts = { kokoro: 0, zipformer2: 0, sensevoice: 0 };
  const synthCalls: Array<{ text: string; sid: number; speed: number }> = [];

  const backend: NativeSpeechBackend = {
    async createKokoroTts() {
      loadCounts.kokoro += 1;
      await new Promise((r) => setTimeout(r, 15));
      return {
        sampleRate: 24_000,
        numSpeakers: 103,
        async synthesize(text: string, sid: number, speed: number) {
          synthCalls.push({ text, sid, speed });
          const samples = new Float32Array(2_400);
          samples.fill(0.8);
          return { samples, sampleRate: 24_000 };
        },
      };
    },
    async createZipformer2Recognizer() {
      loadCounts.zipformer2 += 1;
      return {
        async transcribe(samples: Float32Array, sampleRate: number) {
          return {
            text: `zipformer:${samples.length}@${sampleRate}`,
            language: 'zh',
          };
        },
      };
    },
    async createSenseVoiceRecognizer() {
      loadCounts.sensevoice += 1;
      return {
        async transcribe(samples: Float32Array, sampleRate: number, language?: string) {
          return {
            text: `sensevoice:${samples.length}@${sampleRate}`,
            language: language ?? '<|zh|>',
          };
        },
      };
    },
  };

  return { backend, loadCounts, synthCalls };
}

describe('voice-daemon HTTP server, Kokoro 103 emotion synthesis, dual ASR, and <1s fallback', () => {
  it('aligns all 103 Kokoro speakers (0..102) with @voice-mode/core and voices.bin', () => {
    assert.equal(KOKORO_SPEAKER_NAMES.length, 103);
    assert.equal(KOKORO_EXPOSED_VOICES.length, 103);
    assert.deepEqual(KOKORO_SPEAKER_NAMES, KOKORO_SPEAKERS_103);

    assert.equal(resolveKokoroSpeakerId('af_maple'), 0);
    assert.equal(resolveKokoroSpeakerId('af_sol'), 1);
    assert.equal(resolveKokoroSpeakerId('bf_vale'), 2);
    assert.equal(resolveKokoroSpeakerId('zf_001'), 3);
    assert.equal(resolveKokoroSpeakerId('zf_xiaobei'), 48);
    assert.equal(resolveKokoroSpeakerId('zf_084'), 48);
    assert.equal(resolveKokoroSpeakerId('zm_010'), 59);
    assert.equal(resolveKokoroSpeakerId('zm_013'), 62);
    assert.equal(resolveKokoroSpeakerId('zm_100'), 102);
    assert.equal(resolveKokoroSpeakerId('0'), 0);
    assert.equal(resolveKokoroSpeakerId('102'), 102);
    assert.equal(resolveKokoroSpeakerId('999'), 3);
    assert.equal(resolveKokoroSpeakerId('unknown_voice'), 3);
  });

  it('serves concurrent Obsidian and Chrome Extension requests from 1 shared model instance and preserves emotion tags via DaemonClient', async () => {
    const { backend, loadCounts, synthCalls } = createDeterministicBackend();
    const registry = new SpeechEngineRegistry({
      backend,
      resolveBundleDir: async (id) => `/virtual/models/${id}`,
    });
    const token = `sk-vmd-${'c'.repeat(48)}`;
    const server = await startVoiceDaemonServer({
      port: 0,
      token,
      registry,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;

      // 1. Rejects untrusted web Origin with 403 even when valid Bearer token is attached
      const evilRes = await fetch(`${baseUrl}/v1/health`, {
        headers: {
          Origin: 'https://evil.example',
          Authorization: `Bearer ${token}`,
        },
      });
      assert.equal(evilRes.status, 403);

      // 2. Rejects mismatched Bearer token with 401
      const badAuthRes = await fetch(`${baseUrl}/v1/health`, {
        headers: {
          Origin: 'app://obsidian.md',
          Authorization: `Bearer sk-vmd-${'d'.repeat(48)}`,
        },
      });
      assert.equal(badAuthRes.status, 401);

      // 3. Simultaneous cold-start Kokoro synthesis from Obsidian + Chrome Extension shares 1 model instance
      const extOrigin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
      const [obsRes, extRes] = await Promise.all([
        fetch(`${baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: {
            Origin: 'app://obsidian.md',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: '你好世界', voice: 'zf_001', speed: 1.2 }),
        }),
        fetch(`${baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: {
            Origin: extOrigin,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: 'Hello world', voice: 'af_maple', speed: 2.5 }),
        }),
      ]);

      assert.equal(obsRes.status, 200);
      assert.equal(extRes.status, 200);
      assert.equal(obsRes.headers.get('access-control-allow-origin'), 'app://obsidian.md');
      assert.equal(extRes.headers.get('access-control-allow-origin'), extOrigin);
      assert.equal(loadCounts.kokoro, 1);
      assert.equal(registry.instanceCount(), 1);
      assert.deepEqual(registry.modelsLoaded(), ['kokoro-int8']);

      const sids = synthCalls.map((c) => c.sid).sort((a, b) => a - b);
      assert.deepEqual(sids, [0, 3]);
      assert.ok(synthCalls.some((c) => c.speed === 2.0));

      // 4. Verify <whisper> x0.5 PCM gain & <break 250ms> 6000-sample silence @ 24 kHz end-to-end via DaemonClient!
      const emotionClient = new DaemonClient({
        baseUrl,
        token,
        voice: 'zf_001',
      });
      const emotionOut = await emotionClient.tts.synthesize(
        '<whisper>hushed</whisper> <break 250ms> normal',
      );
      const decoded = decodePcm16Wav(emotionOut.audio);
      assert.equal(decoded.sampleRate, 24_000);
      assert.equal(decoded.samples.length, 10_800);
      assert.ok(Math.abs((decoded.samples[100] ?? 0) - 0.4) < 0.002);
      assert.equal(decoded.samples[3_000], 0);
      assert.ok(Math.abs((decoded.samples[9_000] ?? 0) - 0.8) < 0.002);
      await emotionClient.close();

      // 5. Verify dual-channel ASR via real @voice-mode/core DaemonClient (zipformer2 + sensevoice)
      const pcm16k = new Float32Array(8_000);
      pcm16k.fill(0.1);

      const zipClient = new DaemonClient({
        baseUrl,
        token,
        asrModel: 'zipformer2',
      });
      const zipEvent = await zipClient.asr.transcribe!(pcm16k, { sampleRate: 16_000 });
      assert.equal(zipEvent.text, 'zipformer:8000@16000');
      assert.equal(zipEvent.language, 'zh');
      assert.equal((await zipClient.probeHealth()).voices.length, 103);

      const senseClient = new DaemonClient({
        baseUrl,
        token,
        asrModel: 'sensevoice',
      });
      const senseEvent = await senseClient.asr.transcribe!(pcm16k, { sampleRate: 16_000 });
      assert.equal(senseEvent.text, 'sensevoice:8000@16000');
      assert.equal(senseEvent.language, 'zh');

      await zipClient.close();
      await senseClient.close();

      assert.equal(loadCounts.zipformer2, 1);
      assert.equal(loadCounts.sensevoice, 1);
      assert.equal(registry.instanceCount(), 3);
    } finally {
      await server.close();
    }
  });

  it('falls back in < 1,000 ms when voice-daemon is offline or Bearer token mismatches', async () => {
    const { backend } = createDeterministicBackend();
    const registry = new SpeechEngineRegistry({
      backend,
      resolveBundleDir: async (id) => `/virtual/models/${id}`,
    });
    const token = `sk-vmd-${'e'.repeat(48)}`;
    const server = await startVoiceDaemonServer({
      port: 0,
      token,
      registry,
    });

    const baseUrl = `http://127.0.0.1:${server.port}`;
    const fallbackAudio = encodeMonoPcm16Wav(new Float32Array(400), 16_000);
    let fallbackReasons: string[] = [];

    const badTokenClient = new DaemonClient({
      baseUrl,
      token: `sk-vmd-${'0'.repeat(48)}`,
      probeTimeoutMs: 500,
      onFallback: (_surface, reason) => fallbackReasons.push(reason),
      fallbackTts: {
        kind: 'system',
        mime: 'audio/wav',
        updateVoice: () => undefined,
        prepare: async () => undefined,
        status: () => ({ engine: 'system', ready: true, loading: false }),
        interrupt: () => undefined,
        synthesize: async () => ({ audio: fallbackAudio, mime: 'audio/wav' }),
        close: async () => undefined,
      },
    });

    const tMismatchStart = performance.now();
    const mismatchSynth = await badTokenClient.tts.synthesize('Fallback on 401');
    const mismatchMs = performance.now() - tMismatchStart;
    assert.ok(mismatchMs < 1_000, `Expected <1000ms fallback on 401, took ${mismatchMs}ms`);
    assert.equal(mismatchSynth.audio.byteLength, fallbackAudio.byteLength);
    assert.equal(fallbackReasons.length, 1);

    await server.close();
    fallbackReasons = [];

    const offlineClient = new DaemonClient({
      baseUrl,
      token,
      probeTimeoutMs: 500,
      onFallback: (_surface, reason) => fallbackReasons.push(reason),
      fallbackTts: {
        kind: 'system',
        mime: 'audio/wav',
        updateVoice: () => undefined,
        prepare: async () => undefined,
        status: () => ({ engine: 'system', ready: true, loading: false }),
        interrupt: () => undefined,
        synthesize: async () => ({ audio: fallbackAudio, mime: 'audio/wav' }),
        close: async () => undefined,
      },
    });

    const tOfflineStart = performance.now();
    const offlineSynth = await offlineClient.tts.synthesize('Fallback when daemon stopped');
    const offlineMs = performance.now() - tOfflineStart;
    assert.ok(offlineMs < 1_000, `Expected <1000ms fallback when offline, took ${offlineMs}ms`);
    assert.equal(offlineSynth.audio.byteLength, fallbackAudio.byteLength);
    assert.equal(fallbackReasons.length, 1);
  });
});

describe('voice-daemon OpenAI-compatible hardening (D-0013 D+)', () => {
  it('exposes /v1/models, /v1/capabilities, structured error bodies and pcm output', async () => {
    const { backend } = createDeterministicBackend();
    const registry = new SpeechEngineRegistry({
      backend,
      resolveBundleDir: async (id) => `/virtual/models/${id}`,
    });
    const token = `sk-vmd-${'e'.repeat(48)}`;
    const server = await startVoiceDaemonServer({ port: 0, token, registry });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const authHeaders = {
      Origin: 'app://obsidian.md',
      Authorization: `Bearer ${token}`,
    };

    try {
      const models = await fetch(`${baseUrl}/v1/models`, { headers: authHeaders });
      assert.equal(models.status, 200);
      const modelsBody = (await models.json()) as {
        data: Array<{ id: string; voices?: string[] }>;
      };
      assert.deepEqual(
        modelsBody.data.map((m) => m.id).sort(),
        ['kokoro-int8', 'sensevoice', 'zipformer2'],
      );
      assert.equal(modelsBody.data.find((m) => m.id === 'kokoro-int8')?.voices?.length, 103);

      const caps = await fetch(`${baseUrl}/v1/capabilities`, { headers: authHeaders });
      assert.equal(caps.status, 200);
      const capsBody = (await caps.json()) as {
        tts: {
          engines: Array<{
            expression: { emotion: string; supported: string[] };
            responseFormats: string[];
          }>;
        };
        limits: { maxTtsInputChars: number };
      };
      assert.equal(capsBody.tts.engines[0]?.expression.emotion, 'none');
      assert.ok(capsBody.tts.engines[0]?.expression.supported.includes('whisper'));
      assert.deepEqual(capsBody.tts.engines[0]?.responseFormats, ['wav', 'pcm']);
      assert.equal(capsBody.limits.maxTtsInputChars, 8_000);

      const badFormat = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hi', response_format: 'mp3' }),
      });
      assert.equal(badFormat.status, 400);
      assert.deepEqual(await badFormat.json(), {
        error: {
          message: 'Unsupported response_format "mp3"; use "wav" or "pcm"',
          type: 'invalid_request_error',
          code: 'unsupported_response_format',
        },
      });

      const pcm = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: 'hi', response_format: 'pcm' }),
      });
      assert.equal(pcm.status, 200);
      assert.equal(pcm.headers.get('content-type'), 'audio/pcm');
      const pcmBytes = new Uint8Array(await pcm.arrayBuffer());
      // Deterministic backend yields 2400 samples at 24 kHz mono -> 4800 PCM bytes, no WAV header.
      assert.equal(pcmBytes.byteLength, 4_800);

      const notFound = await fetch(`${baseUrl}/v1/nope`, { headers: authHeaders });
      assert.equal(notFound.status, 404);
      const notFoundBody = (await notFound.json()) as {
        error: { type: string; code: string };
      };
      assert.equal(notFoundBody.error.code, 'unknown_route');
      assert.equal(notFoundBody.error.type, 'invalid_request_error');
    } finally {
      await server.close();
    }
  });
});
