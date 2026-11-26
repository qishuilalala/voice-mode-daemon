# @voice-mode/daemon

Local loopback speech acceleration daemon for the Voice Mode family: native `sherpa-onnx-node`
unlocks offline Kokoro TTS (103 voices) and dual-channel streaming ASR (Zipformer2 + SenseVoice)
for [obsidian-voice-mode](https://github.com/qishuilalala/obsidian-voice-mode),
[sillytavern-voice-mode](https://github.com/qishuilalala/sillytavern-voice-mode) and
[Chrome/Edge MV3 clients](https://github.com/qishuilalala/voice-mode-daemon).

> **Developer-only optional backend.** No installer, no store distribution. Run it from source
> with Node.js `>= 22.18.0`. The host plugins keep working without it (system speech / WASM / BYOK).

## Run

```bash
# from the repository root (build first)
pnpm install --frozen-lockfile
pnpm run build
node packages/voice-daemon/dist/cli.js serve        # 127.0.0.1:18790
```

The daemon binds strictly to loopback, verifies `Host`/`Origin`, and requires the 192-bit
`sk-vmd-` Bearer token from `~/.cache/voice-mode/daemon.token` (`0o600`).

## CLI

```bash
node packages/voice-daemon/dist/cli.js models status
node packages/voice-daemon/dist/cli.js models download all
node packages/voice-daemon/dist/cli.js models clean            # preview; add --yes to delete
node packages/voice-daemon/dist/cli.js token-path
```

## API

- `POST /v1/audio/speech` — `{ input, voice, response_format: "wav" | "pcm" }`
- `POST /v1/audio/transcriptions` — multipart audio, optional `language`
- `GET /v1/models`, `GET /v1/capabilities`, `GET /v1/health`

Errors use `{ error: { message, type, code } }`. See the
[repository README](https://github.com/qishuilalala/voice-mode-daemon#readme) for full setup,
model downloads, licenses and security notes.
