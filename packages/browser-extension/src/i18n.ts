export function message(key: string, substitutions?: string[], fallback = ''): string {
  if (typeof chrome === 'undefined') return fallback;
  return chrome.i18n?.getMessage(key, substitutions) || fallback;
}
