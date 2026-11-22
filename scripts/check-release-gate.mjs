#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];

function fail(msg) {
  failures.push(msg);
}

// 1. Version & MIT license consistency
for (const rel of [
  'package.json',
  'packages/voice-daemon/package.json',
  'packages/browser-extension/package.json',
]) {
  const pkgPath = join(ROOT, rel);
  if (!existsSync(pkgPath)) {
    fail(`Missing ${rel}`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (pkg.version !== '0.1.0') {
    fail(`${rel} version must be "0.1.0", found "${pkg.version}"`);
  }
  if (pkg.license !== 'MIT') {
    fail(`${rel} license must be "MIT", found "${pkg.license}"`);
  }
}

const licensePath = join(ROOT, 'LICENSE');
if (!existsSync(licensePath) || !readFileSync(licensePath, 'utf8').includes('MIT License')) {
  fail('Root LICENSE must exist and declare MIT License');
}

// 2. Context budget check (CONTEXT.md <= 110 lines)
const contextPath = join(ROOT, 'CONTEXT.md');
if (!existsSync(contextPath)) {
  fail('Missing root CONTEXT.md');
} else {
  const lines = readFileSync(contextPath, 'utf8').split('\n').length;
  if (lines > 110) {
    fail(`CONTEXT.md exceeds 110-line budget (${lines} lines)`);
  }
}

// 3. Zero bundled model weights or GPL-3.0 espeak-ng-data anywhere in tracked/workspace tree
const FORBIDDEN_WEIGHT_EXTS = ['.onnx', '.ort', '.fst'];
const FORBIDDEN_NAMES = new Set(['voices.bin', 'espeak-ng-data', 'phontab']);

function walkTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (FORBIDDEN_NAMES.has(entry.name)) {
      fail(`Forbidden weight/GPL artifact in workspace tree: ${full}`);
    }
    if (entry.isDirectory()) {
      walkTree(full);
    } else if (FORBIDDEN_WEIGHT_EXTS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      fail(`Forbidden binary model weight in workspace tree: ${full}`);
    }
  }
}
walkTree(ROOT);

// 4. Strict MV3 Store Gate on packages/browser-extension/dist/manifest.json & bundles
const distDir = join(ROOT, 'packages', 'browser-extension', 'dist');
const manifestPath = join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  fail('Missing built MV3 manifest at packages/browser-extension/dist/manifest.json');
} else {
  const rawManifest = readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(rawManifest);

  if (manifest.manifest_version !== 3) {
    fail(`manifest_version must be 3, found ${manifest.manifest_version}`);
  }
  if (manifest.version !== '0.1.0') {
    fail(`MV3 manifest version must be "0.1.0", found "${manifest.version}"`);
  }

  if (rawManifest.includes('<all_urls>') || rawManifest.includes('*://*/*')) {
    fail('MV3 manifest contains forbidden broad host wildcard (<all_urls> or *://*/*)');
  }

  const allHostPatterns = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.matches ?? []),
  ];
  for (const pat of allHostPatterns) {
    if (
      pat === '<all_urls>' ||
      pat === '*://*/*' ||
      pat === 'http://*/*' ||
      pat === 'https://*/*'
    ) {
      fail(`Forbidden broad host match pattern in manifest.json: ${pat}`);
    }
  }

  const expectedPerms = ['activeTab', 'sidePanel', 'storage'];
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(expectedPerms)) {
    fail(
      `MV3 permissions must equal ${JSON.stringify(expectedPerms)}, found ${JSON.stringify(manifest.permissions)}`,
    );
  }

  const expectedHostPerms = ['http://127.0.0.1/*', 'http://localhost/*'];
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHostPerms)) {
    fail(
      `MV3 host_permissions must equal ${JSON.stringify(expectedHostPerms)}, found ${JSON.stringify(manifest.host_permissions)}`,
    );
  }

  const expectedOptionalHosts = [
    'https://chat.deepseek.com/*',
    'https://gemini.google.com/*',
    'https://kimi.moonshot.cn/*',
    'https://www.kimi.com/*',
  ];
  if (
    JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(expectedOptionalHosts)
  ) {
    fail(
      `MV3 optional_host_permissions mismatch: ${JSON.stringify(manifest.optional_host_permissions)}`,
    );
  }

  for (const bundleName of ['sw.js', 'sidepanel.js', 'content.js', 'sidepanel.html']) {
    const bundlePath = join(distDir, bundleName);
    if (!existsSync(bundlePath) || statSync(bundlePath).size === 0) {
      fail(`Missing or empty MV3 artifact: dist/${bundleName}`);
      continue;
    }
    const content = readFileSync(bundlePath, 'utf8');
    if (/\beval\s*\(/.test(content) || /\bnew\s+Function\s*\(/.test(content)) {
      fail(`MV3 artifact dist/${bundleName} contains forbidden eval() or new Function()`);
    }
    if (/https?:\/\/[^\s"'`]+\.js\b/i.test(content) && bundleName.endsWith('.html')) {
      fail(`MV3 HTML dist/${bundleName} loads remote script code`);
    }
    if (
      /speech\.platform\.bing\.com/i.test(content) ||
      /TrustedClientToken/i.test(content)
    ) {
      fail(`MV3 artifact dist/${bundleName} contains forbidden Edge Read Aloud WebSocket endpoint`);
    }
  }
}

// 5. Zero AI attribution check across git commits (if any commits exist)
try {
  const logOut = execFileSync('git', ['log', '--format=%B'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (/co-authored-by:.*(claude|anthropic|openai|gemini|copilot|cursor)/i.test(logOut)) {
    fail('Git commit history contains forbidden AI attribution trailer');
  }
} catch {
  // No commits yet — acceptable before initial commit.
}

if (failures.length > 0) {
  console.error('Release gate FAILED:');
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
}

console.log('Release gate PASSED: 0.1.0 versions, MIT license, zero weights/GPL, MV3 Store compliant.');
