#!/usr/bin/env bash
# Voice Mode Daemon 快速验证：健康检查 + 合成 + 识别。
set -euo pipefail
BASE="${VOICE_MODE_BASE:-http://127.0.0.1:18790}"
TOKEN="${VOICE_MODE_TOKEN:?缺少 VOICE_MODE_TOKEN（用 voice-daemon token-path 查看）}"

curl -fsS "$BASE/v1/health" -H "Authorization: Bearer $TOKEN"
echo
curl -fsS -o /tmp/voice-mode-sample.wav "$BASE/v1/audio/speech" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"你好，语音模式。","response_format":"wav"}'
ls -l /tmp/voice-mode-sample.wav
curl -fsS "$BASE/v1/audio/transcriptions" -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/voice-mode-sample.wav" -F "model=sensevoice"
echo
