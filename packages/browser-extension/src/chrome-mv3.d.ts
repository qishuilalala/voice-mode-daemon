declare namespace chrome {
  namespace i18n {
    function getMessage(messageName: string, substitutions?: string | string[]): string;
  }

  namespace runtime {
    const id: string;
    interface MessageSender {
      id?: string;
      tab?: { id?: number; url?: string };
    }
    const onInstalled: {
      addListener(cb: () => void): void;
    };
    const onMessage: {
      addListener(
        cb: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    function sendMessage(message: unknown): Promise<unknown>;
  }

  namespace sidePanel {
    function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
  }

  namespace storage {
    const local: {
      get(keys: string[] | Record<string, unknown>): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      active?: boolean;
    }
    function query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function sendMessage(tabId: number, message: unknown): Promise<unknown>;
  }

  namespace permissions {
    function contains(perms: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
    function request(perms: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  }

  namespace scripting {
    function executeScript(injection: {
      target: { tabId: number };
      files: string[];
    }): Promise<unknown>;
  }
}
