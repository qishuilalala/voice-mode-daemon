# Coding Standards

Subjective engineering judgements for `voice-mode-daemon` (compiler, linter, and `scripts/check-release-gate.mjs` enforce mechanical rules).

## Module Depth & Seams

- **Deep modules over pass-throughs**: Hide protocol framing, model lifecycle, emotion prosody planning, and fallback timing behind narrow interfaces (`SpeechEngineRegistry`, `VoiceExtensionCoordinator`). Delete any wrapper whose removal leaves callers no more complex.
- **Test at public seams**: Exercise behaviour through HTTP routes, `DaemonClient`, and public coordinator methods. Inject external collaborators (`NativeSpeechBackend`, `AudioSink`, `fetchImpl`) rather than mocking private helpers.
- **Domain language alignment**: Name types, options, and tests using the exact terms in [`GLOSSARY.md`](./GLOSSARY.md).
- **Side Panel messages**: Update `_locales/en/messages.json` and `_locales/zh_CN/messages.json` together, including placeholder names and positions. Translate visible labels while preserving stored settings, voice IDs, and message types.

## Standard Library & Minimalism

- **Node and Web platform primitives first**: Reach for `node:http`, `node:crypto`, `node:util` (`parseArgs`), `node:test`, `Uint8Array`, `DataView`, and Web Audio before adding dependencies.
- **Single resident model instance**: Load each `Model Bundle` lazily on first demand and deduplicate concurrent cold-start loads so multiple `Host`s share one copy on disk and one resident instance in RAM.

## Trust Boundaries & Hygiene

- **Fail closed on loopback**: Validate `Host`, `Origin`, and constant-time Bearer credentials before parsing request bodies. Never return `Access-Control-Allow-Origin: *`.
- **Zero secret leakage**: Redact credentials from every error message, status banner, and CLI log via `redactSecrets`; never print `daemon.token` contents to stdout or stderr.
- **License & artifact hygiene**: Keep model weights and GPL-3.0 `espeak-ng-data` strictly runtime-fetched inside the user cache; commit zero binary weights and zero AI attribution trailers.
