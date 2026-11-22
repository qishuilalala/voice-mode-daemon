import { redactSecrets } from '@voice-mode/core';

function configureSidePanel(): void {
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanel();
});

configureSidePanel();

async function ensureContentScriptOnTab(tabId: number): Promise<void> {
  try {
    const ping = (await chrome.tabs.sendMessage(tabId, { type: 'VM_PING_CONTENT' })) as
      | { ok?: boolean }
      | undefined;
    if (ping?.ok) return;
  } catch {
    // Content script not yet loaded in this tab; inject on demand if scripting is permitted.
  }

  const hasScripting = await chrome.permissions.contains({ permissions: ['scripting'] });
  if (!hasScripting) {
    throw new Error('Grant active chat site access in Side Panel before interacting with this page.');
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
}

chrome.runtime.onMessage.addListener((rawMsg, _sender, sendResponse) => {
  if (typeof rawMsg !== 'object' || rawMsg === null) return false;
  const msg = rawMsg as {
    type?: string;
    tabId?: number;
    text?: string;
    replacements?: unknown[];
  };

  if (msg.type === 'VM_SW_STATUS') {
    sendResponse({ ok: true, serviceWorker: 'voice-mode-mv3', version: '0.1.0' });
    return false;
  }

  if (msg.type === 'VM_READ_ACTIVE_TAB' || msg.type === 'VM_INJECT_ACTIVE_TAB') {
    void (async () => {
      try {
        let targetTabId = msg.tabId;
        if (targetTabId === undefined) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          targetTabId = tabs[0]?.id;
        }
        if (targetTabId === undefined) {
          sendResponse({ ok: false, error: 'No active browser tab found' });
          return;
        }

        await ensureContentScriptOnTab(targetTabId);

        if (msg.type === 'VM_READ_ACTIVE_TAB') {
          const reply = await chrome.tabs.sendMessage(targetTabId, {
            type: 'VM_EXTRACT_PAGE_TEXT',
          });
          sendResponse(reply);
          return;
        }

        const reply = await chrome.tabs.sendMessage(targetTabId, {
          type: 'VM_INJECT_DICTATION',
          text: msg.text ?? '',
          replacements: msg.replacements ?? [],
        });
        sendResponse(reply);
      } catch (err) {
        const safe = redactSecrets(err instanceof Error ? err.message : String(err));
        sendResponse({ ok: false, error: safe });
      }
    })();
    return true;
  }

  return false;
});
