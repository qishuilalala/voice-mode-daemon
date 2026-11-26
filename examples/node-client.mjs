#!/usr/bin/env node
// Voice Mode Daemon 最小客户端示例（无第三方依赖，Node >= 22.18）。
// 用法：VOICE_MODE_TOKEN=<token> node examples/node-client.mjs "要合成的文本"
const base = process.env.VOICE_MODE_BASE ?? 'http://127.0.0.1:18790'
const token = process.env.VOICE_MODE_TOKEN ?? ''
if (!token) {
  console.error('缺少 VOICE_MODE_TOKEN（用 `voice-daemon token-path` 查看令牌文件）')
  process.exit(2)
}
const headers = { Authorization: `Bearer ${token}` }

const health = await (await fetch(`${base}/v1/health`, { headers })).json()
console.log('daemon:', health.version, '| voices:', (health.voices ?? []).length)

const text = process.argv.slice(2).join(' ') || '你好，语音模式。'
const res = await fetch(`${base}/v1/audio/speech`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: text, response_format: 'wav' }),
})
if (!res.ok) {
  const body = await res.text()
  console.error('speech failed:', res.status, body)
  process.exit(1)
}
const bytes = new Uint8Array(await res.arrayBuffer())
console.log('wav bytes:', bytes.byteLength)
