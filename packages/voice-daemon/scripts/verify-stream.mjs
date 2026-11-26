#!/usr/bin/env node
// End-to-end streaming ASR verification (P1-5): real daemon + core DaemonStreamTranscriber.
// Flow: start daemon -> synthesize speech with Kokoro -> decode to 16 kHz PCM -> stream via
// WebSocket -> assert a final transcript arrives. SKIPs cleanly when models are not installed.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const coreEntry = join(distDir, '..', 'node_modules', '@voice-mode', 'core', 'dist', 'index.js');
const { DaemonStreamTranscriber, decodeMonoPcm16Wav } = await import(coreEntry);
const daemonBin = join(distDir, 'cli.js');
const tokenPath = join(mkdtempSync(join(tmpdir(), 'voice-mode-stream-')), 'daemon.token');

const daemon = spawn(process.execPath, [daemonBin, 'serve', '--port', '0', '--token-file', tokenPath, '--cache-dir', process.env.VOICE_MODE_CACHE_DIR ?? '']);
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
while (Date.now() - started < 20_000) {
  const match = /127\.0\.0\.1:(\d{4,5})/.exec(log.join(''));
  if (match) {
    port = match[1];
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!port) {
  finish(1, 'daemon did not report a port:\n' + log.join('').slice(0, 1500));
}
const token = (await import('node:fs')).readFileSync(tokenPath, 'utf8').trim();
const base = `http://127.0.0.1:${port}`;

const api = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${path} -> ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
};

try {
  // Skip when the models are not installed (CI runners have no model cache).
  const status = await (await api('/v1/models/status')).json();
  const installed = (id) => status.bundles?.some((bundle) => bundle.id === id && bundle.installed);
  if (!installed('kokoro-int8') || !installed('zipformer2')) {
    finish(0, 'verify:stream SKIP (models not installed)');
  }

  // 1) Synthesize a short utterance with the daemon's Kokoro path.
  const speech = await api('/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: '你好，语音模式。', voice: 'zf_xiaobei', response_format: 'wav' }),
  });
  const wav = new Uint8Array(await speech.arrayBuffer());
  const decoded = decodeMonoPcm16Wav(wav);
  if (!decoded) {
    finish(1, 'verify:stream FAIL (could not decode synthesized WAV)');
  }
  const samples = decoded.samples instanceof Float32Array ? decoded.samples : Float32Array.from(decoded.samples);
  // Resample 24 kHz -> 16 kHz (the streaming endpoint expects 16 kHz PCM16).
  const ratio = decoded.sampleRate / 16_000;
  const pcm16k = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < pcm16k.length; i += 1) {
    pcm16k[i] = samples[Math.min(samples.length - 1, Math.round(i * ratio))] ?? 0;
  }

  // 2) Stream over WebSocket with the shared core client.
  const partials = [];
  let final = null;
  const transcriber = new DaemonStreamTranscriber({
    url: `ws://127.0.0.1:${port}`,
    token,
    onPartial: (text) => partials.push(text),
  });
  await transcriber.connect();
  const chunk = 1_600; // 100 ms frames
  for (let offset = 0; offset < pcm16k.length; offset += chunk) {
    transcriber.pushPcm16(pcm16k.slice(offset, Math.min(offset + chunk, pcm16k.length)));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  final = await transcriber.stop();
  transcriber.close();

  const ok = typeof final.text === 'string' && final.text.length > 0;
  finish(
    ok ? 0 : 1,
    ok
      ? `verify:stream PASS (pcm ${pcm16k.length} samples, partials ${partials.length}, final "${final.text.slice(0, 40)}")`
      : 'verify:stream FAIL (empty final transcript)',
  );
} catch (err) {
  finish(1, `verify:stream FAIL: ${err instanceof Error ? err.message : String(err)}`);
}
