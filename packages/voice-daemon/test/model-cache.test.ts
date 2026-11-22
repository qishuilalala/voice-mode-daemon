import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
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

function buildTestTar(
  entries: Array<{ name: string; content?: Uint8Array; typeflag?: string }>,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();

  for (const entry of entries) {
    const data = entry.content ?? new Uint8Array(0);
    const header = new Uint8Array(512);
    header.set(encoder.encode(entry.name).subarray(0, 100), 0);
    header.set(encoder.encode('0000644\0'), 100);
    header.set(encoder.encode('0000000\0'), 108);
    header.set(encoder.encode('0000000\0'), 116);
    const octalSize = data.byteLength.toString(8).padStart(11, '0') + '\0';
    header.set(encoder.encode(octalSize), 124);
    header.set(encoder.encode('00000000000\0'), 136);
    header.fill(0x20, 148, 156); // Checksum spaces placeholder
    header[156] = (entry.typeflag ?? '0').charCodeAt(0);
    header.set(encoder.encode('ustar\0'), 257);
    header.set(encoder.encode('00'), 263);

    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
    const chk = sum.toString(8).padStart(6, '0') + '\0 ';
    header.set(encoder.encode(chk), 148);

    blocks.push(header);
    if (data.byteLength > 0) {
      const paddedLen = Math.ceil(data.byteLength / 512) * 512;
      const padded = new Uint8Array(paddedLen);
      padded.set(data, 0);
      blocks.push(padded);
    }
  }

  blocks.push(new Uint8Array(1024)); // Two zero EOF blocks
  const total = blocks.reduce((acc, b) => acc + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.byteLength;
  }
  return out;
}

