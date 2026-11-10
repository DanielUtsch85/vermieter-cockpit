import { useSyncExternalStore, type MouseEvent } from 'react';

/** Client-side navigation inside one Realm (`history.pushState`); a Realm change is a page load (routing.ts). */
const subscribe = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
};

export function useLocationPath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}

export function navigate(path: string): void {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** A plain click on an internal link navigates without a page load; modified clicks keep the browser's behaviour. */
export function onLinkClick(event: MouseEvent<HTMLAnchorElement>, path: string): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}
