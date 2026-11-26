#!/usr/bin/env node
// Voice Mode Daemon 流式转写示例（Node >= 22，使用内置 WebSocket 客户端）。
// 用法：VOICE_MODE_TOKEN=<token> node examples/ws-streaming.mjs <16kHz-mono-pcm16.wav>
import fs from 'node:fs'

const base = process.env.VOICE_MODE_BASE ?? 'http://127.0.0.1:18790'
const token = process.env.VOICE_MODE_TOKEN ?? ''
const wavPath = process.argv[2]
if (!token || !wavPath) {
  console.error('用法：VOICE_MODE_TOKEN=<token> node examples/ws-streaming.mjs <16kHz-mono-pcm16.wav>')
  process.exit(2)
}

// 简易 WAV 解析：只支持 PCM16。
const raw = fs.readFileSync(wavPath)
if (raw.toString('ascii', 0, 4) !== 'RIFF' || raw.toString('ascii', 8, 12) !== 'WAVE') {
  console.error('不是 WAV 文件')
  process.exit(2)
}
let offset = 12
let dataOffset = 0
let dataLength = 0
let sampleRate = 0
while (offset + 8 <= raw.length) {
  const id = raw.toString('ascii', offset, offset + 4)
  const size = raw.readUInt32LE(offset + 4)
  if (id === 'fmt ') {
    sampleRate = raw.readUInt32LE(offset + 8)
  } else if (id === 'data') {
    dataOffset = offset + 8
    dataLength = Math.min(size, raw.length - dataOffset)
    break
  }
  offset += 8 + size + (size % 2)
}
if (sampleRate !== 16_000 || dataLength === 0) {
  console.error(`需要 16kHz PCM16 WAV（当前 sampleRate=${sampleRate}）`)
  process.exit(2)
}

const wsBase = base.replace(/^http/, 'ws')
const ws = new WebSocket(`${wsBase}/v1/audio/transcriptions/stream?token=${encodeURIComponent(token)}`)
ws.binaryType = 'arraybuffer'

ws.onmessage = (event) => {
  const message = JSON.parse(String(event.data))
  if (message.type === 'partial') {
    process.stdout.write(`\rpartial: ${message.text}`)
  } else if (message.type === 'final') {
    process.stdout.write(`\rfinal:   ${message.text}\n`)
  } else if (message.type === 'error') {
    console.error('\nerror:', message.code, message.message)
  } else if (message.type === 'ready') {
    // 按 200ms（3200 样本 = 6400 字节）分块发送。
    const chunkBytes = 6_400
    for (let cursor = 0; cursor < dataLength; cursor += chunkBytes) {
      ws.send(raw.subarray(dataOffset + cursor, dataOffset + Math.min(cursor + chunkBytes, dataLength)))
    }
    ws.send(JSON.stringify({ type: 'stop' }))
  }
}
ws.onclose = () => process.exit(0)
ws.onerror = (event) => {
  console.error('WebSocket error:', event.message ?? event)
  process.exit(1)
}
