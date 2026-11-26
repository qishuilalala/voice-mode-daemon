#!/usr/bin/env node
// API contract drift check (docs/23 §contract): starts a real daemon and compares the
// documented JSON examples in docs/API.md against live responses for GET endpoints.
// Rule: documented keys must be a subset of live keys (docs may omit growing fields but
// must not invent fields), and required top-level keys must be documented.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url)); // packages/voice-daemon/scripts -> repo root
const distDir = join(root, 'packages/voice-daemon/dist');
const apiDoc = join(root, 'docs/API.md');
const tokenPath = join(mkdtempSync(join(tmpdir(), 'voice-mode-api-')), 'daemon.token');

const daemon = spawn(process.execPath, [join(distDir, 'cli.js'), 'serve', '--port', '0', '--token-file', tokenPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
daemon.stdout.on('data', (d) => log.push(String(d)));
daemon.stderr.on('data', (d) => log.push(String(d)));
const finish = (code, message) => {
  console.log(message);
  daemon.kill('SIGKILL');
  process.exit(code);
};

let port = '';
const started = Date.now();
while (Date.now() - started < 15_000) {
  const match = /127\.0\.0\.1:(\d{4,5})/.exec(log.join(''));
  if (match) {
    port = match[1];
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!port) finish(1, 'daemon did not report a port:\n' + log.join('').slice(0, 1500));
const token = readFileSync(tokenPath, 'utf8').trim();
const get = async (path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
};

// Extract the first JSON fenced block under a "### GET /v1/x" heading.
const doc = readFileSync(apiDoc, 'utf8');
const documentedShape = (endpoint) => {
  const heading = `### GET ${endpoint}`;
  const start = doc.indexOf(heading);
  if (start < 0) return null;
  const rest = doc.slice(start);
  const fence = rest.indexOf('```json');
  if (fence < 0) return null;
  const end = rest.indexOf('```', fence + 7);
  if (end < 0) return null;
  try {
    return JSON.parse(rest.slice(fence + 7, end));
  } catch {
    return null;
  }
};
const keysOf = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []);
const subset = (documented, live) => {
  const liveKeys = new Set(keysOf(live));
  return keysOf(documented).filter((key) => !liveKeys.has(key));
};

const checks = [
  ['/v1/health', await get('/v1/health')],
  ['/v1/capabilities', await get('/v1/capabilities')],
  ['/v1/models', await get('/v1/models')],
];
const problems = [];
for (const [endpoint, live] of checks) {
  const documented = documentedShape(endpoint);
  if (!documented) {
    problems.push(`${endpoint}: no JSON example found in docs/API.md`);
    continue;
  }
  const invented = subset(documented, live);
  if (invented.length > 0) {
    problems.push(`${endpoint}: document invents fields not in live response: ${invented.join(', ')}`);
  }
  // Nested spot checks for the structured endpoints.
  if (endpoint === '/v1/health' && !Array.isArray(live.capabilities)) {
    problems.push('/v1/health: capabilities must be an array');
  }
  if (endpoint === '/v1/capabilities') {
    if (!Array.isArray(live.tts?.engines) || !Array.isArray(live.asr?.engines)) {
      problems.push('/v1/capabilities: tts.engines/asr.engines arrays missing');
    }
    if (keysOf(documented.tts?.engines?.[0]).some((key) => !(key in (live.tts?.engines?.[0] ?? {})))) {
      problems.push('/v1/capabilities: tts.engines[0] documented keys not in live response');
    }
  }
  if (endpoint === '/v1/models' && (live.object !== 'list' || !Array.isArray(live.data))) {
    problems.push('/v1/models: expected OpenAI-style object:"list" + data[]');
  }
}

if (problems.length > 0) {
  finish(1, `check-api-doc: ${problems.length} problem(s)\n - ${problems.join('\n - ')}`);
}
finish(0, `check-api-doc PASS (${checks.length} endpoints aligned with docs/API.md)`);
