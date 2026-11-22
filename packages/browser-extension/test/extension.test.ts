import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KOKORO_SPEAKERS_103, encodeMonoPcm16Wav } from '@voice-mode/core';
import {
  SpeechEngineRegistry,
  startVoiceDaemonServer,
  type NativeSpeechBackend,
} from '../../voice-daemon/dist/index.js';
import {
  SPEECH_SYNTHESIS_MIME,
  VoiceExtensionCoordinator,
  buildKokoroVoiceSelectOptions,
  extractReadableSelectionOrReply,
  injectDictatedTextIntoPage,
} from '../src/coordinator.ts';
import { dispatchServiceWorkerMessage } from '../src/sw-router.ts';

function createMockDaemonBackend(): NativeSpeechBackend {
  return {
    async createKokoroTts() {
      return {
        sampleRate: 24_000,
        numSpeakers: 103,
        async synthesize(_text: string, _sid: number, _speed: number) {
          const samples = new Float32Array(1_200);
          samples.fill(0.25);
          return { samples, sampleRate: 24_000 };
        },
      };
    },
    async createZipformer2Recognizer() {
      return {
        async transcribe() {
          return { text: '打开 deep seek 聊天窗口', language: 'zh' };
        },
      };
    },
    async createSenseVoiceRecognizer() {
      return {
        async transcribe() {
          return { text: '请打开 deep seek 页面', language: 'zh' };
        },
      };
    },
  };
}

