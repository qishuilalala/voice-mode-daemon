import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_ASR_AUDIO_BYTES, redactSecrets } from '@voice-mode/core';
import {
  KOKORO_EXPOSED_VOICES,
  ModelNotInstalledError,
  SpeechEngineRegistry,
} from './engine-registry.js';
import { inspectModelCache, type ModelCacheOptions } from './model-cache.js';
import {
  DEFAULT_DAEMON_HOST,
  DEFAULT_DAEMON_PORT,
  evaluateLoopbackSecurity,
  isAllowedLoopbackBindHost,
  loadOrCreateDaemonToken,
} from './security.js';
import { decodePcm16Wav, parseMultipartFormData } from './wav-multipart.js';

export const DAEMON_VERSION = '0.1.0';
const MAX_JSON_BODY_BYTES = 256 * 1024;
const MAX_MULTIPART_BODY_BYTES = MAX_ASR_AUDIO_BYTES + 64 * 1024;
const MAX_TTS_INPUT_CHARS = 8_000;

class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body exceeds limit of ${limit} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

async function readBoundedRequestBody(req: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.byteLength;
    if (total > maxBytes) {
      throw new PayloadTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

export interface VoiceDaemonServerOptions extends ModelCacheOptions {
  host?: string;
  port?: number;
  token?: string;
  tokenPath?: string;
  allowUnauthenticatedLoopback?: boolean;
  registry?: SpeechEngineRegistry;
}

export interface VoiceDaemonServerHandle {
  readonly host: string;
  readonly port: number;
  readonly registry: SpeechEngineRegistry;
  close(): Promise<void>;
}

export async function startVoiceDaemonServer(
  options: VoiceDaemonServerOptions = {},
): Promise<VoiceDaemonServerHandle> {
  const host = (options.host ?? DEFAULT_DAEMON_HOST).trim();
  if (!isAllowedLoopbackBindHost(host)) {
    throw new Error(`Refusing to bind voice-daemon to non-loopback interface "${host}"`);
  }

  const requestedPort = options.port ?? DEFAULT_DAEMON_PORT;
  const allowUnauth = options.allowUnauthenticatedLoopback ?? false;
  const token =
    options.token !== undefined && options.token.trim().length > 0
      ? options.token.trim()
      : await loadOrCreateDaemonToken(options.tokenPath);

  const registry = options.registry ?? new SpeechEngineRegistry(options);

  let boundPort = requestedPort;

  const httpServer = createServer((req, res) => {
    void handleRequest(req, res, {
      boundPort,
      expectedToken: token,
      allowUnauthenticatedLoopback: allowUnauth,
      registry,
      cacheOptions: options,
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(requestedPort, host);
  });

  const addr = httpServer.address() as AddressInfo | null;
  boundPort = addr?.port ?? requestedPort;

  return {
    host,
    port: boundPort,
    registry,
    close(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

interface RequestContext {
  boundPort: number;
  expectedToken: string;
  allowUnauthenticatedLoopback: boolean;
  registry: SpeechEngineRegistry;
  cacheOptions: ModelCacheOptions;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const guard = evaluateLoopbackSecurity({
    method,
    hostHeader: typeof req.headers.host === 'string' ? req.headers.host : undefined,
    originHeader: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    authorizationHeader:
      typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
    boundPort: ctx.boundPort,
    expectedToken: ctx.expectedToken,
    allowUnauthenticatedLoopback: ctx.allowUnauthenticatedLoopback,
  });

  if (!guard.ok) {
    sendJson(res, guard.status, { error: { message: guard.error } }, guard.headers);
    return;
  }

  if (guard.isPreflight) {
    res.writeHead(204, {
      'Cache-Control': 'no-store',
      ...guard.headers,
    });
    res.end();
    return;
  }

  const corsHeaders = guard.headers;
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${ctx.boundPort}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  try {
    if (method === 'GET' && pathname === '/v1/health') {
      sendJson(
        res,
        200,
        {
          ok: true,
          service: 'voice-daemon',
          version: DAEMON_VERSION,
          capabilities: ['tts:kokoro-103', 'asr:zipformer2', 'asr:sensevoice'],
          modelsLoaded: ctx.registry.modelsLoaded(),
          modelInstanceCount: ctx.registry.instanceCount(),
          pid: process.pid,
          rssBytes: process.memoryUsage.rss(),
          voices: KOKORO_EXPOSED_VOICES,
        },
        corsHeaders,
      );
      return;
    }

    if (method === 'GET' && pathname === '/v1/models/status') {
      const bundles = await inspectModelCache(ctx.cacheOptions);
      sendJson(res, 200, { ok: true, bundles }, corsHeaders);
      return;
    }

    if (method === 'POST' && pathname === '/v1/audio/speech') {
      const rawBody = await readBoundedRequestBody(req, MAX_JSON_BODY_BYTES);
      let parsed: Record<string, unknown>;
      try {
        const json = JSON.parse(new TextDecoder('utf-8').decode(rawBody)) as unknown;
        if (typeof json !== 'object' || json === null || Array.isArray(json)) {
          throw new Error('JSON body must be an object');
        }
        parsed = json as Record<string, unknown>;
      } catch (err) {
        sendJson(
          res,
          400,
          { error: { message: err instanceof Error ? err.message : 'Malformed JSON body' } },
          corsHeaders,
        );
        return;
      }

      const inputText = typeof parsed.input === 'string' ? parsed.input.trim() : '';
      if (!inputText) {
        sendJson(res, 400, { error: { message: 'Missing non-empty "input" field' } }, corsHeaders);
        return;
      }
      if (inputText.length > MAX_TTS_INPUT_CHARS) {
        sendJson(
          res,
          413,
          { error: { message: `Input exceeds ${MAX_TTS_INPUT_CHARS} character limit` } },
          corsHeaders,
        );
        return;
      }

      const format =
        typeof parsed.response_format === 'string'
          ? parsed.response_format.trim().toLowerCase()
          : 'wav';
      if (format !== 'wav') {
        sendJson(
          res,
          400,
          { error: { message: 'Only response_format="wav" is supported by voice-daemon' } },
          corsHeaders,
        );
        return;
      }

      const synthInput: { text: string; voice?: string; speed?: number } = { text: inputText };
      if (typeof parsed.voice === 'string') synthInput.voice = parsed.voice;
      if (typeof parsed.speed === 'number') synthInput.speed = parsed.speed;

      const { wav } = await ctx.registry.synthesizeSpeechWav(synthInput);
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(wav.byteLength),
        'Cache-Control': 'no-store',
        ...corsHeaders,
      });
      res.end(Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength));
      return;
    }

    if (method === 'POST' && pathname === '/v1/audio/transcriptions') {
      const rawBody = await readBoundedRequestBody(req, MAX_MULTIPART_BODY_BYTES);
      let form;
      try {
        form = parseMultipartFormData(
          rawBody,
          typeof req.headers['content-type'] === 'string'
            ? req.headers['content-type']
            : undefined,
        );
      } catch (err) {
        sendJson(
          res,
          400,
          { error: { message: err instanceof Error ? err.message : 'Invalid multipart form' } },
          corsHeaders,
        );
        return;
      }

      if (!form.file || form.file.bytes.byteLength === 0) {
        sendJson(
          res,
          400,
          { error: { message: 'Missing uploaded WAV audio in "file" field' } },
          corsHeaders,
        );
        return;
      }

      let decoded;
      try {
        decoded = decodePcm16Wav(form.file.bytes);
      } catch (err) {
        sendJson(
          res,
          400,
          { error: { message: err instanceof Error ? err.message : 'Malformed WAV file' } },
          corsHeaders,
        );
        return;
      }

      const asrInput: {
        samples: Float32Array;
        sampleRate: number;
        model?: string;
        language?: string;
      } = {
        samples: decoded.samples,
        sampleRate: decoded.sampleRate,
      };
      if (form.fields.model) asrInput.model = form.fields.model;
      if (form.fields.language) asrInput.language = form.fields.language;

      const result = await ctx.registry.transcribeAudio(asrInput);
      const responseFormat = (form.fields.response_format ?? 'json').trim().toLowerCase();
      if (responseFormat === 'text') {
        const plain = Buffer.from(result.text, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': String(plain.byteLength),
          'Cache-Control': 'no-store',
          ...corsHeaders,
        });
        res.end(plain);
        return;
      }

      sendJson(res, 200, result, corsHeaders);
      return;
    }

    sendJson(res, 404, { error: { message: `Unknown route ${method} ${pathname}` } }, corsHeaders);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: { message: err.message } }, corsHeaders);
      return;
    }
    if (err instanceof ModelNotInstalledError) {
      sendJson(res, 503, { error: { message: err.message } }, corsHeaders);
      return;
    }
    const safeMsg = redactSecrets(err instanceof Error ? err.message : String(err));
    sendJson(res, 500, { error: { message: safeMsg } }, corsHeaders);
  }
}
