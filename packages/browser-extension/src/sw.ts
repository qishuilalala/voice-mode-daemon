import { dispatchServiceWorkerMessage, type SwRouterDeps } from './sw-router.js';

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

const liveDeps: SwRouterDeps = {
  get runtimeId() {
    return chrome.runtime.id;
  },
  async queryActiveTabId() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id;
  },
  ensureContentScript: ensureContentScriptOnTab,
  sendTabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
};

chrome.runtime.onMessage.addListener((rawMsg, sender, sendResponse) => {
  return dispatchServiceWorkerMessage(rawMsg, sender, sendResponse, liveDeps);
});
