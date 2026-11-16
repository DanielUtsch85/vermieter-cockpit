import type { ReactNode } from 'react';
import { onLinkClick } from '../navigation';

/**
 * The one text link of the cockpit (ui-guide.md §4.3; Issue #353 des Projektinhabers, 2026-11-12, point 10). A plain
 * click on an internal link navigates without a page load (`onLinkClick`); `reload` keeps the browser's own load, for
 * a link that must leave the page's memory behind (the Realm choice, the reset of the list's filters). `newTab` opens
 * the target in a new tab (`target="_blank"`, `rel="noopener noreferrer"`), never inside the cockpit.
 */
export function Link(props: {
  readonly href: string;
  readonly children: ReactNode;
  readonly title?: string | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly rel?: string | undefined;
  readonly reload?: boolean;
  readonly newTab?: boolean;
}) {
  const { href } = props;
  if (props.newTab === true) {
    return (
      <a className="text-primary underline" href={href} title={props.title} aria-label={props['aria-label']} target="_blank" rel="noopener noreferrer">
        {props.children}
      </a>
    );
  }
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

/**
 * MRE's landlord interface: `/` of the same origin, which the proxy's Caddyfile (deploy/caddy/Caddyfile) hands to MRE,
 * while the cockpit lives under `/cockpit/`.
 */
export const MRE_HOME = '/';

/**
 * „MicroRealEstate öffnen“, in a new tab, where the cockpit sends the user to MRE to create something (Entscheidung des
 * Projektinhabers, 2026-11-16, on #372: „Link auf MicroRealEstate: ja, auf `/` derselben Origin, denn der Caddyfile
 * leitet `/` an die MRE-Vermieteroberfläche. Text „MicroRealEstate öffnen“, öffnet im neuen Tab.“).
 */
export function MreLink() {
  return (
    <Link href={MRE_HOME} title="Öffnet in einem neuen Tab" newTab>
      MicroRealEstate öffnen
    </Link>
  );
}
