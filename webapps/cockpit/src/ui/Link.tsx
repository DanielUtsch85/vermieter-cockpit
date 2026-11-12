import type { ReactNode } from 'react';
import { onLinkClick } from '../navigation';

/**
 * The one text link of the cockpit (ui-guide.md §4.3; Issue #353 des Projektinhabers, 2026-11-12, point 10). A plain
 * click on an internal link navigates without a page load (`onLinkClick`); `reload` keeps the browser's own load, for
 * a link that must leave the page's memory behind (the Realm choice, the reset of the list's filters).
 */
export function Link(props: {
  readonly href: string;
  readonly children: ReactNode;
  readonly title?: string | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly rel?: string | undefined;
  readonly reload?: boolean;
}) {
  const { href } = props;
  return (
    <a
      className="text-primary underline"
      href={href}
      title={props.title}
      aria-label={props['aria-label']}
      rel={props.rel}
      onClick={props.reload === true ? undefined : (event) => onLinkClick(event, href)}
    >
      {props.children}
    </a>
  );
}
