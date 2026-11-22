import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  MODEL_BUNDLES,
  isSafeModelRel,
  redirectHostAllowed,
  resolveModelFileUrls,
  type ModelFileSpec,
} from '@voice-mode/core';

export type DaemonBundleId = 'kokoro-int8' | 'zipformer2' | 'sensevoice-int8';

export interface RuntimeArchiveSpec {
  urls: readonly string[];
  sha256: string;
  bytes: number;
  compression: 'tar' | 'tar.gz' | 'tar.bz2';
  subdirPrefix: string;
  sentinelFile: string;
  sentinelSha256: string;
}

export interface DaemonModelBundleSpec {
  id: string;
  label: string;
  repo: string;
  revision: string;
  license: string;
  runtimeNotice?: string;
  requiredSubpath?: string;
  runtimeArchive?: RuntimeArchiveSpec;
  files: ReadonlyArray<ModelFileSpec>;
}

const KOKORO_INT8_REVISION = '1355334be009ccce397060ee639a874137a128fa';
const ZIPFORMER2_REVISION = 'ad658fa0201659a09ea3c176129a191c77ecae8f';
const MAX_REDIRECT_HOPS = 5;
const DEFAULT_MAX_FILE_BYTES = 268_435_456; // 256 MiB safety cap when spec.bytes is omitted

export const DAEMON_MODEL_BUNDLES: Record<DaemonBundleId, DaemonModelBundleSpec> = {
  'kokoro-int8': {
    id: 'kokoro-int8',
    label: 'Kokoro v1.1 Multilingual int8 (103 speakers, zh + en)',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1',
    revision: KOKORO_INT8_REVISION,
    license: 'Apache-2.0',
    runtimeNotice:
      'Kokoro ONNX weights are Apache-2.0; runtime phoneme lexicon directory espeak-ng-data is GPL-3.0-or-later, fetched exclusively into the user local cache at runtime and never bundled in Git or published packages.',
    requiredSubpath: 'espeak-ng-data/phontab',
    runtimeArchive: {
      urls: [
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.bz2',
      ],
      sha256: '4135ccf82e1f40613491c0874d4945ae9e9c7840933d8e25a6f9e003d9ebf533',
      bytes: 7_252_012,
      compression: 'tar.bz2',
      subdirPrefix: 'espeak-ng-data/',
      sentinelFile: 'espeak-ng-data/phontab',
      sentinelSha256: '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6',
    },
    files: [
      {
        file: 'model.int8.onnx',
        revision: KOKORO_INT8_REVISION,
        sha256: 'bda15858163726a492d02a9a727bc263551b86ac77f90812c4b30ff41d380e26',
        bytes: 114_299_010,
      },
      {
        file: 'voices.bin',
        revision: KOKORO_INT8_REVISION,
        sha256: 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c',
        bytes: 53_790_720,
      },
      {
        file: 'tokens.txt',
        revision: KOKORO_INT8_REVISION,
        sha256: '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14',
        bytes: 1_111,
      },
      {
        file: 'lexicon-us-en.txt',
        revision: KOKORO_INT8_REVISION,
        sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14',
        bytes: 5_956_885,
      },
      {
        file: 'lexicon-zh.txt',
        revision: KOKORO_INT8_REVISION,
        sha256: '11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c',
        bytes: 2_119_465,
      },
      {
        file: 'date-zh.fst',
        revision: KOKORO_INT8_REVISION,
        sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718',
        bytes: 59_154,
      },
      {
        file: 'number-zh.fst',
        revision: KOKORO_INT8_REVISION,
        sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd',
        bytes: 64_482,
      },
      {
        file: 'phone-zh.fst',
        revision: KOKORO_INT8_REVISION,
        sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7',
        bytes: 88_630,
      },
    ],
  },
  zipformer2: {
    id: 'zipformer2',
    label: 'Streaming Zipformer2 Bilingual int8 (zh + en)',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
    revision: ZIPFORMER2_REVISION,
    license: 'Apache-2.0',
    files: [
      {
        file: 'encoder.int8.onnx',
        revision: ZIPFORMER2_REVISION,
        sha256: '5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f',
        bytes: 161_141_793,
      },
      {
        file: 'decoder.onnx',
        revision: ZIPFORMER2_REVISION,
        sha256: '06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e',
        bytes: 5_165_083,
      },
      {
        file: 'joiner.int8.onnx',
        revision: ZIPFORMER2_REVISION,
        sha256: 'b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b',
        bytes: 1_033_416,
      },
      {
        file: 'tokens.txt',
        revision: ZIPFORMER2_REVISION,
        sha256: '6193c7ea1c96d0d9a1e9652789b40d13a8a913b434a5451e93158f5a09fd6652',
        bytes: 20_628,
      },
    ],
  },
  'sensevoice-int8': {
    id: 'sensevoice-int8',
    label: MODEL_BUNDLES['sensevoice-int8'].label,
    repo: MODEL_BUNDLES['sensevoice-int8'].repo,
    revision: MODEL_BUNDLES['sensevoice-int8'].revision,
    license: MODEL_BUNDLES['sensevoice-int8'].license,
    files: MODEL_BUNDLES['sensevoice-int8'].files,
  },
};

