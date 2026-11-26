import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createVoiceMcpHandlers } from '../dist/index.js';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('voice-daemon MCP tools (P1-5/P2-5)', () => {
  it('health tool returns daemon snapshot and sends the bearer token', async () => {
    let seenAuth = '';
    const handlers = createVoiceMcpHandlers({
      baseUrl: 'http://127.0.0.1:18790/',
      token: 'test-token',
      fetchImpl: (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
        seenAuth = String(init?.headers?.Authorization ?? '');
        return jsonResponse({ ok: true, version: '0.1.0', voices: ['zf_xiaobei'] });
      }) as unknown as typeof fetch,
    });
    const result = await handlers.health();
    assert.equal(seenAuth, 'Bearer test-token');
    assert.match(result.content[0]?.text ?? '', /"ok": true/);
  });

  it('speak tool posts JSON and returns base64 audio content', async () => {
    let seenBody = '';
    const handlers = createVoiceMcpHandlers({
      baseUrl: 'http://127.0.0.1:18790',
      token: 't',
      fetchImpl: (async (_url: unknown, init?: { body?: unknown }) => {
        seenBody = String(init?.body ?? '');
        return new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        });
      }) as unknown as typeof fetch,
    });
    const result = await handlers.speak({ text: '你好', voice: 'zf_xiaobei', speed: 1.1 });
    const body = JSON.parse(seenBody) as Record<string, unknown>;
    assert.equal(body.input, '你好');
    assert.equal(body.voice, 'zf_xiaobei');
    assert.equal(body.speed, 1.1);
    const audio = result.content.find((item) => item.type === 'audio');
    assert.ok(audio && audio.type === 'audio');
    assert.equal(audio.data, Buffer.from([1, 2, 3, 4]).toString('base64'));
    assert.equal(audio.mimeType, 'audio/wav');
  });

  it('transcribe tool rejects daemon errors with status detail', async () => {
    const handlers = createVoiceMcpHandlers({
      baseUrl: 'http://127.0.0.1:18790',
      token: 't',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: 'asr unavailable', code: 'asr_unavailable' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => handlers.transcribe({ path: '/tmp/does-not-exist-voice-mode.wav' }),
      /ENOENT/,
      'missing file should surface before any network call',
    );
  });
});
