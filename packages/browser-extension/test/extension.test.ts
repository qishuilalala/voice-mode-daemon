import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeMonoPcm16Wav } from '@voice-mode/core';
import {
  SpeechEngineRegistry,
  startVoiceDaemonServer,
  type NativeSpeechBackend,
} from '../../voice-daemon/dist/index.js';

// Import through compiled/bundled extension coordinator public module
import {
  VoiceExtensionCoordinator,
  extractReadableSelectionOrReply,
  injectDictatedTextIntoPage,
} from '../src/coordinator.ts';

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

describe('MV3 browser-extension coordinator, Markdown reader, vocabulary replacer, and <1s fallback', () => {
  it('reads Markdown skipping code blocks and pipe tables via SentenceSegmenter and plays via voice-daemon', async () => {
    const token = 'a'.repeat(64);
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

      // Verify ASR transcription + createAsrReplacer vocabulary replacement
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

  it('automatically falls back to browser speechSynthesis / BYOK in < 1,000 ms when daemon goes offline', async () => {
    const token = 'b'.repeat(64);
    const server = await startVoiceDaemonServer({
      port: 0,
      token,
      registry: new SpeechEngineRegistry({
        backend: createMockDaemonBackend(),
        resolveBundleDir: async (id) => `/virtual/${id}`,
      }),
    });

    const baseUrl = `http://127.0.0.1:${server.port}`;
    await server.close(); // Daemon is now offline!

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
          if (payload.mime === 'application/x-speech-synthesis') {
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

    // Also verify BYOK OpenAI-compat fallback returns real WAV audio in <1s
    const byokWav = encodeMonoPcm16Wav(new Float32Array(800), 24_000);
    const playedMimes: string[] = [];
    const byokCoordinator = new VoiceExtensionCoordinator({
      daemonBaseUrl: baseUrl,
      daemonToken: token,
      probeTimeoutMs: 500,
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
      sink: {
        async play(payload) {
          playedMimes.push(payload.mime);
        },
      },
    });

    const tByok = performance.now();
    await byokCoordinator.readMarkdownAloud('Cloud fallback test.');
    await byokCoordinator.waitUntilPlaybackIdle();
    assert.ok(performance.now() - tByok < 1_000);
    assert.deepEqual(playedMimes, ['audio/wav']);

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

  it('enforces strict MV3 manifest & bundle store gate (zero <all_urls>, *://*/*, eval, or Edge WebSocket)', () => {
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const repoRoot = resolve(pkgRoot, '..', '..');
    const distDir = join(pkgRoot, 'dist');

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
    }

    const gateOutput = execFileSync(process.execPath, [join(repoRoot, 'scripts', 'check-release-gate.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.match(gateOutput, /Release gate PASSED/);
  });

  it('binds globalThis.fetch safely when Window.prototype.fetch enforces WebIDL receiver branding', async () => {
    const token = 'f'.repeat(64);
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
