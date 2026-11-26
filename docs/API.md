# Voice Mode Daemon · HTTP API 契约

> 版本：`0.1.0`（developer-only 可选后端，不随商店分发）。中文为主；本文件是 `packages/voice-daemon/src/server.ts` 的权威契约说明，改动路由/字段时必须同步更新。

## 1. 基本信息

- 基址：`http://127.0.0.1:18790`（严格回环；只监听 `127.0.0.1`/`localhost`/`[::1]`）。
- 鉴权：所有 `/v1/*` 请求须带 `Authorization: Bearer <token>`；令牌由 `voice-daemon token-path` 打印的 `0o600` 文件提供，192-bit `sk-vmd-` 前缀。
- Host 校验：拒绝非回环 `Host`（防 DNS rebinding）；`Origin` 白名单：`app://obsidian.md`、`chrome-extension://*`、`moz-extension://*`、`http://127.0.0.1:*`、`http://localhost:*`。
- CORS：白名单 Origin 回显、`OPTIONS` 预检放行；无凭据跨域被拒。
- 错误体统一为：`{ "error": { "message": string, "type": string, "code": string } }`（`type` 见各端点）。

## 2. 端点

### GET /v1/health

```json
{
  "ok": true,
  "service": "voice-daemon",
  "version": "0.1.0",
  "capabilities": ["tts:kokoro-103", "asr:zipformer2", "asr:sensevoice"],
  "modelsLoaded": ["kokoro-int8"],
  "modelInstanceCount": 1,
  "pid": 12345,
  "rssBytes": 268435456,
  "voices": ["zf_xiaobei", "zf_xiaoni", "..."]
}
```

`modelInstanceCount`/`pid`/`rssBytes` 供宿主做诊断与资源展示（进程 RSS 是当前常驻内存）。

### GET /v1/models

返回可按需加载的模型清单与能力：

```json
{ "ok": true, "engines": [
  { "id": "kokoro-int8", "capabilities": ["tts"], "voices": ["zf_xiaobei", "..."] },
  { "id": "zipformer2", "capabilities": ["asr"] },
  { "id": "sensevoice-int8", "capabilities": ["asr"] }
] }
```

`voices` 仅 TTS 引擎返回（103 个 Kokoro 音色）。

### GET /v1/models/status

磁盘缓存状态（是否已下载/可加载），用于首次使用前的提示。

### GET /v1/capabilities

表达力能力契约（E1）与解码能力（引擎分组结构）：

```json
{ "ok": true, "service": "voice-daemon", "version": "0.1.0",
  "tts": { "engines": [
    { "id": "kokoro", "model": "kokoro-int8", "voices": ["zf_xiaobei", "..."],
      "responseFormats": ["wav", "pcm"],
      "expression": { "engine": "kokoro-daemon", "supported": ["voices", "rate", "pause", "whisper"], "maxPauseMs": 5000 } }
  ] },
  "asr": { "engines": [
    { "id": "zipformer2", "responseFormats": ["json", "text"] },
    { "id": "sensevoice", "responseFormats": ["json", "text"] }
  ] },
  "limits": { "maxTtsInputChars": 4000, "maxAsrAudioBytes": 268435456 } }
```

`tts.engines[].expression` 是 `@voice-mode/core` 的 E1 能力契约原样透出（字段以 core 的 `ExpressionCaps` 为准）。

### POST /v1/audio/speech

请求（`Content-Type: application/json`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `input` | string | 是 | 待合成文本（trim 后非空；长度上限见 `MAX_TTS_INPUT_CHARS`） |
| `voice` | string | 否 | Kokoro 说话人（`zf_xiaobei` 等，103 个；缺省用默认音色） |
| `speed` | number | 否 | 语速倍率 |
| `response_format` | `"wav"` \| `"pcm"` | 否 | 默认 `wav`（24 kHz PCM16）；`pcm` 为无头部裸 16-bit LE 样本 |

响应：`200` + `audio/wav`（RIFF，24 kHz）或 `audio/pcm`（`audio/pcm` MIME）。
错误码（`code`）：`malformed_json`、`missing_input`、`input_too_long`（413）、`unsupported_response_format`、`tts_unavailable`（模型缺失/加载失败）。

### POST /v1/audio/transcriptions

