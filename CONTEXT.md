# Context Map (`voice-mode-daemon` `0.1.0`)

Monorepo housing the native Node.js loopback speech daemon (`@voice-mode/daemon`) and the Chrome/Edge Manifest V3 companion extension (`@voice-mode/browser-extension`). Built to bypass Electron V8 Memory Cage and browser WASM ceilings while sharing **1 disk cache + 1 resident RAM instance** across Obsidian, SillyTavern, and browser tabs.

## Workspace Layout

- `vendor/` — Pinned tarballs `@voice-mode/core@0.1.0` and `@voice-mode/browser@0.1.0` (shared wire contracts, `DaemonClient`, `SentenceSegmenter`, `compileEmotionPlan`, `createAsrReplacer`, `PlaybackQueue`, `CloudDictationSession`, `FocusTextInjector`).
- `packages/voice-daemon/` — `@voice-mode/daemon@0.1.0` (`voice-daemon` CLI & loopback HTTP server on `127.0.0.1:18790` backed by `sherpa-onnx-node@1.13.6`).
  - `src/security.ts` — Loopback `Host` guard, `Origin` allowlist, `0o600` token store, `timingSafeEqual` Bearer check.
  - `src/model-cache.ts` — SHA-256 verified downloader for `~/.cache/voice-mode/models/` with read-only fallback discovery of `~/.cache/dsh-voice-mode/models/` and runtime-only GPL-3.0 `espeak-ng-data` notice.
  - `src/engine-registry.ts` — Lazy deduplicated single-instance `Kokoro 103` (`24 kHz`), `Streaming Zipformer2`, and `SenseVoice int8` registry with `<whisper>` ×0.5 gain and `<break Nms>` silence synthesis.
  - `src/server.ts` & `src/cli.ts` — `/v1/health`, `/v1/models/status`, `/v1/audio/speech`, `/v1/audio/transcriptions`.
- `packages/browser-extension/` — `@voice-mode/browser-extension@0.1.0` (Chrome/Edge MV3).
  - `manifest.json` — Strict least-privilege MV3 (`activeTab`, `sidePanel`, `storage`; zero `<all_urls>`; optional host permissions for DeepSeek, Gemini, Kimi).
  - `src/coordinator.ts` — Deep module wiring `DaemonClient` (`< 1s` fallback to browser `speechSynthesis` or optional BYOK), `SentenceSegmenter`, `PlaybackQueue`, `CloudDictationSession`, and `FocusTextInjector`.
  - `src/sw-router.ts`, `src/sw.ts`, `src/sidepanel.ts`, `src/content.ts` — Sender-verified Service Worker, dynamic 103-voice Side Panel UI with BYOK/WebSpeech fallback, and idempotent on-demand Content Script.
- `scripts/check-release-gate.mjs` — Enforces `0.1.0` versions, MIT license, `CONTEXT.md <= 110` lines, zero weights/GPL in workspace, and MV3 Web Store compliance.

## Context Pointers

- Naming a type, option, or test → read [`GLOSSARY.md`](./GLOSSARY.md) for canonical domain terms.
- Designing interfaces, seams, or reviewing code → read [`CODING_STANDARDS.md`](./CODING_STANDARDS.md).
- Touching HTTP headers, CORS, Bearer tokens, model downloads, or MV3 permissions → read [`SECURITY.md`](./SECURITY.md).
- Verifying build, types, lint, unit tests, and MV3 store gates → run `pnpm run check:all`.
