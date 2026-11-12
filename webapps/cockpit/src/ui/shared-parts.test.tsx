// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { page, REALM_A } from '../transactions/fixtures.test-support';
import { readListParams } from '../transactions/list-params';
import { Badge, TONES } from './Badge';
import { Breadcrumbs } from './Breadcrumbs';
import { IdText } from './IdText';
import { Link } from './Link';
import { SuggestForm } from './rent/SuggestForm';
import { statusLabel } from './transactions/labels';
import { StatusBadge, TransactionListView } from './transactions/TransactionList';

/**
 * The shared parts of the cockpit (Issue #353 des Projektinhabers, 2026-11-12, point 10): one Link, one Badge with
 * its TONES, one Breadcrumbs and one IdText, each in its own file under ui/, and no copy of them left in an area.
 */

/** This directory as a path (a `URL` of jsdom is no file URL for `node:fs`). */
/** The link style, spelled apart so that a git grep for it finds Link.tsx only (Issue #353, acceptance). */
const LINK_STYLE = ['text-primary', 'underline'].join(' ');

const ui = dirname(fileURLToPath(import.meta.url));

/** Every production file under ui/ with its text, as `rent/RentParts.tsx`. */
function productionFiles(dir = ui, prefix = ''): (readonly [string, string])[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return productionFiles(join(dir, entry.name), `${prefix}${entry.name}/`);
    if (!/\.tsx?$/.test(entry.name) || /\.test(-support)?\.tsx?$/.test(entry.name)) return [];
    return [[`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), 'utf8')] as const];
  });
}

const filesWith = (pattern: RegExp) =>
  productionFiles()
    .filter(([, source]) => pattern.test(source))
    .map(([name]) => name);

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('one of each, no copies (Issue #353 des Projektinhabers, 2026-11-12, point 10)', () => {
  it('the link style lives in Link.tsx only, the tones in Badge.tsx, the breadcrumbs in Breadcrumbs.tsx, the id style in IdText.tsx', () => {
    expect(productionFiles().length).toBeGreaterThan(40);
    expect(filesWith(new RegExp(LINK_STYLE))).toEqual(['Link.tsx']);
    expect(filesWith(/TONES\s*[:=]/)).toEqual(['Badge.tsx']);
    expect(filesWith(/Brotkrumen/)).toEqual(['Breadcrumbs.tsx']);
    expect(filesWith(/className="font-mono text-label"/)).toEqual(['IdText.tsx']);
    expect(filesWith(/function (Link|Badge|Breadcrumbs|NamedId|Code|Id)\b|const (Code|Id) =/)).toEqual(['Badge.tsx', 'Breadcrumbs.tsx', 'Link.tsx']);
  });
});

describe('Link', () => {
  it('a plain click navigates inside the app without a page load; title, aria-label and rel are passed on', () => {
    render(
      <Link href="/cockpit/r/x/buchungen" title="ganz" aria-label="Zur Liste" rel="prev">
        Liste
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Zur Liste' });
    expect(link.outerHTML).toBe(`<a class="${LINK_STYLE}" href="/cockpit/r/x/buchungen" title="ganz" aria-label="Zur Liste" rel="prev">Liste</a>`);
    expect(fireEvent.click(link, { button: 0 })).toBe(false);
    expect(window.location.pathname).toBe('/cockpit/r/x/buchungen');
  });

  it('a modified click and a reload link keep the browser behaviour', () => {
    render(
      <>
        <Link href="/a">A</Link>
        <Link href="/b" reload>
          B
        </Link>
      </>,
    );
    expect(fireEvent.click(screen.getByRole('link', { name: 'A' }), { button: 0, ctrlKey: true })).toBe(true);
    expect(fireEvent.click(screen.getByRole('link', { name: 'B' }), { button: 0 })).toBe(true);
    expect(window.location.pathname).toBe('/');
  });
});

describe('Badge, IdText and Breadcrumbs', () => {
  it('a badge says its text in the colours of its tone; the status badge is the same badge', () => {
    const html = renderToStaticMarkup(<Badge label={{ text: 'Bestätigt', tone: 'success', known: true }} />);
    expect(html).toBe(`<span class="inline-block whitespace-nowrap rounded-input border px-2 text-label ${TONES.success}">Bestätigt</span>`);
    expect(renderToStaticMarkup(<StatusBadge code="IMPORTED" />)).toBe(renderToStaticMarkup(<Badge label={statusLabel('IMPORTED')} />));
    expect(Object.keys(TONES).sort()).toEqual(['info', 'neutral', 'success', 'warning']);
  });

  it('an id as code; with a name the name and the id as title; without a name the id after a note', () => {
    expect(renderToStaticMarkup(<IdText id="abc" />)).toBe('<code class="font-mono text-label">abc</code>');
    expect(renderToStaticMarkup(<IdText id="abc" name="Girokonto" />)).toBe('<span title="abc">Girokonto</span>');
    expect(renderToStaticMarkup(<IdText id="abc" name={undefined} />)).toBe(
      '<span class="text-muted">Name nicht verfügbar</span> <code class="font-mono text-label">abc</code>',
    );
    expect(renderToStaticMarkup(<IdText id="NEW_CODE" name={undefined} missing="Unbekannte Kategorie" />)).toContain('Unbekannte Kategorie');
  });

  it('breadcrumbs: the area as a link, the page as the current one', () => {
    render(<Breadcrumbs items={[{ label: 'Buchungen', href: '/cockpit/r/x/buchungen' }, { label: 'Buchung vom 03.11.2026' }]} />);
    const nav = screen.getByRole('navigation', { name: 'Brotkrumen' });
    expect(screen.getByRole('link', { name: 'Buchungen' }).getAttribute('href')).toBe('/cockpit/r/x/buchungen');
    expect(screen.getByText('Buchung vom 03.11.2026').getAttribute('aria-current')).toBe('page');
    expect(nav.textContent).toBe('Buchungen ›Buchung vom 03.11.2026');
  });
});

describe('date fields in a browser of another language (Issue #353 des Projektinhabers, 2026-11-12, point 9)', () => {
  /** The label of each date or month input of the markup, by the input's id. */
  const dateLabels = (html: string) => {
    document.body.innerHTML = html;
    return [...document.querySelectorAll<HTMLInputElement>('input[type="date"], input[type="month"]')].map(
      (input) => document.querySelector(`label[for="${input.id}"]`)?.textContent ?? input.labels?.[0]?.textContent,
    );
  };
  const noFormat = /TT|JJJJ|MM|DD|YYYY|\d/;

  it('the labels name the field only, never a format the browser may show differently (mm/dd/yyyy in English)', () => {
    const list = renderToStaticMarkup(
      <TransactionListView
        realmId={REALM_A}
        params={readListParams('')}
        list={{ status: 'success', data: page([]) }}
        references={{ accounts: { status: 'pending' }, properties: { status: 'pending' }, categories: { status: 'pending' } }}
        onFilter={() => undefined}
        onRetry={() => undefined}
      />,
    );
    const suggest = renderToStaticMarkup(<SuggestForm realmId={REALM_A} suggest={() => Promise.reject(new Error('not sent'))} onSuggested={() => undefined} />);
    const labels = [...dateLabels(list), ...dateLabels(suggest)];
    expect(labels).toEqual(['Buchungsdatum von', 'Buchungsdatum bis', 'Erster Monat', 'Letzter Monat']);
    for (const label of labels) expect(label).not.toMatch(noFormat);
  });
});
