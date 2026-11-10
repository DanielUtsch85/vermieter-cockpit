import { useSyncExternalStore, type MouseEvent } from 'react';

/** Client-side navigation inside one Realm (`history.pushState`); a Realm change is a page load (routing.ts). */
const subscribe = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
};

const currentPath = () => window.location.pathname;

export function useLocationPath(): string {
  return useSyncExternalStore(subscribe, currentPath, currentPath);
}

/**
 * A page the browser restores from its back-forward cache keeps its memory: the session, its token and the data of
 * the time it was left. After a sign-out in another page of the cockpit that would show a signed-in page again, so a
 * restored page is loaded afresh and checks its session with the authenticator (mre-integration.md §47.2 point 1).
 */
export function reloadWhenRestoredFromCache(target: Pick<Window, 'addEventListener'>, reload: () => void): void {
  target.addEventListener('pageshow', (event) => {
    if (event.persisted) reload();
  });
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
