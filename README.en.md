# Voice Mode Daemon

[简体中文](./README.md) | **English**

Native Node.js loopback speech acceleration daemon (`@voice-mode/daemon`) and Chrome / Edge Manifest V3 extension (`@voice-mode/browser-extension`) for the **Voice Mode** ecosystem.

> **Positioning: developer-only optional backend.** This repository is the power-user / developer option, not a store product: it ships no installer, is not submitted to the Chrome/Edge stores, and expects you to run it from source (Node.js `>= 22.18.0`, pnpm `12.21.0`, `pnpm run build`, `voice-daemon models download`). `obsidian-voice-mode` and `sillytavern-voice-mode` use it as an optional `kokoro-daemon` backend for better local voices and recognition; both plugins keep working without it.

## Highlights

- **Bypasses V8 Memory Cage & WASM Ceilings**: Runs `Kokoro v1.1` (`103` multilingual speakers, `24 kHz`), `Streaming Zipformer2` (`zh`/`en`), and `SenseVoice Small int8` (`zh`/`en`/`ja`/`ko`/`yue`) natively via `sherpa-onnx-node` outside Electron and browser tab sandboxes.
- **1 Disk Cache, 1 Shared RAM Instance**: Multiple simultaneous hosts (Obsidian `app://obsidian.md`, SillyTavern `http://127.0.0.1:*`, and Chrome/Edge MV3 Side Panel `chrome-extension://*`) share `~/.cache/voice-mode/models/` (with read-only discovery of `~/.cache/dsh-voice-mode/models/`) and a single resident ONNX graph per active model in RAM.
- **Loopback security.** Defaults to `127.0.0.1:18790`, verifies `Host` and `Origin`, and compares the `sk-vmd-` Bearer token in constant time. The default token file is `~/.cache/voice-mode/daemon.token`, with `0600` permissions on macOS and Linux.
- **Automatic fallback.** The extension uses a 500 ms health probe timeout, then can use the browser's speech APIs or a configured OpenAI-compatible service. Response time depends on the browser or provider. Browser speech recognition is available for new dictation sessions when the daemon is unreachable and the browser supports it.
- **MV3 Side Panel.** Reads selected text or replies aloud and skips fenced code blocks and pipe tables in Markdown. With chat site access granted, the extension can insert dictated text into DeepSeek, Gemini, and Kimi inputs. It can also work with local web inputs.

## Requirements

- Node.js `>= 22.18.0`
- pnpm `12.21.0` (see `package.json`)

## Quick Start

```bash
pnpm install --frozen-lockfile
pnpm run build

# Check shared local model cache status
node packages/voice-daemon/dist/cli.js models status

# Download missing SHA-256 verified model bundles (optional --mirror https://hf-mirror.com)
node packages/voice-daemon/dist/cli.js models download all
# Preview/clean the local model cache (primary cache dir only; --yes deletes)
node packages/voice-daemon/dist/cli.js models clean

# Start the daemon on 127.0.0.1:18790 and leave this terminal running
node packages/voice-daemon/dist/cli.js serve
```

In a second terminal, print the path to your token file.

```bash
node packages/voice-daemon/dist/cli.js token-path
```

## Loading the Chrome / Edge MV3 Extension

1. Run `pnpm run build`.
2. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, and click **Load unpacked**.
3. Select `packages/browser-extension/dist`.
4. Open the **Voice Mode** Side Panel, paste the token stored in `~/.cache/voice-mode/daemon.token`, and click **Save & Probe**.

The Side Panel follows the browser UI language. English is the default, and Simplified Chinese is available.

## HTTP Wire Contract (`127.0.0.1:18790`)

Authenticate each endpoint with `Authorization: Bearer <token>`.

- `GET /v1/health` — Returns `{ ok: true, service: "voice-daemon", version: "0.1.0", capabilities, modelsLoaded, voices }`.
- `GET /v1/models/status` — Reports which model bundles are available in the disk cache.
- `POST /v1/audio/speech` — Accepts `{ input, voice, speed, response_format: "wav" }` (`af_maple`, `af_sol`, `bf_vale`, `zf_001`..`zm_100`, `zf_xiaobei`, `0..102`, `<whisper>` ×0.5 gain, `<break Nms>` silence) and returns `24 kHz` PCM16 RIFF WAV.
- `POST /v1/audio/transcriptions` — Accepts RFC 7578 `multipart/form-data` (`file` WAV + `model: "zipformer2" | "sensevoice"`) and returns `{ text, language, durationMs }`.

## Verification

```bash
pnpm run check:all
```

See the [architecture map](./CONTEXT.md), [coding standards](./CODING_STANDARDS.md), [glossary](./GLOSSARY.md), and [security policy](./SECURITY.md).

## License

MIT — see [`LICENSE`](./LICENSE). Model weights are fetched at runtime into the user's local cache under their respective upstream licenses (including runtime-only `espeak-ng-data` GPL-3.0 phoneme data, never bundled in this repository).
