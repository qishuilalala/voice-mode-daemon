#!/usr/bin/env node
// Voice Mode Daemon · MCP server (P1-5 / P2-5): expose daemon TTS/ASR as MCP tools.
// Transport: stdio (spawned by an MCP-capable host). Talks to the local daemon over its
// loopback HTTP API; token comes from env VOICE_MODE_TOKEN or the daemon token file.
import fs from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { DAEMON_VERSION } from './server.js';
import { defaultDaemonTokenPath } from './security.js';

type FetchLike = typeof fetch;

/** Resolve daemon base URL, token and fetch implementation (env-driven, test-injectable). */
export interface McpDaemonConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}

function resolveDaemonToken(): string {
  const fromEnv = process.env.VOICE_MODE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const tokenPath = process.env.VOICE_MODE_TOKEN_PATH?.trim() || defaultDaemonTokenPath();
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch {
    throw new Error(
      `无法读取 daemon 令牌（${tokenPath}）；请设置 VOICE_MODE_TOKEN 或先启动 daemon 生成令牌。`,
    );
  }
}

export interface VoiceMcpHandlers {
  health(): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
  speak(args: { text: string; voice?: string | undefined; speed?: number | undefined }): Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'audio'; data: string; mimeType: string }>;
  }>;
  transcribe(args: { path: string; model?: 'zipformer2' | 'sensevoice' | undefined; language?: string | undefined }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;
}

export function createVoiceMcpHandlers(config: McpDaemonConfig): VoiceMcpHandlers {
  const fetchImpl: FetchLike = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${config.token}` };

  const callDaemon = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        detail = '';
      }
      throw new Error(`daemon ${path} 返回 ${res.status}${detail ? `：${detail}` : ''}`);
    }
    return res;
  };

  return {
    async health() {
      const res = await callDaemon('/v1/health');
      const health = (await res.json()) as Record<string, unknown>;
      return { content: [{ type: 'text' as const, text: JSON.stringify(health, null, 2) }] };
    },
    async speak({ text, voice, speed }) {
      const body: Record<string, unknown> = { input: text, response_format: 'wav' };
      if (voice) body.voice = voice;
      if (speed !== undefined) body.speed = speed;
      const res = await callDaemon('/v1/audio/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      return {
        content: [
          { type: 'text' as const, text: `已合成 ${bytes.byteLength} 字节 audio/wav` },
          { type: 'audio' as const, data: bytes.toString('base64'), mimeType: 'audio/wav' },
        ],
      };
    },
    async transcribe({ path, model, language }) {
      const wav = fs.readFileSync(path);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
      if (model) form.append('model', model);
      if (language) form.append('language', language);
      const res = await callDaemon('/v1/audio/transcriptions', { method: 'POST', body: form });
      const payload = (await res.json()) as { text?: string; language?: string };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ text: payload.text ?? '', language: payload.language ?? null }),
          },
        ],
      };
    },
  };
}

export function createVoiceMcpServer(config: McpDaemonConfig): McpServer {
  const handlers = createVoiceMcpHandlers(config);
  const server = new McpServer({ name: 'voice-mode-daemon', version: DAEMON_VERSION });
  server.registerTool(
    'voice_health',
    { description: '查询本机 voice-daemon 状态（版本、可用音色、是否健康）' },
    handlers.health,
  );
  server.registerTool(
    'voice_speak',
    {
      description: '把文本合成为 24kHz WAV 语音并作为音频内容返回',
      inputSchema: {
        text: z.string().min(1).describe('要朗读的文本'),
        voice: z.string().optional().describe('Kokoro 音色（如 zf_xiaobei）'),
        speed: z.number().optional().describe('语速倍率（默认 1.0）'),
      },
    },
    handlers.speak,
  );
  server.registerTool(
    'voice_transcribe',
    {
      description: '把本地 16kHz PCM16 WAV 文件转写为文本（需 zipformer2 或 sensevoice 模型）',
      inputSchema: {
        path: z.string().min(1).describe('WAV 文件绝对路径（16kHz mono PCM16）'),
        model: z.enum(['zipformer2', 'sensevoice']).optional().describe('识别模型'),
        language: z.string().optional().describe('语言提示（如 zh）'),
      },
    },
    handlers.transcribe,
  );
  return server;
}

export async function main(): Promise<void> {
  const config: McpDaemonConfig = {
    baseUrl: process.env.VOICE_MODE_BASE?.trim() || 'http://127.0.0.1:18790',
    token: resolveDaemonToken(),
  };
  const server = createVoiceMcpServer(config);
  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
