import type { CloudDictationSession } from '@voice-mode/browser';
import {
  DEFAULT_DAEMON_BASE_URL,
  redactSecrets,
  type AsrReplacement,
  type DaemonHealthResult,
} from '@voice-mode/core';
import {
  VoiceExtensionCoordinator,
  type TranscriptionSummary,
} from './coordinator.js';

interface StoredSettings {
  daemonBaseUrl?: string;
  daemonToken?: string;
  voice?: string;
  asrModel?: 'zipformer2' | 'sensevoice';
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
const readInput = document.getElementById('read-input') as HTMLTextAreaElement;
const dictationPreview = document.getElementById('dictation-preview') as HTMLTextAreaElement;
const statusLog = document.getElementById('status-log') as HTMLElement;
const micBtn = document.getElementById('mic-btn') as HTMLButtonElement;

let currentReplacements: AsrReplacement[] = [
  { from: ['deep seek'], to: 'DeepSeek' },
  { from: ['kimi chat'], to: 'Kimi' },
];
let dictationSession: CloudDictationSession | null = null;

function setStatus(message: string): void {
  statusLog.textContent = redactSecrets(message);
}

function setBadge(state: 'checking' | 'ready' | 'fallback', text: string): void {
  badgeEl.dataset.state = state;
  badgeEl.textContent = text;
}

const coordinator = new VoiceExtensionCoordinator({
  daemonBaseUrl: DEFAULT_DAEMON_BASE_URL,
  replacements: currentReplacements,
  onFallback: (surface, reason) => {
    setBadge('fallback', 'Browser Fallback (<1s)');
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
    'replacements',
  ])) as StoredSettings;

  urlInput.value = stored.daemonBaseUrl ?? DEFAULT_DAEMON_BASE_URL;
  tokenInput.value = stored.daemonToken ?? '';
  if (stored.voice) voiceSelect.value = stored.voice;
  if (stored.asrModel) asrSelect.value = stored.asrModel;
  if (Array.isArray(stored.replacements)) {
    currentReplacements = stored.replacements;
  }

  await coordinator.reconfigure({
    daemonBaseUrl: urlInput.value.trim() || DEFAULT_DAEMON_BASE_URL,
    ...(tokenInput.value.trim() ? { daemonToken: tokenInput.value.trim() } : {}),
    voice: voiceSelect.value,
    asrModel: (asrSelect.value as 'zipformer2' | 'sensevoice') || 'zipformer2',
    replacements: currentReplacements,
    onFallback: (surface, reason) => {
      setBadge('fallback', 'Browser Fallback (<1s)');
      setStatus(`Fallback (${surface}): ${reason}`);
    },
    onError: (msg) => setStatus(`Error: ${msg}`),
  });

  const health = await coordinator.probeHealth();
  if (health.ok) {
    setBadge('ready', `Daemon v${health.version} (${health.voices.length} voices)`);
    setStatus('Connected to local voice-daemon.');
  } else {
    setBadge('fallback', 'Browser Fallback (<1s)');
    setStatus(`Daemon unavailable (${health.error ?? 'offline'}); using <1s fallback.`);
  }
  return health;
}

async function saveCurrentSettings(overrides?: Partial<StoredSettings>): Promise<DaemonHealthResult> {
  if (overrides?.daemonBaseUrl !== undefined) urlInput.value = overrides.daemonBaseUrl;
  if (overrides?.daemonToken !== undefined) tokenInput.value = overrides.daemonToken;
  if (overrides?.voice !== undefined) voiceSelect.value = overrides.voice;
  if (overrides?.asrModel !== undefined) asrSelect.value = overrides.asrModel;
  if (overrides?.replacements !== undefined) currentReplacements = overrides.replacements;

  await chrome.storage.local.set({
    daemonBaseUrl: urlInput.value.trim() || DEFAULT_DAEMON_BASE_URL,
    daemonToken: tokenInput.value.trim(),
    voice: voiceSelect.value,
    asrModel: asrSelect.value,
    replacements: currentReplacements,
  });
  return loadSettingsAndProbe();
}

document.getElementById('save-btn')?.addEventListener('click', () => {
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
    if (dictationSession && dictationSession.state !== 'idle') {
      await dictationSession.stop();
      micBtn.textContent = 'Start Mic';
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

export interface SidePanelAutomationBridge {
  configure(settings: Partial<StoredSettings>): Promise<DaemonHealthResult>;
  synthesize(
    text: string,
    opts?: { voice?: string; rate?: number },
  ): Promise<{ byteLength: number; mime: string; usedFallback: boolean; elapsedMs: number }>;
  transcribe(
    samples: number[],
    sampleRate: number,
    asrModel?: 'zipformer2' | 'sensevoice',
  ): Promise<TranscriptionSummary>;
  injectIntoTab(tabId: number, text: string): Promise<{ ok?: boolean; error?: string }>;
}

const bridge: SidePanelAutomationBridge = {
  configure: (settings) => saveCurrentSettings(settings),
  async synthesize(text, opts) {
    const { result, usedFallback, elapsedMs } = await coordinator.synthesizeOnce(text, opts);
    return {
      byteLength: result.audio.byteLength,
      mime: result.mime,
      usedFallback,
      elapsedMs,
    };
  },
  async transcribe(samples, sampleRate, asrModel) {
    if (asrModel && asrSelect.value !== asrModel) {
      await saveCurrentSettings({ asrModel });
    }
    return coordinator.transcribeAudio(Float32Array.from(samples), sampleRate);
  },
  async injectIntoTab(tabId, text) {
    return (await chrome.runtime.sendMessage({
      type: 'VM_INJECT_ACTIVE_TAB',
      tabId,
      text,
      replacements: currentReplacements,
    })) as { ok?: boolean; error?: string };
  },
};

(globalThis as unknown as { __voiceModeSidePanel?: SidePanelAutomationBridge }).__voiceModeSidePanel =
  bridge;

void loadSettingsAndProbe();