describe('voice-daemon shared model cache & SHA256 downloader seam', () => {
  it('pins immutable 40-hex commit SHAs on all bundles and isolates GPL-3.0 espeak-ng-data runtime notice', () => {
    for (const bundle of Object.values(DAEMON_MODEL_BUNDLES)) {
      assert.match(
        bundle.revision,
        /^[0-9a-f]{40}$/,
        `Bundle ${bundle.id} must pin an immutable 40-hex commit SHA, got "${bundle.revision}"`,
      );
    }
    assert.ok(DAEMON_MODEL_BUNDLES['kokoro-int8'].runtimeNotice?.includes('GPL-3.0'));
    assert.ok(DAEMON_MODEL_BUNDLES['kokoro-int8'].runtimeNotice?.includes('espeak-ng-data'));
    assert.ok(DAEMON_MODEL_BUNDLES['kokoro-int8'].runtimeArchive !== undefined);
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
          revision: 'ad658fa0201659a09ea3c176129a191c77ecae8f',
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

      const missingStatus = await inspectModelCache({
        cacheDir: primaryDir,
        fallbackCacheDirs: [fallbackDir],
        bundles: testSpec,
      });
      assert.equal(missingStatus[0]?.installed, false);
      assert.equal(missingStatus[0]?.source, 'missing');

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

      const resolvedFallback = await resolveInstalledBundleDir('mini-asr', {
        cacheDir: primaryDir,
        fallbackCacheDirs: [fallbackDir],
        bundles: testSpec,
      });
      assert.equal(resolvedFallback, fallbackBundleDir);

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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforces hop-by-hop manual redirects, stream byte caps, and rejects tampered payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vm-dl-test-'));
    try {
      const primaryDir = join(root, 'primary');
      const goodPayload = new TextEncoder().encode('verified-onnx-weights-v1');
      const testBundle: DaemonModelBundleSpec = {
        id: 'mini-tts',
        label: 'Mini TTS',
        repo: 'csukuangfj/mini-tts',
        revision: '1355334be009ccce397060ee639a874137a128fa',
        license: 'Apache-2.0',
        files: [
          {
            file: 'model.int8.onnx',
            sha256: sha256Hex(goodPayload),
            bytes: goodPayload.byteLength,
          },
        ],
      };

      // 1. Disallowed redirect hop must be blocked before fetching evil target
      let evilFetched = false;
      await assert.rejects(
        () =>
          downloadModelBundle('mini-tts', {
            cacheDir: primaryDir,
            fallbackCacheDirs: [],
            bundles: { 'mini-tts': testBundle },
            fetchImpl: async (input, init) => {
              assert.equal(init?.redirect, 'manual');
              const url = String(input);
              if (url.includes('evil.attacker.example')) {
                evilFetched = true;
              }
              return new Response(null, {
                status: 302,
                headers: { Location: 'https://evil.attacker.example/model.int8.onnx' },
              });
            },
          }),
        /redirect/i,
      );
      assert.equal(evilFetched, false);

      // 2. Oversized stream exceeding declared byte cap must abort mid-stream
      const oversized = new Uint8Array(goodPayload.byteLength + 1024);
      oversized.fill(0x41);
      await assert.rejects(
        () =>
          downloadModelBundle('mini-tts', {
            cacheDir: primaryDir,
            fallbackCacheDirs: [],
            bundles: { 'mini-tts': testBundle },
            fetchImpl: async () => new Response(oversized.buffer, { status: 200 }),
          }),
        /exceeds|byte/i,
      );

      // 3. Allowed HuggingFace CDN redirect hop (302 -> cdn-lfs.huggingface.co) succeeds
      const installedDir = await downloadModelBundle('mini-tts', {
        cacheDir: primaryDir,
        fallbackCacheDirs: [],
        bundles: { 'mini-tts': testBundle },
        fetchImpl: async (input, init) => {
          assert.equal(init?.redirect, 'manual');
          const url = String(input);
          if (!url.includes('cdn-lfs.huggingface.co')) {
            return new Response(null, {
              status: 302,
              headers: { Location: 'https://cdn-lfs.huggingface.co/repos/mini-tts/model.int8.onnx' },
            });
          }
          return new Response(new Uint8Array(goodPayload).buffer, { status: 200 });
        },
      });
      assert.equal(installedDir, join(primaryDir, 'csukuangfj', 'mini-tts'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('downloads and safely extracts kokoro-int8 espeak-ng-data on a clean cache while rejecting unsafe tar entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vm-kokoro-clean-'));
    try {
      const primaryDir = join(root, 'clean-cache');
      const modelWeights = new TextEncoder().encode('kokoro-onnx-stub');
      const phontabBytes = new TextEncoder().encode('phontab-phoneme-table');
      const enDictBytes = new TextEncoder().encode('en-dict-entries');

      const validTar = buildTestTar([
        { name: 'espeak-ng-data/phontab', content: phontabBytes },
        { name: 'espeak-ng-data/en_dict', content: enDictBytes },
      ]);
      const validTarGz = new Uint8Array(gzipSync(validTar));

      const kokoroTestBundle: DaemonModelBundleSpec = {
        id: 'kokoro-int8',
        label: 'Kokoro Test Bundle',
        repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1',
        revision: '1355334be009ccce397060ee639a874137a128fa',
        license: 'Apache-2.0',
        requiredSubpath: 'espeak-ng-data/phontab',
        runtimeArchive: {
          urls: ['https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.gz'],
          sha256: sha256Hex(validTarGz),
          bytes: validTarGz.byteLength,
          compression: 'tar.gz',
          subdirPrefix: 'espeak-ng-data/',
          sentinelFile: 'espeak-ng-data/phontab',
          sentinelSha256: sha256Hex(phontabBytes),
        },
        files: [
          {
            file: 'model.int8.onnx',
            sha256: sha256Hex(modelWeights),
            bytes: modelWeights.byteLength,
          },
        ],
      };

      // Reject archive containing path traversal or symlink
      const traversalTarGz = new Uint8Array(
        gzipSync(buildTestTar([{ name: 'espeak-ng-data/../../escape.txt', content: phontabBytes }])),
      );
      const badBundle: DaemonModelBundleSpec = {
        ...kokoroTestBundle,
        runtimeArchive: {
          ...kokoroTestBundle.runtimeArchive!,
          sha256: sha256Hex(traversalTarGz),
          bytes: traversalTarGz.byteLength,
        },
      };
      await assert.rejects(
        () =>
          downloadModelBundle('kokoro-int8', {
            cacheDir: primaryDir,
            fallbackCacheDirs: [],
            bundles: { 'kokoro-int8': badBundle },
            fetchImpl: async (input) => {
              const url = String(input);
              if (url.includes('espeak-ng-data')) {
                return new Response(traversalTarGz.buffer, { status: 200 });
              }
              return new Response(new Uint8Array(modelWeights).buffer, { status: 200 });
            },
          }),
        /unsafe|traversal|outside/i,
      );

      // Valid clean-machine download transitions kokoro-int8 to READY (installed: true)
      await downloadModelBundle('kokoro-int8', {
        cacheDir: primaryDir,
        fallbackCacheDirs: [],
        bundles: { 'kokoro-int8': kokoroTestBundle },
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes('espeak-ng-data')) {
            return new Response(validTarGz.buffer, { status: 200 });
          }
          return new Response(new Uint8Array(modelWeights).buffer, { status: 200 });
        },
      });

      const statuses = await inspectModelCache({
        cacheDir: primaryDir,
        fallbackCacheDirs: [],
        bundles: { 'kokoro-int8': kokoroTestBundle },
      });
      assert.equal(statuses[0]?.installed, true);
      assert.equal(statuses[0]?.source, 'primary');
      const phontabStat = await stat(
        join(primaryDir, 'csukuangfj', 'kokoro-int8-multi-lang-v1_1', 'espeak-ng-data', 'phontab'),
      );
      assert.equal(phontabStat.size, phontabBytes.byteLength);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
