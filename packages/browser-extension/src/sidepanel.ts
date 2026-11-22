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
import { message } from './i18n.ts';

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
const language = message('documentLanguage') === 'zh-CN' ? 'zh-CN' : 'en';

document.documentElement.lang = language;
for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  element.textContent = message(element.dataset.i18n!);
}
for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]')) {
  element.placeholder = message(element.dataset.i18nPlaceholder!);
}

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

function run(action: () => Promise<unknown>): void {
  void action().catch((error: unknown) => {
    setStatus(message('actionError', [error instanceof Error ? error.message : String(error)]));
  });
}

function setBadge(state: 'checking' | 'ready' | 'fallback', text: string): void {
  badgeEl.dataset.state = state;
  badgeEl.textContent = text;
}

function populateVoiceDropdown(voices: readonly string[], preferredVoice?: string): void {
  const previous = preferredVoice ?? voiceSelect.value ?? 'zf_001';
  const options = buildKokoroVoiceSelectOptions(voices, language);
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
    setBadge('fallback', message('fallbackBadge'));
    setStatus(message('fallbackStatus', [message(`${surface}Surface`), reason]));
  },
  onError: (msg) => setStatus(message('actionError', [msg])),
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
  });

  const health = await coordinator.probeHealth();
  daemonHealthy = health.ok;
  if (health.ok) {
    populateVoiceDropdown(health.voices, stored.voice ?? voiceSelect.value);
    setBadge('ready', message('daemonReadyBadge', [health.version, String(health.voices.length)]));
    setStatus(message('daemonConnected'));
  } else {
    populateVoiceDropdown(KOKORO_SPEAKERS_103, stored.voice ?? voiceSelect.value);
    setBadge('fallback', message(hasByok ? 'cloudFallbackBadge' : 'browserFallbackBadge'));
    const errorKey = health.status === 401
      ? 'daemonUnauthorized'
      : health.status === 403 ? 'daemonForbidden' : 'daemonUnavailable';
    setStatus(message(errorKey));
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
  run(saveCurrentSettings);
});

voiceSelect?.addEventListener('change', () => {
  run(saveCurrentSettings);
});

document.getElementById('grant-site-btn')?.addEventListener('click', () => {
  run(async () => {
    const granted = await chrome.permissions.request({
      permissions: ['scripting'],
      origins: OPTIONAL_CHAT_ORIGINS,
    });
    setStatus(message(granted ? 'siteAccessGranted' : 'siteAccessDeclined'));
  });
});

document.getElementById('read-page-btn')?.addEventListener('click', () => {
  run(async () => {
    const reply = (await chrome.runtime.sendMessage({ type: 'VM_READ_ACTIVE_TAB' })) as
      | { ok?: boolean; text?: string; error?: string }
      | undefined;
    if (!reply?.ok || !reply.text) {
      setStatus(reply?.error ?? message('noReadableText'));
      return;
    }
    readInput.value = reply.text;
    const sentences = await coordinator.readMarkdownAloud(reply.text);
    setStatus(message('reading', [String(sentences.length)]));
  });
});

document.getElementById('speak-text-btn')?.addEventListener('click', () => {
  run(async () => {
    const text = readInput.value.trim();
    if (!text) return;
    const sentences = await coordinator.readMarkdownAloud(text);
    setStatus(message('speaking', [String(sentences.length)]));
  });
});

document.getElementById('stop-btn')?.addEventListener('click', () => {
  coordinator.stopPlayback();
  setStatus(message('playbackStopped'));
});

micBtn?.addEventListener('click', () => {
  run(async () => {
    if (webSpeechHandle) {
      webSpeechHandle.stop();
      webSpeechHandle = null;
      micBtn.textContent = message('startMicButton');
      return;
    }
    if (dictationSession && dictationSession.state !== 'idle') {
      await dictationSession.stop();
      micBtn.textContent = message('startMicButton');
      return;
    }

    if (!daemonHealthy && !coordinator.hasConfiguredByokAsr()) {
      let recognitionFailed = false;
      webSpeechHandle = coordinator.startWebSpeechFallbackDictation({
        replacements: currentReplacements,
        onStateChange: (active) => {
          micBtn.textContent = message(active ? 'stopMicButton' : 'startMicButton');
          if (!active) webSpeechHandle = null;
          if (!recognitionFailed) {
            setStatus(message(active ? 'browserListening' : 'micState_idle'));
          }
        },
        onFinalTranscript: previewAndInsertDictation,
        onError: (err) => {
          recognitionFailed = true;
          setStatus(err.message);
        },
      });
      return;
    }

    dictationSession = coordinator.createDictationSession({
      onStateChange: (st) => {
        micBtn.textContent = message(st === 'idle' ? 'startMicButton' : 'stopMicButton');
        setStatus(message(`micState_${st}`));
      },
      onFinalTranscript: previewAndInsertDictation,
      onError: (err) => setStatus(message('micError', [err.message])),
    });
    await dictationSession.start('toggle');
  });
});

async function insertIntoActiveTab(text: string): Promise<{ ok?: boolean; error?: string } | undefined> {
  return (await chrome.runtime.sendMessage({
    type: 'VM_INJECT_ACTIVE_TAB',
    text,
    replacements: currentReplacements,
  })) as { ok?: boolean; error?: string } | undefined;
}

function previewAndInsertDictation(text: string): void {
  dictationPreview.value = text;
  run(async () => {
    const reply = await insertIntoActiveTab(text);
    if (!reply?.ok) setStatus(reply?.error ?? message('noFocusedInput'));
  });
}

document.getElementById('inject-btn')?.addEventListener('click', () => {
  run(async () => {
    const text = dictationPreview.value.trim();
    if (!text) return;
    const reply = await insertIntoActiveTab(text);
    setStatus(reply?.ok ? message('injected') : (reply?.error ?? message('noFocusedInput')));
  });
});

run(loadSettingsAndProbe);
