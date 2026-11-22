import type { CloudDictationSession } from '@voice-mode/browser';
import {
  DEFAULT_DAEMON_BASE_URL,
  KOKORO_SPEAKERS_103,
  redactSecrets,
  type AsrReplacement,
  type DaemonHealthResult,
} from '@voice-mode/core';
import {
  VoiceExtensionCoordinator,
  buildKokoroVoiceSelectOptions,
} from './coordinator.js';

interface StoredSettings {
  daemonBaseUrl?: string;
  daemonToken?: string;
  voice?: string;
  asrModel?: 'zipformer2' | 'sensevoice';
  byokBaseUrl?: string;
  byokApiKey?: string;
  byokTtsModel?: string;
  byokAsrModel?: string;
  replacements?: AsrReplacement[];
}

const OPTIONAL_CHAT_ORIGINS = [
  'https://chat.deepseek.com/*',
  'https://gemini.google.com/*',
  'https://kimi.moonshot.cn/*',
  'https://www.kimi.com/*',
];

const badgeEl = document.getElementById('daemon-badge') as HTMLElement;
const urlInput = document.getElementById('daemon-url') as HTMLInputElement;
const tokenInput = document.getElementById('daemon-token') as HTMLInputElement;
const voiceSelect = document.getElementById('voice-select') as HTMLSelectElement;
const asrSelect = document.getElementById('asr-model-select') as HTMLSelectElement;
const byokBaseInput = document.getElementById('byok-base-url') as HTMLInputElement;
const byokKeyInput = document.getElementById('byok-api-key') as HTMLInputElement;
const byokTtsModelInput = document.getElementById('byok-tts-model') as HTMLInputElement;
const byokAsrModelInput = document.getElementById('byok-asr-model') as HTMLInputElement;
const readInput = document.getElementById('read-input') as HTMLTextAreaElement;
const dictationPreview = document.getElementById('dictation-preview') as HTMLTextAreaElement;
const statusLog = document.getElementById('status-log') as HTMLElement;
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;

let currentReplacements: AsrReplacement[] = [
  { from: ['deep seek'], to: 'DeepSeek' },
  { from: ['kimi chat'], to: 'Kimi' },
];
let dictationSession: CloudDictationSession | null = null;
let webSpeechHandle: { stop(): void } | null = null;
let daemonHealthy = false;

function setStatus(message: string): void {
  statusLog.textContent = redactSecrets(message);
}

function setBadge(state: 'checking' | 'ready' | 'fallback', text: string): void {
  badgeEl.dataset.state = state;
  badgeEl.textContent = text;
}

function populateVoiceDropdown(voices: readonly string[], preferredVoice?: string): void {
  const previous = preferredVoice ?? voiceSelect.value ?? 'zf_001';
  const options = buildKokoroVoiceSelectOptions(voices);
  voiceSelect.replaceChildren();
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    voiceSelect.appendChild(el);
  }
  if (options.some((o) => o.value === previous)) {
    voiceSelect.value = previous;
  } else if (options[0]) {
    voiceSelect.value = options[0].value;
  }
}

populateVoiceDropdown(KOKORO_SPEAKERS_103, 'zf_001');

const coordinator = new VoiceExtensionCoordinator({
  daemonBaseUrl: DEFAULT_DAEMON_BASE_URL,
  replacements: currentReplacements,
  onFallback: (surface, reason) => {
    daemonHealthy = false;
    setBadge('fallback', 'Fallback (<1s)');
    setStatus(`Fallback (${surface}): ${reason}`);
  },
  onError: (msg) => setStatus(`Error: ${msg}`),
});

async function loadSettingsAndProbe(): Promise<DaemonHealthResult> {
  const stored = (await chrome.storage.local.get([
    'daemonBaseUrl',
    'daemonToken',
    'voice',
    'asrModel',
    'byokBaseUrl',
    'byokApiKey',
    'byokTtsModel',
    'byokAsrModel',
    'replacements',
  ])) as StoredSettings;

  urlInput.value = stored.daemonBaseUrl ?? DEFAULT_DAEMON_BASE_URL;
  tokenInput.value = stored.daemonToken ?? '';
  byokBaseInput.value = stored.byokBaseUrl ?? '';
  byokKeyInput.value = stored.byokApiKey ?? '';
  byokTtsModelInput.value = stored.byokTtsModel ?? 'gpt-4o-mini-tts';
  byokAsrModelInput.value = stored.byokAsrModel ?? 'whisper-1';
  if (stored.asrModel) asrSelect.value = stored.asrModel;
  if (Array.isArray(stored.replacements)) {
    currentReplacements = stored.replacements;
  }

  const byokBase = byokBaseInput.value.trim();
  const byokKey = byokKeyInput.value.trim();
  const hasByok = byokBase.length > 0 && byokKey.length > 0;

  await coordinator.reconfigure({
    daemonBaseUrl: urlInput.value.trim() || DEFAULT_DAEMON_BASE_URL,
    ...(tokenInput.value.trim() ? { daemonToken: tokenInput.value.trim() } : {}),
    voice: stored.voice ?? voiceSelect.value ?? 'zf_001',
    asrModel: (asrSelect.value as 'zipformer2' | 'sensevoice') || 'zipformer2',
    replacements: currentReplacements,
    ...(hasByok
      ? {
          byokTts: {
            baseUrl: byokBase,
            apiKey: byokKey,
            model: byokTtsModelInput.value.trim() || 'gpt-4o-mini-tts',
          },
          byokAsr: {
            baseUrl: byokBase,
            apiKey: byokKey,
            model: byokAsrModelInput.value.trim() || 'whisper-1',
          },
        }
      : {}),
    onFallback: (surface, reason) => {
      daemonHealthy = false;
      setBadge('fallback', 'Fallback (<1s)');
      setStatus(`Fallback (${surface}): ${reason}`);
    },
    onError: (msg) => setStatus(`Error: ${msg}`),
  });

  const health = await coordinator.probeHealth();
  daemonHealthy = health.ok;
  if (health.ok) {
    populateVoiceDropdown(health.voices, stored.voice ?? voiceSelect.value);
    setBadge('ready', `Daemon v${health.version} (${health.voices.length} voices)`);
    setStatus('Connected to local voice-daemon.');
  } else {
    populateVoiceDropdown(KOKORO_SPEAKERS_103, stored.voice ?? voiceSelect.value);
    setBadge('fallback', hasByok ? 'BYOK Cloud Fallback (<1s)' : 'Browser Fallback (<1s)');
    setStatus(`Daemon unavailable (${health.error ?? 'offline'}); using <1s fallback.`);
  }
  return health;
}

