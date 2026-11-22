# Voice Mode Daemon

[简体中文](./README.zh-CN.md) | **English**

Native Node.js loopback speech acceleration daemon (`@voice-mode/daemon`) and Chrome / Edge Manifest V3 extension (`@voice-mode/browser-extension`) for the **Voice Mode** ecosystem.

## Highlights

- **Bypasses V8 Memory Cage & WASM Ceilings**: Runs `Kokoro v1.1` (`103` multilingual speakers, `24 kHz`), `Streaming Zipformer2` (`zh`/`en`), and `SenseVoice Small int8` (`zh`/`en`/`ja`/`ko`/`yue`) natively via `sherpa-onnx-node` outside Electron and browser tab sandboxes.
- **1 Disk Cache, 1 Shared RAM Instance**: Multiple simultaneous hosts (Obsidian `app://obsidian.md`, SillyTavern `http://127.0.0.1:*`, and Chrome/Edge MV3 Side Panel `chrome-extension://*`) share `~/.cache/voice-mode/models/` (with read-only discovery of `~/.cache/dsh-voice-mode/models/`) and a single resident ONNX graph per active model in RAM.
- **Hardened Loopback Security**: Strict `127.0.0.1:18790` bind, `Host` DNS-rebinding block, strict `Origin` allowlist (`403` on untrusted web origins), and `crypto.timingSafeEqual` 256-bit Bearer authentication (`~/.cache/voice-mode/daemon.token`, `0o600`).
- **Sub-Second Automatic Fallback (`< 1,000 ms`)**: If `voice-daemon` is stopped or credentials mismatch, connected clients fall back in under one second to browser `speechSynthesis` or optional BYOK OpenAI-compatible endpoints without stalling playback.
- **Web Store Ready MV3 Extension**: Zero `<all_urls>`, zero `*://*/*`, zero remote code or `eval()`, and zero undocumented WebSocket TTS endpoints. Reads selected Markdown/replies aloud (skipping fenced code blocks and pipe tables) and injects dictated text with custom vocabulary replacements directly into DeepSeek, Gemini, Kimi, and local web inputs.

## Requirements

- Node.js `>= 22.18.0`
- `pnpm` `12.x`

## Quick Start

```bash
pnpm install
pnpm run build

# Check shared local model cache status
node packages/voice-daemon/dist/cli.js models status

# Download missing SHA-256 verified model bundles (optional --mirror https://hf-mirror.com)
node packages/voice-daemon/dist/cli.js models download all

# Start loopback daemon on 127.0.0.1:18790
node packages/voice-daemon/dist/cli.js serve

# Locate your 0o600 Bearer token file (contents are never printed to logs)
node packages/voice-daemon/dist/cli.js token-path
```

## Loading the Chrome / Edge MV3 Extension

1. Run `pnpm run build`.
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, and click **Load unpacked**.
3. Select `packages/browser-extension/dist`.
4. Open the **Voice Mode** Side Panel, paste the token stored in `~/.cache/voice-mode/daemon.token`, and click **Save & Probe**.

## HTTP Wire Contract (`127.0.0.1:18790`)

- `GET /v1/health` — Returns `{ ok: true, service: "voice-daemon", version: "0.1.0", capabilities, modelsLoaded, voices }`.
- `POST /v1/audio/speech` — Accepts `{ input, voice, speed, response_format: "wav" }` (`zf_001`..`zm_100`, `af_heart`, `0..102`, `<whisper>` ×0.5 gain, `<break Nms>` silence) and returns `24 kHz` PCM16 RIFF WAV.
- `POST /v1/audio/transcriptions` — Accepts RFC 7578 `multipart/form-data` (`file` WAV + `model: "zipformer2" | "sensevoice"`) and returns `{ text, language, durationMs }`.

## Verification

```bash
pnpm run check:all
```

## License

MIT — see [`LICENSE`](./LICENSE). Model weights are fetched at runtime into the user's local cache under their respective upstream licenses (including runtime-only `espeak-ng-data` GPL-3.0 phoneme data, never bundled in this repository).
