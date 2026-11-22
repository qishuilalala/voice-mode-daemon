# Security Policy

## Threat Model & Loopback Hardening

`voice-daemon` runs exclusively on the user's local loopback interface (`127.0.0.1`, default port `18790`). Because untrusted web pages visited in a local browser can attempt cross-origin requests or DNS-rebinding attacks against `127.0.0.1`, every request passes four sequential fail-closed checks before body parsing:

1. **Loopback Interface Bind**: `startVoiceDaemonServer` refuses non-loopback bind addresses.
2. **Anti-DNS-Rebinding (`Host` Check)**: `Host` must match `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`. Rebound domains receive `403 Forbidden`.
3. **Anti-CSRF (`Origin` Allowlist)**:
   - Present `Origin` headers must match `app://obsidian.md`, `chrome-extension://<id>`, `moz-extension://<id>`, or `http://127.0.0.1:*` / `http://localhost:*` / `http://[::1]:*`.
   - Untrusted origins (such as `https://evil.example` or `Origin: null`) receive `403 Forbidden` regardless of credentials, and CORS responses echo only the verified origin (`Vary: Origin`, never `*`).
   - Absent `Origin` headers are permitted **only** when a valid `Authorization: Bearer <token>` is supplied (including on `OPTIONS` requests).
4. **Constant-Time Bearer Authentication**:
   - First run generates an `sk-vmd-` prefixed random hex token at `~/.cache/voice-mode/daemon.token` with `0o600` permissions (rotating unprefixed legacy tokens and tightening existing permissive modes on startup so `@voice-mode/core` `redactSecrets` automatically scrubs any accidental log output).
   - Incoming tokens are hashed with SHA-256 and compared via `crypto.timingSafeEqual` so neither character prefixes nor token lengths leak via response timing.

## Model Integrity & License Isolation

- Model bundles (`kokoro-int8`, `zipformer2`, `sensevoice-int8`) pin immutable 40-hex commit SHAs and are verified via hop-by-hop redirect allowlisting, stream byte caps, and SHA-256 digests before atomic installation into `~/.cache/voice-mode/models/`.
- Zero model weights and zero GPL-3.0 `espeak-ng-data` files are committed to Git or shipped in packages; `espeak-ng-data` is fetched, SHA-256 verified, and safely extracted solely into the user's local cache at runtime.

## Chrome / Edge Manifest V3 Least Privilege

- Zero `<all_urls>` and zero `*://*/*` host wildcards.
- Privileged Service Worker message routing rejects content-script (`sender.tab`) and cross-extension callers (`sender.id !== chrome.runtime.id`).
- Zero `eval()`, `new Function()`, remote scripts, or undocumented third-party WebSocket TTS endpoints; verified on every build by `scripts/check-release-gate.mjs`.

## Reporting a Vulnerability

Report security issues privately via GitHub Security Advisories on `qishuilalala/voice-mode-daemon` rather than public issues. Include reproduction steps and redact any personal tokens.
