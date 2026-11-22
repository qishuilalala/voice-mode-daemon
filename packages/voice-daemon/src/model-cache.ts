import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MODEL_BUNDLES,
  isSafeModelRel,
  redirectHostAllowed,
  resolveModelFileUrls,
  type ModelFileSpec,
} from '@voice-mode/core';

export type DaemonBundleId = 'kokoro-int8' | 'zipformer2' | 'sensevoice-int8';

export interface DaemonModelBundleSpec {
  id: string;
  label: string;
  repo: string;
  revision: string;
  license: string;
  runtimeNotice?: string;
  requiredSubpath?: string;
  files: ReadonlyArray<ModelFileSpec>;
}

export const DAEMON_MODEL_BUNDLES: Record<DaemonBundleId, DaemonModelBundleSpec> = {
  'kokoro-int8': {
    id: 'kokoro-int8',
    label: 'Kokoro v1.1 Multilingual int8 (103 speakers, zh + en)',
    repo: 'csukuangfj/kokoro-int8-multi-lang-v1_1',
    revision: 'main',
    license: 'Apache-2.0',
    runtimeNotice:
      'Kokoro ONNX weights are Apache-2.0; runtime phoneme lexicon directory espeak-ng-data is GPL-3.0-or-later, fetched exclusively into the user local cache at runtime and never bundled in Git or published packages.',
    requiredSubpath: 'espeak-ng-data/phontab',
    files: [
      {
        file: 'model.int8.onnx',
        sha256: 'bda15858163726a492d02a9a727bc263551b86ac77f90812c4b30ff41d380e26',
        bytes: 114299010,
      },
      {
        file: 'voices.bin',
        sha256: 'e64a5a581d8c2a350d848f51c3121657cd83aa07ed6109172177345874a7244c',
        bytes: 53790720,
      },
      {
        file: 'tokens.txt',
        sha256: '931ab2df2400cd65d580a22402024c2347ced8ae9ea300e545144b1aacc48e14',
        bytes: 1111,
      },
      {
        file: 'lexicon-us-en.txt',
        sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14',
        bytes: 5956885,
      },
      {
        file: 'lexicon-zh.txt',
        sha256: '11111d8cd695fba2ace1367a1d0a708b586e6ef5c1f9be91da5d7eef129b651c',
        bytes: 2119465,
      },
      {
        file: 'date-zh.fst',
        sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718',
        bytes: 59154,
      },
      {
        file: 'number-zh.fst',
        sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd',
        bytes: 64482,
      },
      {
        file: 'phone-zh.fst',
        sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7',
        bytes: 88630,
      },
    ],
  },
  zipformer2: {
    id: 'zipformer2',
    label: 'Streaming Zipformer2 Bilingual int8 (zh + en)',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30',
    revision: 'main',
    license: 'Apache-2.0',
    files: [
      {
        file: 'encoder.int8.onnx',
        sha256: '5ac51e27981bb4dab01bb9be4958453ba50c3b61c063ddda0eab23fd3671aa4f',
        bytes: 161141793,
      },
      {
        file: 'decoder.onnx',
        sha256: '06522ad63cec0fdf6809f4e1db9bb4f7d710c34582e3b35db62ac60eccafac7e',
        bytes: 5165083,
      },
      {
        file: 'joiner.int8.onnx',
        sha256: 'b34584dc6f561089e1d747fedebb3765f2caa72c927ef54d7ca55e5ae40a814b',
        bytes: 1033416,
      },
      {
        file: 'tokens.txt',
        sha256: '6193c7ea1c96d0d9a1e9652789b40d13a8a913b434a5451e93158f5a09fd6652',
        bytes: 20628,
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

  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const ledgerPath = join(primaryRoot, 'verified-sha256-v1.json');
  const ledger = await loadLedger(ledgerPath);
  const dirtyRef = { dirty: false };

  for (let idx = 0; idx < bundle.files.length; idx += 1) {
    const fileSpec = bundle.files[idx];
    if (!fileSpec) continue;
    const destPath = join(targetDir, ...fileSpec.file.split('/'));
    if (await verifyFileOnDisk(destPath, fileSpec, ledger, dirtyRef)) {
      continue;
    }

    options.onProgress?.(fileSpec.file, idx + 1, bundle.files.length);
    const candidateUrls = resolveModelFileUrls(
      bundle.repo,
      { ...fileSpec, revision: fileSpec.revision ?? bundle.revision },
      options.preferredHost,
      options.allowCustomHost ?? false,
    );

    let lastErr: Error | null = null;
    let succeeded = false;
    for (const url of candidateUrls) {
      try {
        const res = await fetchFn(url, { redirect: 'follow' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} fetching ${fileSpec.file}`);
        }
        if (res.url && !redirectHostAllowed(res.url, options.allowCustomHost ?? false)) {
          throw new Error(`Disallowed redirect host for ${fileSpec.file}: ${res.url}`);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (fileSpec.bytes !== undefined && bytes.byteLength !== fileSpec.bytes) {
          throw new Error(
            `Byte length mismatch for ${fileSpec.file}: expected ${fileSpec.bytes}, received ${bytes.byteLength}`,
          );
        }
        const digest = createHash('sha256').update(bytes).digest('hex');
        if (digest.toLowerCase() !== fileSpec.sha256.toLowerCase()) {
          throw new Error(
            `SHA-256 verification failed for ${fileSpec.file}: expected ${fileSpec.sha256}, received ${digest}`,
          );
        }

        await mkdir(dirname(destPath), { recursive: true });
        const tmpPath = `${destPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        try {
          await writeFile(tmpPath, bytes);
          await rename(tmpPath, destPath);
        } catch (writeErr) {
          await rm(tmpPath, { force: true }).catch(() => undefined);
          throw writeErr;
        }
        await verifyFileOnDisk(destPath, fileSpec, ledger, dirtyRef);
        succeeded = true;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!succeeded) {
      throw lastErr ?? new Error(`Failed to download ${fileSpec.file}`);
    }
  }

  if (dirtyRef.dirty) {
    await saveLedger(ledgerPath, ledger);
  }
  return targetDir;
}