export function defaultModelCacheDir(homeDir: string = homedir()): string {
  return join(homeDir, '.cache', 'voice-mode', 'models');
}

export function defaultFallbackModelCacheDirs(homeDir: string = homedir()): string[] {
  return [join(homeDir, '.cache', 'dsh-voice-mode', 'models')];
}

export interface ModelCacheOptions {
  cacheDir?: string;
  fallbackCacheDirs?: readonly string[];
  bundles?: Readonly<Record<string, DaemonModelBundleSpec>>;
}

export interface BundleCacheStatus {
  id: string;
  label: string;
  license: string;
  runtimeNotice?: string;
  installed: boolean;
  source: 'primary' | 'fallback' | 'missing';
  dir: string | null;
}

interface VerifiedLedger {
  version: 1;
  entries: Record<string, string>;
}

async function loadLedger(ledgerPath: string): Promise<VerifiedLedger> {
  try {
    const raw = await readFile(ledgerPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VerifiedLedger>;
    if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
      return { version: 1, entries: { ...parsed.entries } };
    }
  } catch {
    // Missing or unreadable ledger starts fresh.
  }
  return { version: 1, entries: {} };
}

async function saveLedger(ledgerPath: string, ledger: VerifiedLedger): Promise<void> {
  try {
    await mkdir(dirname(ledgerPath), { recursive: true });
    const tmp = `${ledgerPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(ledger), 'utf8');
    await rename(tmp, ledgerPath);
  } catch {
    // Best-effort memoization cache only.
  }
}

async function computeFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function verifyFileOnDisk(
  filePath: string,
  spec: ModelFileSpec,
  ledger: VerifiedLedger,
  dirtyRef: { dirty: boolean },
): Promise<boolean> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  if (spec.bytes !== undefined && info.size !== spec.bytes) {
    return false;
  }

  const fingerprintPrefix = `${info.size}:${info.ino}:${info.mtimeMs}:`;
  const cached = ledger.entries[filePath];
  if (cached && cached.startsWith(fingerprintPrefix)) {
    const cachedSha = cached.slice(fingerprintPrefix.length);
    return cachedSha.toLowerCase() === spec.sha256.toLowerCase();
  }

  const actualSha = await computeFileSha256(filePath);
  if (actualSha.toLowerCase() !== spec.sha256.toLowerCase()) {
    return false;
  }
  ledger.entries[filePath] = `${fingerprintPrefix}${actualSha}`;
  dirtyRef.dirty = true;
  return true;
}

function bundleDirUnder(cacheRoot: string, repo: string): string {
  if (!isSafeModelRel(repo)) {
    throw new Error(`Unsafe model repository path: "${repo}"`);
  }
  return join(cacheRoot, ...repo.split('/'));
}

async function isBundleCompleteInDir(
  candidateDir: string,
  bundle: DaemonModelBundleSpec,
  ledger: VerifiedLedger,
  dirtyRef: { dirty: boolean },
): Promise<boolean> {
  if (bundle.requiredSubpath) {
    try {
      const subStat = await stat(join(candidateDir, ...bundle.requiredSubpath.split('/')));
      if (!subStat.isFile()) return false;
    } catch {
      return false;
    }
  }
  if (bundle.runtimeArchive) {
    const sentinelPath = join(candidateDir, ...bundle.runtimeArchive.sentinelFile.split('/'));
    const okSentinel = await verifyFileOnDisk(
      sentinelPath,
      { file: bundle.runtimeArchive.sentinelFile, sha256: bundle.runtimeArchive.sentinelSha256 },
      ledger,
      dirtyRef,
    );
    if (!okSentinel) return false;
  }
  for (const fileSpec of bundle.files) {
    if (!isSafeModelRel(fileSpec.file)) return false;
    const fullPath = join(candidateDir, ...fileSpec.file.split('/'));
    const ok = await verifyFileOnDisk(fullPath, fileSpec, ledger, dirtyRef);
    if (!ok) return false;
  }
  return true;
}

export async function inspectModelCache(options: ModelCacheOptions = {}): Promise<BundleCacheStatus[]> {
  const primaryRoot = options.cacheDir ?? defaultModelCacheDir();
  const fallbackRoots = options.fallbackCacheDirs ?? defaultFallbackModelCacheDirs();
  const bundles = options.bundles ?? DAEMON_MODEL_BUNDLES;

  const ledgerPath = join(primaryRoot, 'verified-sha256-v1.json');
  const ledger = await loadLedger(ledgerPath);
  const dirtyRef = { dirty: false };
  const results: BundleCacheStatus[] = [];

  for (const bundle of Object.values(bundles)) {
    const primaryCandidate = bundleDirUnder(primaryRoot, bundle.repo);
    if (await isBundleCompleteInDir(primaryCandidate, bundle, ledger, dirtyRef)) {
      results.push({
        id: bundle.id,
        label: bundle.label,
        license: bundle.license,
        ...(bundle.runtimeNotice ? { runtimeNotice: bundle.runtimeNotice } : {}),
        installed: true,
        source: 'primary',
        dir: primaryCandidate,
      });
      continue;
    }

    let foundFallback: string | null = null;
    for (const fbRoot of fallbackRoots) {
      const fbCandidate = bundleDirUnder(fbRoot, bundle.repo);
      if (await isBundleCompleteInDir(fbCandidate, bundle, ledger, dirtyRef)) {
        foundFallback = fbCandidate;
        break;
      }
    }

    if (foundFallback) {
      results.push({
        id: bundle.id,
        label: bundle.label,
        license: bundle.license,
        ...(bundle.runtimeNotice ? { runtimeNotice: bundle.runtimeNotice } : {}),
        installed: true,
        source: 'fallback',
        dir: foundFallback,
      });
    } else {
      results.push({
        id: bundle.id,
        label: bundle.label,
        license: bundle.license,
        ...(bundle.runtimeNotice ? { runtimeNotice: bundle.runtimeNotice } : {}),
        installed: false,
        source: 'missing',
        dir: null,
      });
    }
  }

  if (dirtyRef.dirty) {
    await saveLedger(ledgerPath, ledger);
  }
  return results;
}

export async function resolveInstalledBundleDir(
  bundleId: string,
  options: ModelCacheOptions = {},
): Promise<string | null> {
  const bundles: Readonly<Record<string, DaemonModelBundleSpec>> =
    options.bundles ?? DAEMON_MODEL_BUNDLES;
  const spec = bundles[bundleId];
  if (!spec) return null;
  const statuses = await inspectModelCache({
    ...options,
    bundles: { [bundleId]: spec },
  });
  return statuses[0]?.dir ?? null;
}

function archiveRedirectAllowed(targetUrl: string, allowCustomHost: boolean): boolean {
  if (redirectHostAllowed(targetUrl, allowCustomHost)) return true;
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

async function fetchHopByHop(
  initialUrl: string,
  fetchFn: typeof fetch,
  isAllowedUrl: (url: string) => boolean,
): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    if (!isAllowedUrl(currentUrl)) {
      throw new Error(`Disallowed download or redirect host: ${currentUrl}`);
    }
    const res = await fetchFn(currentUrl, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (!location) {
        throw new Error(`HTTP ${res.status} redirect missing Location header from ${currentUrl}`);
      }
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error(`Too many HTTP redirects (>${MAX_REDIRECT_HOPS}) fetching ${initialUrl}`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      if (!isAllowedUrl(currentUrl)) {
        throw new Error(`Disallowed redirect target host: ${currentUrl}`);
      }
      continue;
    }
    return res;
  }
  throw new Error(`Redirect loop fetching ${initialUrl}`);
}

async function streamVerifiedDownload(opts: {
  label: string;
  candidateUrls: readonly string[];
  destPath: string;
  expectedSha256: string;
  expectedBytes?: number;
  fetchFn: typeof fetch;
  isAllowedUrl: (url: string) => boolean;
}): Promise<void> {
  const maxBytes = opts.expectedBytes ?? DEFAULT_MAX_FILE_BYTES;
  let lastErr: Error | null = null;

  for (const url of opts.candidateUrls) {
    const tmpPath = `${opts.destPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      const res = await fetchHopByHop(url, opts.fetchFn, opts.isAllowedUrl);
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`HTTP ${res.status} fetching ${opts.label}`);
      }

      const declaredLen = res.headers.get('content-length');
      if (declaredLen !== null) {
        const parsedLen = Number.parseInt(declaredLen, 10);
        if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(
            `Content-Length (${parsedLen}) exceeds byte limit (${maxBytes}) for ${opts.label}`,
          );
        }
      }

      if (!res.body) {
        throw new Error(`Empty response stream fetching ${opts.label}`);
      }

      await mkdir(dirname(opts.destPath), { recursive: true });
      const fh = await open(tmpPath, 'wx', 0o644);
      const hash = createHash('sha256');
      let received = 0;
      const reader = res.body.getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new Error(
              `Stream byte length (${received}) exceeds expected limit (${maxBytes}) for ${opts.label}`,
            );
          }
          hash.update(value);
          await fh.write(value);
        }
      } finally {
        await fh.close();
      }

      if (opts.expectedBytes !== undefined && received !== opts.expectedBytes) {
        throw new Error(
          `Byte length mismatch for ${opts.label}: expected ${opts.expectedBytes}, received ${received}`,
        );
      }

      const digest = hash.digest('hex');
      if (digest.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
        throw new Error(
          `SHA-256 verification failed for ${opts.label}: expected ${opts.expectedSha256}, received ${digest}`,
        );
      }

      await rename(tmpPath, opts.destPath);
      return;
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr ?? new Error(`Failed to download ${opts.label}`);
}

