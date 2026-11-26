#!/usr/bin/env node
// End-to-end MCP verification (P1-5/P2-5): starts a real daemon on an ephemeral port,
// spawns the MCP server over stdio, and calls voice_health through JSON-RPC.
// Exit code 0 = PASS. Requires only built dist (no models, no network).
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const daemonBin = join(distDir, 'cli.js');
const mcpBin = join(distDir, 'mcp-server.js');
const tokenPath = join(mkdtempSync(join(tmpdir(), 'voice-mode-mcp-')), 'daemon.token');

const daemon = spawn(process.execPath, [daemonBin, 'serve', '--port', '0', '--token-file', tokenPath], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const daemonLog = [];
daemon.stdout.on('data', (d) => daemonLog.push(String(d)));
daemon.stderr.on('data', (d) => daemonLog.push(String(d)));

let port = '';
const started = Date.now();
while (Date.now() - started < 15_000) {
  const match = /(?:listening on |http:\/\/)(?:127\.0\.0\.1:)?(\d{4,5})/.exec(daemonLog.join(''));
  if (match) {
    port = match[1];
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!port) {
  console.error('daemon did not report a port:\n' + daemonLog.join('').slice(0, 2000));
  daemon.kill('SIGKILL');
  process.exit(1);
}

const mcp = spawn(process.execPath, [mcpBin], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, VOICE_MODE_BASE: `http://127.0.0.1:${port}`, VOICE_MODE_TOKEN_PATH: tokenPath },
});
const rl = createInterface({ input: mcp.stdout });
const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 10_000);
  });
const notify = (method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

const finish = (code, message) => {
  console.log(message);
  mcp.kill('SIGKILL');
  daemon.kill('SIGKILL');
  process.exit(code);
};

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-mcp', version: '0.0.0' },
  });
  notify('notifications/initialized', {});
  const tools = await request('tools/list', {});
  const names = (tools.result?.tools ?? []).map((tool) => tool.name);
  const call = await request('tools/call', { name: 'voice_health', arguments: {} });
  const text = call.result?.content?.find((item) => item.type === 'text')?.text ?? '';
  const health = JSON.parse(text);
  const ok =
    init.result?.serverInfo?.name === 'voice-mode-daemon' &&
    ['voice_health', 'voice_speak', 'voice_transcribe'].every((name) => names.includes(name)) &&
    health.ok === true;
  finish(ok ? 0 : 1, ok ? `verify:mcp PASS (daemon ${health.version}, tools: ${names.join(',')})` : 'verify:mcp FAIL');
} catch (err) {
  finish(1, `verify:mcp FAIL: ${err.message}`);
}
