import { Link } from './Link';

export interface Crumb {
  readonly label: string;
  /** The page of the crumb; the last crumb is the current page and has none. */
  readonly href?: string;
}

/**
 * Breadcrumbs of a sub-page (ui-guide.md §3.2): the area as a link, then the page itself (Issue #353 des
 * Projektinhabers, 2026-11-12, points 5 and 10). The shell renders them above the page title.
 */
export function Breadcrumbs({ items }: { readonly items: readonly Crumb[] }) {
  return (
    <nav aria-label="Brotkrumen">
      <ol className="flex flex-wrap gap-2 text-label text-muted">
        {items.map((item) =>
          item.href === undefined ? (
            <li key={item.label} aria-current="page">
              {item.label}
            </li>
          ) : (
            <li key={item.label}>
              <Link href={item.href}>{item.label}</Link>
              <span aria-hidden="true"> ›</span>
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}
