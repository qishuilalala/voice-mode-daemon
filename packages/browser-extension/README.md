# @voice-mode/browser-extension

Least-privilege Chrome / Edge Manifest V3 extension for Voice Mode: speaks Markdown-aware
read-aloud with streaming sentence playback, optional `<whisper>` / `<break>` emotion prosody via a
local [Voice Mode Daemon](https://github.com/qishuilalala/voice-mode-daemon), plus dictation into
the active page input.

> **Developer-only.** No Chrome Web Store / Edge Add-ons listing; load the built extension
> unpacked (or via `pwsh`/scripted profiles). The daemon is an optional backend — the extension
> falls back to browser `speechSynthesis` / optional BYOK.

## Permissions

`activeTab`, `sidePanel`, `storage` only. Zero `<all_urls>`, zero `*://*/*`, zero remote code,
zero undocumented WebSocket TTS.

## Build & load

```bash
pnpm install --frozen-lockfile
pnpm --filter @voice-mode/browser-extension run build   # or pnpm run build
```

Then load `packages/browser-extension/dist` as an unpacked extension in Chrome/Edge. See the
[repository README](https://github.com/qishuilalala/voice-mode-daemon#readme) for the joint
Obsidian + daemon E2E notes and security boundaries.