async function saveCurrentSettings(): Promise<DaemonHealthResult> {
  await chrome.storage.local.set({
    daemonBaseUrl: urlInput.value.trim() || DEFAULT_DAEMON_BASE_URL,
    daemonToken: tokenInput.value.trim(),
    voice: voiceSelect.value,
    asrModel: asrSelect.value,
    byokBaseUrl: byokBaseInput.value.trim(),
    byokApiKey: byokKeyInput.value.trim(),
    byokTtsModel: byokTtsModelInput.value.trim() || 'gpt-4o-mini-tts',
    byokAsrModel: byokAsrModelInput.value.trim() || 'whisper-1',
    replacements: currentReplacements,
  });
  return loadSettingsAndProbe();
}

document.getElementById('save-btn')?.addEventListener('click', () => {
  void saveCurrentSettings();
});

voiceSelect?.addEventListener('change', () => {
  void saveCurrentSettings();
});

document.getElementById('grant-site-btn')?.addEventListener('click', () => {
  void (async () => {
    const granted = await chrome.permissions.request({
      permissions: ['scripting'],
      origins: OPTIONAL_CHAT_ORIGINS,
    });
    setStatus(
      granted
        ? 'Granted on-demand access for DeepSeek, Gemini, and Kimi.'
        : 'Site access request was declined.',
    );
  })();
});

document.getElementById('read-page-btn')?.addEventListener('click', () => {
  void (async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'VM_READ_ACTIVE_TAB' })) as
      | { ok?: boolean; text?: string; error?: string }
      | undefined;
    if (!reply?.ok || !reply.text) {
      setStatus(reply?.error ?? 'No selected text or assistant reply found on active tab.');
      return;
    }
    readInput.value = reply.text;
    const sentences = await coordinator.readMarkdownAloud(reply.text);
    setStatus(`Reading ${sentences.length} sentence(s)...`);
  })();
});

document.getElementById('speak-text-btn')?.addEventListener('click', () => {
  void (async () => {
    const text = readInput.value.trim();
    if (!text) return;
    const sentences = await coordinator.readMarkdownAloud(text);
    setStatus(`Speaking ${sentences.length} sentence(s)...`);
  })();
});

document.getElementById('stop-btn')?.addEventListener('click', () => {
  coordinator.stopPlayback();
  setStatus('Playback stopped.');
});

micBtn?.addEventListener('click', () => {
  void (async () => {
    if (webSpeechHandle) {
      webSpeechHandle.stop();
      webSpeechHandle = null;
      micBtn.textContent = 'Start Mic';
      return;
    }
    if (dictationSession && dictationSession.state !== 'idle') {
      await dictationSession.stop();
      micBtn.textContent = 'Start Mic';
      return;
    }

    if (!daemonHealthy && !coordinator.hasConfiguredByokAsr()) {
      try {
        webSpeechHandle = coordinator.startWebSpeechFallbackDictation({
          replacements: currentReplacements,
          onStateChange: (active) => {
            micBtn.textContent = active ? 'Stop Mic' : 'Start Mic';
            if (!active) webSpeechHandle = null;
            setStatus(active ? 'Listening via browser SpeechRecognition fallback...' : 'Mic idle.');
          },
          onFinalTranscript: (text) => {
            dictationPreview.value = text;
            void chrome.runtime.sendMessage({
              type: 'VM_INJECT_ACTIVE_TAB',
              text,
              replacements: currentReplacements,
            });
          },
          onError: (err) => setStatus(err.message),
        });
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
      return;
    }

    dictationSession = coordinator.createDictationSession({
      onStateChange: (st) => {
        micBtn.textContent = st === 'idle' ? 'Start Mic' : 'Stop Mic';
        setStatus(`Mic state: ${st}`);
      },
      onFinalTranscript: (text) => {
        dictationPreview.value = text;
        void chrome.runtime.sendMessage({
          type: 'VM_INJECT_ACTIVE_TAB',
          text,
          replacements: currentReplacements,
        });
      },
      onError: (err) => setStatus(`Mic error: ${err.message}`),
    });
    await dictationSession.start('toggle');
  })();
});

document.getElementById('inject-btn')?.addEventListener('click', () => {
  void (async () => {
    const text = dictationPreview.value.trim();
    if (!text) return;
    const reply = (await chrome.runtime.sendMessage({
      type: 'VM_INJECT_ACTIVE_TAB',
      text,
      replacements: currentReplacements,
    })) as { ok?: boolean; error?: string } | undefined;
    setStatus(reply?.ok ? 'Injected into focused input.' : (reply?.error ?? 'No focused input.'));
  })();
});

void loadSettingsAndProbe();
