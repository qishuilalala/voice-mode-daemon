import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DAEMON_MODEL_BUNDLES,
  downloadModelBundle,
  inspectModelCache,
  resolveInstalledBundleDir,
  type DaemonModelBundleSpec,
} from '../dist/index.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('voice-daemon shared model cache & SHA256 downloader seam', () => {
  it('exposes GPL-3.0 runtime-only isolation notice on kokoro-int8 and Apache/FunAudioLLM on ASR bundles', () => {
    assert.ok(DAEMON_MODEL_BUNDLES['kokoro-int8'].runtimeNotice?.includes('GPL-3.0'));
    assert.ok(DAEMON_MODEL_BUNDLES['kokoro-int8'].runtimeNotice?.includes('espeak-ng-data'));
    assert.equal(DAEMON_MODEL_BUNDLES['zipformer2'].license, 'Apache-2.0');
    assert.equal(DAEMON_MODEL_BUNDLES['sensevoice-int8'].license, 'FunAudioLLM');
  });

  it('discovers bundles from primary cache first and falls back read-only to dsh-voice-mode cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vm-cache-test-'));
    try {
      const primaryDir = join(root, 'primary');
      const fallbackDir = join(root, 'fallback-dsh');

      const encoderBytes = new TextEncoder().encode('fake-encoder');
      const testSpec: Record<string, DaemonModelBundleSpec> = {
        'mini-asr': {
          id: 'mini-asr',
          label: 'Mini ASR',
          repo: 'csukuangfj/mini-asr',
          revision: 'main',
          license: 'Apache-2.0',
          files: [
            {
              file: 'encoder.onnx',
              sha256: sha256Hex(encoderBytes),
              bytes: encoderBytes.byteLength,
            },
          ],
        },
      };

      // Initially missing everywhere
      const missingStatus = await inspectModelCache({
        cacheDir: primaryDir,
        fallbackCacheDirs: [fallbackDir],
        bundles: testSpec,
      });
      assert.equal(missingStatus[0]?.installed, false);
      assert.equal(missingStatus[0]?.source, 'missing');

      // Populate read-only fallback cache
      const fallbackBundleDir = join(fallbackDir, 'csukuangfj', 'mini-asr');
      await mkdir(fallbackBundleDir, { recursive: true });
      await writeFile(join(fallbackBundleDir, 'encoder.onnx'), encoderBytes);

      const fallbackStatus = await inspectModelCache({
        cacheDir: primaryDir,
        fallbackCacheDirs: [fallbackDir],
        bundles: testSpec,
      });
      assert.equal(fallbackStatus[0]?.installed, true);
      assert.equal(fallbackStatus[0]?.source, 'fallback');
      assert.equal(fallbackStatus[0]?.dir, fallbackBundleDir);

      const resolvedFallback = await resolveInstalledBundleDir('mini-asr', {
        cacheDir: primaryDir,
        fallbackCacheDirs: [fallbackDir],
        bundles: testSpec,
      });
      assert.equal(resolvedFallback, fallbackBundleDir);

      // Populate primary cache -> primary takes precedence over fallback
      const primaryBundleDir = join(primaryDir, 'csukuangfj', 'mini-asr');
      await mkdir(primaryBundleDir, { recursive: true });
      await writeFile(join(primaryBundleDir, 'encoder.onnx'), encoderBytes);

      const primaryStatus = await inspectModelCache({
        cacheDir: primaryDir,
        fallbackCacheDirs: [fallbackDir],
        bundles: testSpec,
      });
      assert.equal(primaryStatus[0]?.installed, true);
      assert.equal(primaryStatus[0]?.source, 'primary');
      assert.equal(primaryStatus[0]?.dir, primaryBundleDir);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('downloads and verifies SHA256 into primary cache, and rejects tampered payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vm-dl-test-'));
    try {
      const primaryDir = join(root, 'primary');
      const goodPayload = new TextEncoder().encode('verified-onnx-weights-v1');
      const testBundle: DaemonModelBundleSpec = {
        id: 'mini-tts',
        label: 'Mini TTS',
        repo: 'csukuangfj/mini-tts',
        revision: 'main',
        license: 'Apache-2.0',
        files: [
          {
            file: 'model.int8.onnx',
            sha256: sha256Hex(goodPayload),
            bytes: goodPayload.byteLength,
          },
        ],
      };

      // Tampered response must throw before writing target file
      await assert.rejects(
        () =>
          downloadModelBundle('mini-tts', {
            cacheDir: primaryDir,
            fallbackCacheDirs: [],
            bundles: { 'mini-tts': testBundle },
            fetchImpl: async () =>
              new Response(new TextEncoder().encode('corrupted-bytes!!'), {
                status: 200,
              }),
          }),
        /SHA-256|byte length/i,
      );

      // Authentic response verifies and installs cleanly
      const installedDir = await downloadModelBundle('mini-tts', {
        cacheDir: primaryDir,
        fallbackCacheDirs: [],
        bundles: { 'mini-tts': testBundle },
        fetchImpl: async () =>
          new Response(goodPayload, {
            status: 200,
          }),
      });
      assert.equal(installedDir, join(primaryDir, 'csukuangfj', 'mini-tts'));

      const status = await inspectModelCache({
        cacheDir: primaryDir,
        fallbackCacheDirs: [],
        bundles: { 'mini-tts': testBundle },
      });
      assert.equal(status[0]?.installed, true);
      assert.equal(status[0]?.source, 'primary');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
