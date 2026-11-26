# Changelog

All notable changes to `voice-mode-daemon` are documented in this file.

## [Unreleased]

- **OpenAI-compatible hardening**: `GET /v1/models`, `GET /v1/capabilities` (expression capability contract, `wav`/`pcm`, limits), structured error bodies `{ error: { message, type, code } }`, and `response_format=wav|pcm` on `POST /v1/audio/speech` (PCM returns headerless 16-bit LE samples).
- **Expression capability contract (E1)** and **scoped expression tags (E2)** are now available from the synchronized shared core (`<slow>`, `<fast>`, `<spell>`, `<volume>`, `<pitch>`, `<emotion:NAME>`).
- **Zero-telemetry statement**: SECURITY.md now states explicitly that the daemon collects no telemetry and makes no network requests at startup.
- Added Simplified Chinese to the MV3 Side Panel and toolbar, alongside the default English locale.
- Documented local setup, connection troubleshooting, and fallback behavior in the Chinese README.

## [0.1.0] - 2026-11-22

### Added

- **`@voice-mode/daemon` (`0.1.0`)**:
  - Native Node.js (`>= 22.18.0`) loopback speech daemon bound strictly to `127.0.0.1` (default port `18790`).
  - Anti-DNS-rebinding `Host` verification, strict `Origin` allowlist (`app://obsidian.md`, `chrome-extension://*`, `moz-extension://*`, `http://127.0.0.1:*`, `http://localhost:*`), and `crypto.timingSafeEqual` 192-bit `sk-vmd-` Bearer authentication (`~/.cache/voice-mode/daemon.token` `0o600`).
  - Shared local model cache (`~/.cache/voice-mode/models/` with read-only fallback discovery of `~/.cache/dsh-voice-mode/models/`) and SHA-256 verified CLI downloader (`voice-daemon models status|download`) with runtime-only `espeak-ng-data` GPL-3.0 isolation notice.
  - Lazy deduplicated single-instance model registry serving `Kokoro v1.1` (`103` multilingual speakers, `<whisper>` ×0.5 PCM gain, `<break Nms>` silence, `24 kHz` RIFF WAV) on `POST /v1/audio/speech` and dual-channel `Streaming Zipformer2` / `SenseVoice int8` transcription on `POST /v1/audio/transcriptions`.
- **`@voice-mode/browser-extension` (`0.1.0`)**:
  - Least-privilege Chrome / Edge Manifest V3 extension (`activeTab`, `sidePanel`, `storage`; zero `<all_urls>`, zero `*://*/*`, zero remote code, zero undocumented WebSocket TTS).
  - Side Panel, Service Worker, and on-demand Content Script integrating `@voice-mode/core` + `@voice-mode/browser` with `< 1,000 ms` automatic fallback to browser `speechSynthesis` / optional BYOK, Markdown table & code-fence skipping via `SentenceSegmenter`, vocabulary replacement via `createAsrReplacer`, and active input injection via `FocusTextInjector`.