请求（`Content-Type: multipart/form-data`）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | binary | 是 | WAV（PCM16）音频 |
| `model` | string | 否 | `zipformer2`（流式模型）或 `sensevoice`（定稿重译）；缺省自动选择 |
| `language` | string | 否 | 识别语言提示（如 `zh`、`en`；模型支持范围内） |

响应：

```json
{ "text": "识别结果", "language": "zh", "durationMs": 1234 }
```

错误码：`missing_file`、`unsupported_audio`、`asr_unavailable`、`model_not_found`。

### WS /v1/audio/transcriptions/stream

WebSocket 流式转写（P1-5，增量 partial + 结束 final）。需 zipformer2 模型已安装。

- 连接：`ws://127.0.0.1:18790/v1/audio/transcriptions/stream?token=<token>`
  - 浏览器 WebSocket 无法自定义头，故支持 `?token=`；同样执行回环 Host/Origin 校验
- 客户端 → 服务端：
  - binary 帧：mono **PCM16 LE @ 16 kHz**（建议每帧 100–500 ms）
  - text 帧：`{"type":"stop"}` → 返回 final 并关闭
- 服务端 → 客户端（JSON 文本帧）：
  - `{"ok":true,"type":"ready","sampleRate":16000,"format":"pcm16le"}`
  - `{"ok":true,"type":"partial","text":"…"}`（文本变化时推送）
  - `{"ok":true,"type":"final","text":"…","language":"zh"}`
  - `{"ok":false,"type":"error","code":"asr_unavailable|decode_failed|finalize_failed|malformed_control","message":"…"}`
- 空闲 60 秒自动关闭；每个连接独立识别流。

```js
const ws = new WebSocket(`ws://127.0.0.1:18790/v1/audio/transcriptions/stream?token=${token}`);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => { ws.send(pcm16Chunk); ws.send(JSON.stringify({ type: 'stop' })); };
```

完整示例见 [`examples/ws-streaming.mjs`](../examples/ws-streaming.mjs)。

## 3. 示例

```bash
# 健康检查
curl -s http://127.0.0.1:18790/v1/health -H "Authorization: Bearer $VOICE_MODE_TOKEN"

# 合成 WAV（保存到文件）
curl -s -o reply.wav http://127.0.0.1:18790/v1/audio/speech \
  -H "Authorization: Bearer $VOICE_MODE_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"你好，语音模式。","voice":"zf_xiaobei","response_format":"wav"}'

# 识别 WAV
curl -s http://127.0.0.1:18790/v1/audio/transcriptions \
  -H "Authorization: Bearer $VOICE_MODE_TOKEN" \
  -F "file=@clip.wav" -F "model=sensevoice"
```

Node 无依赖示例见 [`examples/node-client.mjs`](../examples/node-client.mjs)。

## 4. 兼容性承诺

- `0.1.x` 内：URL、必填字段、响应主字段（`ok`/`text`/`audio`）稳定；新增字段只增不删。
- 破坏性变更：升 major（`0.2.0`）并在 CHANGELOG 说明。
- 本服务是 **developer-only 可选后端**，不承诺 SLA；请勿暴露到公网（仅回环监听 + 回环 Host 校验）。

## 5. MCP 工具集（P1-5 / P2-5）

`voice-daemon-mcp` 以 **stdio MCP server** 形式把 daemon 能力暴露给 MCP 宿主（dsh / Claude 等）：

```bash
# 需要 daemon 已运行；令牌默认从 token-path 读取，也可用 VOICE_MODE_TOKEN 覆盖
node packages/voice-daemon/dist/mcp-server.js
```

| 工具 | 说明 | 返回 |
| --- | --- | --- |
| `voice_health` | 查询 daemon 状态（版本/音色/健康） | JSON 文本 |
| `voice_speak` | 文本 → 24kHz WAV 语音 | `text` + `audio/wav` 内容 |
| `voice_transcribe` | 本地 16kHz PCM16 WAV → 文本（zipformer2/sensevoice） | JSON 文本 |

环境变量：`VOICE_MODE_BASE`（默认 `http://127.0.0.1:18790`）、`VOICE_MODE_TOKEN` / `VOICE_MODE_TOKEN_PATH`。

MCP 宿主配置示例（dsh / Claude Desktop 的 stdio server 配置）：

```json
{ "mcpServers": { "voice-mode": { "command": "node", "args": ["/path/to/voice-daemon/packages/voice-daemon/dist/mcp-server.js"] } } }
```
