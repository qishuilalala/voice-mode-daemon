import { redactSecrets } from '@voice-mode/core';

export interface SwMessageSender {
  id?: string;
  tab?: { id?: number; url?: string };
}

export interface SwRouterDeps {
  runtimeId: string;
  queryActiveTabId(): Promise<number | undefined>;
  ensureContentScript(tabId: number): Promise<void>;
  sendTabMessage(tabId: number, message: Record<string, unknown>): Promise<unknown>;
}

/**
 *Privileged MV3 Service Worker message dispatcher.
 * Only accepts messages from the extension's own Side Panel (`sender.id === runtimeId && !sender.tab`),
 * blocking untrusted content scripts and foreign extensions from reading or injecting tabs.
 */
export function dispatchServiceWorkerMessage(
  rawMsg: unknown,
  sender: SwMessageSender,
  sendResponse: (response: unknown) => void,
  deps: SwRouterDeps,
): boolean {
  if (typeof rawMsg !== 'object' || rawMsg === null) return false;
  const msg = rawMsg as {
    type?: string;
    text?: string;
    replacements?: unknown[];
  };

  if (
    msg.type !== 'VM_SW_STATUS' &&
    msg.type !== 'VM_READ_ACTIVE_TAB' &&
    msg.type !== 'VM_INJECT_ACTIVE_TAB'
  ) {
    return false;
  }

  if (Boolean(sender.tab) || !sender.id || sender.id !== deps.runtimeId) {
    sendResponse({ ok: false, error: 'Forbidden message sender' });
    return false;
  }

  if (msg.type === 'VM_SW_STATUS') {
    sendResponse({ ok: true, serviceWorker: 'voice-mode-mv3', version: '0.1.0' });
    return false;
  }

  void (async () => {
    try {
      const targetTabId = await deps.queryActiveTabId();
      if (targetTabId === undefined) {
        sendResponse({ ok: false, error: 'No active browser tab found' });
        return;
      }

      await deps.ensureContentScript(targetTabId);

      if (msg.type === 'VM_READ_ACTIVE_TAB') {
        const reply = await deps.sendTabMessage(targetTabId, {
          type: 'VM_EXTRACT_PAGE_TEXT',
        });
        sendResponse(reply);
        return;
      }

      const reply = await deps.sendTabMessage(targetTabId, {
        type: 'VM_INJECT_DICTATION',
        text: typeof msg.text === 'string' ? msg.text : '',
        replacements: Array.isArray(msg.replacements) ? msg.replacements : [],
      });
      sendResponse(reply);
    } catch (err) {
      const safe = redactSecrets(err instanceof Error ? err.message : String(err));
      sendResponse({ ok: false, error: safe });
    }
  })();

  return true;
}