describe('MV3 browser-extension coordinator, sender security, 103-voice catalog, and <1s fallback', () => {
  it('populates all 103 Kokoro voice options dynamically from daemon health.voices', () => {
    const options = buildKokoroVoiceSelectOptions(KOKORO_SPEAKERS_103);
    assert.equal(options.length, 103);
    const values = new Set(options.map((o) => o.value));
    assert.equal(values.size, 103);
    assert.equal(values.has('zf_001'), true);
    assert.equal(values.has('af_maple'), true);
    assert.equal(values.has('zm_013'), true);
    assert.equal(values.has('zm_100'), true);
  });

  it('rejects untrusted content-script or cross-extension senders in MV3 service worker router', async () => {
    const ownId = 'ejfaegbinglhgllfphndcfbplacledop';
    let tabQueried = false;

    const fakeDeps = {
      runtimeId: ownId,
      async queryActiveTabId() {
        tabQueried = true;
        return 42;
      },
      async ensureContentScript() {},
      async sendTabMessage() {
        return { ok: true, text: 'secret' };
      },
    };

    // 1. Sender from content script (sender.tab present) MUST be rejected!
    let contentReply: unknown = null;
    dispatchServiceWorkerMessage(
      { type: 'VM_INJECT_ACTIVE_TAB', text: 'pwned' },
      { id: ownId, tab: { id: 99, url: 'https://evil.example' } },
      (res) => {
        contentReply = res;
      },
      fakeDeps,
    );
    assert.deepEqual(contentReply, { ok: false, error: 'Forbidden message sender' });
    assert.equal(tabQueried, false);

    // 2. Sender from foreign extension ID MUST be rejected!
    let foreignReply: unknown = null;
    dispatchServiceWorkerMessage(
      { type: 'VM_READ_ACTIVE_TAB' },
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      (res) => {
        foreignReply = res;
      },
      fakeDeps,
    );
    assert.deepEqual(foreignReply, { ok: false, error: 'Forbidden message sender' });
    assert.equal(tabQueried, false);

    // 3. Sender from own Side Panel (sender.id === ownId && !sender.tab) succeeds
    const sidePanelReply = await new Promise<unknown>((resolve) => {
      dispatchServiceWorkerMessage(
        { type: 'VM_READ_ACTIVE_TAB' },
        { id: ownId },
        (res) => resolve(res),
        fakeDeps,
      );
    });
    assert.deepEqual(sidePanelReply, { ok: true, text: 'secret' });
    assert.equal(tabQueried, true);
  });

  it('reads Markdown skipping code blocks and pipe tables via SentenceSegmenter and plays via voice-daemon', async () => {
    const token = `sk-vmd-${'a'.repeat(48)}`;
    const server = await startVoiceDaemonServer({
      port: 0,
      token,
      registry: new SpeechEngineRegistry({
        backend: createMockDaemonBackend(),
        resolveBundleDir: async (id) => `/virtual/${id}`,
      }),
    });

    try {
      const playedSentences: string[] = [];
      const playedMimes: string[] = [];

      const coordinator = new VoiceExtensionCoordinator({
        daemonBaseUrl: `http://127.0.0.1:${server.port}`,
        daemonToken: token,
        voice: 'zf_001',
        asrModel: 'zipformer2',
        sink: {
          async play(payload) {
            playedMimes.push(payload.mime);
          },
        },
        onSentencePlayStart: (sentence) => playedSentences.push(sentence),
      });

      const markdown = [
        '第一句回复已经准备好。',
        '',
        '```python',
        'def secret_code():',
        '    return 42',
        '```',
        '',
        '| 列A | 列B |',
        '| --- | --- |',
        '| 100 | 200 |',
        '',
        '第二句总结完毕。',
      ].join('\n');

      await coordinator.readMarkdownAloud(markdown);
      await coordinator.waitUntilPlaybackIdle();

      assert.equal(playedSentences.length, 2);
      assert.ok(playedSentences[0]?.includes('第一句回复已经准备好'));
      assert.ok(playedSentences[1]?.includes('第二句总结完毕'));
      assert.ok(!playedSentences.join(' ').includes('secret_code'));
      assert.ok(!playedSentences.join(' ').includes('列A'));
      assert.deepEqual(playedMimes, ['audio/wav', 'audio/wav']);

      coordinator.updateReplacements([{ from: ['deep seek'], to: 'DeepSeek' }]);
      const pcm = new Float32Array(4_000);
      pcm.fill(0.1);
      const tx = await coordinator.transcribeAudio(pcm, 16_000);
      assert.equal(tx.usedFallback, false);
      assert.equal(tx.replacedText, '打开 DeepSeek 聊天窗口');

      await coordinator.dispose();
    } finally {
      await server.close();
    }
  });

  it('falls back in < 1,000 ms for TTS (speechSynthesis/BYOK) and ASR (BYOK/WebSpeech, never silent empty string)', async () => {
    const token = `sk-vmd-${'b'.repeat(48)}`;
    const server = await startVoiceDaemonServer({
      port: 0,
      token,
      registry: new SpeechEngineRegistry({
        backend: createMockDaemonBackend(),
        resolveBundleDir: async (id) => `/virtual/${id}`,
      }),
    });

    const baseUrl = `http://127.0.0.1:${server.port}`;
    await server.close(); // Daemon is offline!

    const spokenBySystem: string[] = [];
    const coordinator = new VoiceExtensionCoordinator({
      daemonBaseUrl: baseUrl,
      daemonToken: token,
      probeTimeoutMs: 500,
      speakWithBrowserSynthesis: async (plain) => {
        spokenBySystem.push(plain);
      },
      sink: {
        async play(payload) {
          if (payload.mime === SPEECH_SYNTHESIS_MIME) {
            await coordinator.playBrowserFallbackPayload(payload);
          }
        },
      },
    });

    const t0 = performance.now();
    await coordinator.readMarkdownAloud('<whisper>Fallback sentence works.</whisper>');
    await coordinator.waitUntilPlaybackIdle();
    const elapsedMs = performance.now() - t0;

    assert.ok(elapsedMs < 1_000, `Expected <1000ms fallback, took ${elapsedMs}ms`);
    assert.deepEqual(spokenBySystem, ['Fallback sentence works.']);
    assert.equal(coordinator.lastFallbackSurface, 'tts');

    // Offline PCM ASR without BYOK must fail explicitly rather than silently returning ''
    const pcm = new Float32Array(1_600);
    pcm.fill(0.05);
    await assert.rejects(
      () => coordinator.transcribeAudio(pcm, 16_000),
      /offline|BYOK|SpeechRecognition/i,
    );

    // Offline PCM ASR WITH BYOK OpenAiCompatAsrTransport falls back in < 1s and applies vocabulary replacer!
    const byokWav = encodeMonoPcm16Wav(new Float32Array(800), 24_000);
    const playedMimes: string[] = [];
    const byokCoordinator = new VoiceExtensionCoordinator({
      daemonBaseUrl: baseUrl,
      daemonToken: token,
      probeTimeoutMs: 500,
      replacements: [{ from: ['deep seek'], to: 'DeepSeek' }],
      byokTts: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-byok-placeholder',
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        responseFormat: 'wav',
        fetchImpl: async () =>
          new Response(new Uint8Array(byokWav).buffer, {
            status: 200,
            headers: { 'Content-Type': 'audio/wav' },
          }),
      },
      byokAsr: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-byok-placeholder',
        model: 'whisper-1',
        fetchImpl: async () =>
          new Response(JSON.stringify({ text: 'hello deep seek cloud', language: 'en' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      },
      sink: {
        async play(payload) {
          playedMimes.push(payload.mime);
        },
      },
    });

    const tByok = performance.now();
    await byokCoordinator.readMarkdownAloud('Cloud fallback test.');
    await byokCoordinator.waitUntilPlaybackIdle();
    const byokAsrTx = await byokCoordinator.transcribeAudio(pcm, 16_000);
    assert.ok(performance.now() - tByok < 1_000);
    assert.deepEqual(playedMimes, ['audio/wav']);
    assert.equal(byokAsrTx.usedFallback, true);
    assert.equal(byokAsrTx.replacedText, 'hello DeepSeek cloud');

    // WebSpeech Recognition fallback session delivers vocabulary-replaced transcript
    const webSpeechTranscripts: string[] = [];
    class FakeSpeechRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        this.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: 'ask deep seek now' } }],
        });
      }
      stop() {
        this.onend?.();
      }
    }

    const handle = coordinator.startWebSpeechFallbackDictation({
      SpeechRecognitionCtor: FakeSpeechRecognition as never,
      replacements: [{ from: ['deep seek'], to: 'DeepSeek' }],
      onFinalTranscript: (text) => webSpeechTranscripts.push(text),
    });
    assert.deepEqual(webSpeechTranscripts, ['ask DeepSeek now']);
    handle.stop();

    await coordinator.dispose();
    await byokCoordinator.dispose();
  });

  it('injects dictated text with vocabulary replacements into focused web inputs via FocusTextInjector', () => {
    let inputEvents = 0;
    const fakeInput = {
      tagName: 'TEXTAREA',
      disabled: false,
      readOnly: false,
      value: 'Hello ',
      selectionStart: 6,
      selectionEnd: 6,
      ownerDocument: null as unknown,
      setSelectionRange(s: number, e: number) {
        this.selectionStart = s;
        this.selectionEnd = e;
      },
      dispatchEvent() {
        inputEvents += 1;
        return true;
      },
    };
    const fakeDoc = {
      activeElement: fakeInput,
      defaultView: null,
    } as unknown as Document;
    fakeInput.ownerDocument = fakeDoc;

    const ok = injectDictatedTextIntoPage(fakeDoc, 'kimi chat', [
      { from: ['kimi'], to: 'Kimi' },
    ]);
    assert.equal(ok, true);
    assert.equal(fakeInput.value, 'Hello Kimi chat');
    assert.equal(inputEvents, 1);

    const extracted = extractReadableSelectionOrReply({
      getSelection: () => ({ toString: () => '  Selected Markdown paragraph  ' }),
      querySelectorAll: () => [],
    } as unknown as Document);
    assert.equal(extracted, 'Selected Markdown paragraph');
  });

  it('enforces strict MV3 manifest & clean bundle store gate (zero <all_urls>, zero dead coordinator.js, zero debug globals)', () => {
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const repoRoot = resolve(pkgRoot, '..', '..');
    const distDir = join(pkgRoot, 'dist');

    assert.equal(existsSync(join(distDir, 'coordinator.js')), false);

    const rawManifest = readFileSync(join(distDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(rawManifest) as {
      manifest_version: number;
      permissions: string[];
      host_permissions: string[];
      optional_host_permissions: string[];
    };

    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['activeTab', 'sidePanel', 'storage']);
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*', 'http://localhost/*']);
    assert.deepEqual(manifest.optional_host_permissions, [
      'https://chat.deepseek.com/*',
      'https://gemini.google.com/*',
      'https://kimi.moonshot.cn/*',
      'https://www.kimi.com/*',
    ]);
    assert.equal(rawManifest.includes('<all_urls>'), false);
    assert.equal(rawManifest.includes('*://*/*'), false);

    for (const bundle of ['sw.js', 'sidepanel.js', 'content.js']) {
      const code = readFileSync(join(distDir, bundle), 'utf8');
      assert.equal(/\beval\s*\(/.test(code), false);
      assert.equal(/\bnew\s+Function\s*\(/.test(code), false);
      assert.equal(/speech\.platform\.bing\.com/i.test(code), false);
      assert.equal(code.includes('__voiceModeSidePanel'), false);
    }

    const gateOutput = execFileSync(
      process.execPath,
      [join(repoRoot, 'scripts', 'check-release-gate.mjs')],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    );
    assert.match(gateOutput, /Release gate PASSED/);
  });

  it('binds globalThis.fetch safely when Window.prototype.fetch enforces WebIDL receiver branding', async () => {
    const token = `sk-vmd-${'f'.repeat(48)}`;
    const server = await startVoiceDaemonServer({
      port: 0,
      token,
      registry: new SpeechEngineRegistry({
        backend: createMockDaemonBackend(),
        resolveBundleDir: async (id) => `/virtual/${id}`,
      }),
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = function strictBrowserFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return originalFetch(input, init);
    } as typeof fetch;

    try {
      const coordinator = new VoiceExtensionCoordinator({
        daemonBaseUrl: `http://127.0.0.1:${server.port}`,
        daemonToken: token,
      });
      const health = await coordinator.probeHealth();
      assert.equal(health.ok, true);
      await coordinator.dispose();
    } finally {
      globalThis.fetch = originalFetch;
      await server.close();
    }
  });
});
