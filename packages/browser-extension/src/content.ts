import type { AsrReplacement } from '@voice-mode/core';
import { extractReadableSelectionOrReply, injectDictatedTextIntoPage } from './coordinator.js';

interface ContentGlobal {
  __voiceModeContentInstalled?: boolean;
}

const g = globalThis as unknown as ContentGlobal;

if (!g.__voiceModeContentInstalled) {
  g.__voiceModeContentInstalled = true;

  chrome.runtime.onMessage.addListener((rawMsg, _sender, sendResponse) => {
    if (typeof rawMsg !== 'object' || rawMsg === null) return false;
    const msg = rawMsg as {
      type?: string;
      text?: string;
      replacements?: AsrReplacement[];
    };

    if (msg.type === 'VM_PING_CONTENT') {
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'VM_EXTRACT_PAGE_TEXT') {
      const text = extractReadableSelectionOrReply(document);
      sendResponse({ ok: true, text });
      return false;
    }

    if (msg.type === 'VM_INJECT_DICTATION') {
      const injected = injectDictatedTextIntoPage(
        document,
        typeof msg.text === 'string' ? msg.text : '',
        Array.isArray(msg.replacements) ? msg.replacements : [],
      );
      sendResponse({ ok: injected });
      return false;
    }

    return false;
  });
}