const TAR_BLOCK = 512;
const FORBIDDEN_TAR_TYPES = new Set(['1', '2', '3', '4', '6']);
const UTF8_DEC = new TextDecoder('utf-8');

function readCString(bytes: Uint8Array, start: number, maxLen: number): string {
  let end = start;
  const limit = start + maxLen;
  while (end < limit && bytes[end] !== 0) end += 1;
  return end > start ? UTF8_DEC.decode(bytes.subarray(start, end)) : '';
}

function isAllZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + TAR_BLOCK; i += 1) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function decompressArchiveToTar(
  compressedBytes: Uint8Array,
  compression: RuntimeArchiveSpec['compression'],
): Uint8Array {
  if (compression === 'tar') return compressedBytes;
  if (compression === 'tar.gz') {
    return new Uint8Array(gunzipSync(compressedBytes));
  }

  const decompressors: Array<[string, string[]]> = [
    ['bzip2', ['-dc']],
    ['python3', ['-c', 'import bz2,sys; sys.stdout.buffer.write(bz2.decompress(sys.stdin.buffer.read()))']],
    ['python', ['-c', 'import bz2,sys; sys.stdout.buffer.write(bz2.decompress(sys.stdin.buffer.read()))']],
  ];
  let lastErr: unknown = null;
  for (const [cmd, args] of decompressors) {
    try {
      const out = execFileSync(cmd, args, {
        input: compressedBytes,
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Unable to decompress .tar.bz2 archive (install bzip2 or python3): ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

async function extractSafeSubdirTar(
  tarBytes: Uint8Array,
  targetDir: string,
  requiredPrefix: string,
): Promise<void> {
  let offset = 0;
  let zeroBlocks = 0;

  while (offset + TAR_BLOCK <= tarBytes.byteLength) {
    if (isAllZeroBlock(tarBytes, offset)) {
      zeroBlocks += 1;
      offset += TAR_BLOCK;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;

    const name = readCString(tarBytes, offset, 100);
    const sizeOctal = readCString(tarBytes, offset + 124, 12).trim();
    const size = sizeOctal.length > 0 ? Number.parseInt(sizeOctal, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid tar entry size "${sizeOctal}" for "${name}"`);
    }

    const typeByte = tarBytes[offset + 156] ?? 0;
    const typeflag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const magic = readCString(tarBytes, offset + 257, 6);
    const prefix = magic.startsWith('ustar') ? readCString(tarBytes, offset + 345, 155) : '';
    const rawPath = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');

    if (FORBIDDEN_TAR_TYPES.has(typeflag)) {
      throw new Error(`Unsafe tar link or device entry rejected: "${rawPath}" (type=${typeflag})`);
    }
    if (
      rawPath.startsWith('/') ||
      rawPath.includes('\\') ||
      rawPath.includes('\0') ||
      rawPath.split('/').some((seg) => seg === '..')
    ) {
      throw new Error(`Unsafe path traversal in tar archive rejected: "${rawPath}"`);
    }

    const dataStart = offset + TAR_BLOCK;
    const paddedSize = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (dataStart + paddedSize > tarBytes.byteLength) {
      throw new Error(`Truncated tar archive at entry "${rawPath}"`);
    }

    const isDir = typeflag === '5' || rawPath.endsWith('/');
    if (!isDir && (typeflag === '0' || typeflag === '')) {
      if (!rawPath.startsWith(requiredPrefix) || !isSafeModelRel(rawPath)) {
        throw new Error(
          `Unsafe tar entry outside "${requiredPrefix}" rejected: "${rawPath}"`,
        );
      }
      const destFile = join(targetDir, ...rawPath.split('/'));
      await mkdir(dirname(destFile), { recursive: true });
      const tmpFile = `${destFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmpFile, tarBytes.subarray(dataStart, dataStart + size));
      await rename(tmpFile, destFile);
    }

    offset = dataStart + paddedSize;
  }
}

export interface DownloadModelOptions extends ModelCacheOptions {
  preferredHost?: string;
  allowCustomHost?: boolean;
  fetchImpl?: typeof fetch;
  onProgress?: (file: string, index: number, total: number) => void;
}

export async function downloadModelBundle(
  bundleId: string,
  options: DownloadModelOptions = {},
): Promise<string> {
  const bundles: Readonly<Record<string, DaemonModelBundleSpec>> =
    options.bundles ?? DAEMON_MODEL_BUNDLES;
  const bundle = bundles[bundleId];
  if (!bundle) {
    throw new Error(`Unknown model bundle "${bundleId}"`);
  }

  const existing = await resolveInstalledBundleDir(bundleId, options);
  if (existing) {
    return existing;
  }

  const primaryRoot = options.cacheDir ?? defaultModelCacheDir();
  const targetDir = bundleDirUnder(primaryRoot, bundle.repo);
  await mkdir(targetDir, { recursive: true });

  const allowCustom = options.allowCustomHost ?? false;
  const fetchFn: typeof fetch =
    options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const ledgerPath = join(primaryRoot, 'verified-sha256-v1.json');
  const ledger = await loadLedger(ledgerPath);
  const dirtyRef = { dirty: false };
  const totalSteps = bundle.files.length + (bundle.runtimeArchive ? 1 : 0);

  for (let idx = 0; idx < bundle.files.length; idx += 1) {
    const fileSpec = bundle.files[idx];
    if (!fileSpec) continue;
    const destPath = join(targetDir, ...fileSpec.file.split('/'));
    if (await verifyFileOnDisk(destPath, fileSpec, ledger, dirtyRef)) {
      continue;
    }

    options.onProgress?.(fileSpec.file, idx + 1, totalSteps);
    const candidateUrls = resolveModelFileUrls(
      bundle.repo,
      { ...fileSpec, revision: fileSpec.revision ?? bundle.revision },
      options.preferredHost,
      allowCustom,
    );

    await streamVerifiedDownload({
      label: fileSpec.file,
      candidateUrls,
      destPath,
      expectedSha256: fileSpec.sha256,
      ...(fileSpec.bytes !== undefined ? { expectedBytes: fileSpec.bytes } : {}),
      fetchFn,
      isAllowedUrl: (u) => redirectHostAllowed(u, allowCustom),
    });
    await verifyFileOnDisk(destPath, fileSpec, ledger, dirtyRef);
  }

  if (bundle.runtimeArchive) {
    const archive = bundle.runtimeArchive;
    const sentinelPath = join(targetDir, ...archive.sentinelFile.split('/'));
    const sentinelAlreadyOk = await verifyFileOnDisk(
      sentinelPath,
      { file: archive.sentinelFile, sha256: archive.sentinelSha256 },
      ledger,
      dirtyRef,
    );

    if (!sentinelAlreadyOk) {
      options.onProgress?.(archive.subdirPrefix, totalSteps, totalSteps);
      const tmpArchivePath = join(
        targetDir,
        `.runtime-archive.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
      );
      try {
        await streamVerifiedDownload({
          label: archive.subdirPrefix,
          candidateUrls: archive.urls,
          destPath: tmpArchivePath,
          expectedSha256: archive.sha256,
          expectedBytes: archive.bytes,
          fetchFn,
          isAllowedUrl: (u) => archiveRedirectAllowed(u, allowCustom),
        });
        const archiveBytes = new Uint8Array(await readFile(tmpArchivePath));
        const tarBytes = decompressArchiveToTar(archiveBytes, archive.compression);
        await extractSafeSubdirTar(tarBytes, targetDir, archive.subdirPrefix);
      } finally {
        await rm(tmpArchivePath, { force: true }).catch(() => undefined);
      }

      const verifiedPostExtract = await verifyFileOnDisk(
        sentinelPath,
        { file: archive.sentinelFile, sha256: archive.sentinelSha256 },
        ledger,
        dirtyRef,
      );
      if (!verifiedPostExtract) {
        throw new Error(
          `Runtime archive sentinel verification failed for "${archive.sentinelFile}"`,
        );
      }
    }
  }

  if (dirtyRef.dirty) {
    await saveLedger(ledgerPath, ledger);
  }
  return targetDir;
}
