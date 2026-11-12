import { createContext, useContext, useEffect } from 'react';

/** How a sub-page tells the shell its title; outside a shell (a test of one area) nobody listens. */
export const PageTitleContext = createContext<(title: string | undefined) => void>(() => undefined);

/**
 * The title of a sub-page of an area („Buchung vom 03.11.2026“, „Zuordnung“): the shell shows it as the page's `h1`,
 * puts the area into the breadcrumbs and both into the browser tab (Issue #353 des Projektinhabers, 2026-11-12, point
 * 5). An area's own page renders none, so its name stays the `h1`. Renders nothing itself.
 */
export function PageTitle({ title }: { readonly title: string }) {
  const setTitle = useContext(PageTitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(undefined);
  }, [setTitle, title]);
  return null;
}
