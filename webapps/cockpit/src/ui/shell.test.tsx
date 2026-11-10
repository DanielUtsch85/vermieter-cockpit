import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError, CLIENT_CODES } from '../api/errors';
import { createQueryClient } from '../query';
import { AREAS } from '../routing';
import { createMreAuthenticator } from '../session/mre-authenticator';
import { Session } from '../session/session';
import { SessionContext } from '../session/use-session';
import { AppShell } from './AppShell';
import { describeError, describeFieldError } from './error-text';
import { LoginPage } from './LoginPage';
import { AccessProblem, RealmPage } from './RealmPage';
import { ErrorState, pageTitle } from './states';

const REALM = '64b7f0c2a1b2c3d4e5f60718';

function render(node: ReactNode): string {
  const session = new Session(createMreAuthenticator(() => Promise.reject(new Error('no network in this test'))));
  return renderToStaticMarkup(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={createQueryClient()}>{node}</QueryClientProvider>
    </SessionContext.Provider>,
  );
}

describe('app shell (ui-guide.md §3.2)', () => {
  const overview = AREAS[0];
  const transactions = AREAS[1];
  if (overview === undefined || transactions === undefined) throw new Error('areas missing');

  it('shows the navigation of version 1 with Realm links, the Realm and the session', () => {
    const html = render(
      <AppShell realmId={REALM} realmName="Bestand Nord" area={transactions} email="admin1@example.com" access={null}>
        <p>Inhalt</p>
      </AppShell>,
    );
    for (const area of AREAS) expect(html).toContain(`>${area.label}</a>`);
    expect(html).toContain(`href="/cockpit/r/${REALM}/buchungen" aria-current="page"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('Bestand Nord');
    expect(html).toContain('Angemeldet als admin1@example.com');
    expect(html).toContain('<h1 tabindex="-1" class="text-title font-semibold">Buchungen</h1>');
    for (const later of ['Finanzierung', 'Kautionen', 'WEG', 'Steuern', 'Investment']) expect(html).not.toContain(later);
  });

  it('a Realm page waits for the access check of DE before it shows content', () => {
    const html = render(<RealmPage realmId={REALM} area={overview} epoch={0} email={undefined} renewedAt={undefined} />);
    expect(html).toContain('Zugriff auf den Bestand wird geprüft');
    expect(html).not.toContain('Arbeitsbereiche');
  });

  it('a 403 of the access check offers the Realm choice and no retry; a 503 offers a retry and no other Realm', () => {
    const retry = () => undefined;
    const forbidden = render(<AccessProblem error={new ApiError(403, 'FORBIDDEN', 'No access to this Realm.')} onRetry={retry} />);
    expect(forbidden).toContain('Kein Zugriff');
    expect(forbidden).toContain('Anderen Bestand wählen');
    expect(forbidden).not.toContain('Erneut prüfen');
    const unavailable = render(<AccessProblem error={new ApiError(503, 'EXTERNAL_SYSTEM_ERROR', 'x')} onRetry={retry} />);
    expect(unavailable).toContain('Erneut prüfen');
    expect(unavailable).not.toContain('Anderen Bestand wählen');
  });

  it('the browser tab names the page and the Realm', () => {
    expect(pageTitle('Buchungen', 'Bestand Nord')).toBe('Buchungen · Bestand Nord · Vermieter Cockpit');
    expect(pageTitle('')).toBe('Vermieter Cockpit');
  });

  it('on small screens the navigation is a drawer behind a labelled menu button, closed at first', () => {
    const html = render(
      <AppShell realmId={REALM} realmName={undefined} area={overview} email={undefined} access={null}>
        <p>Inhalt</p>
      </AppShell>,
    );
    expect(html).toContain('aria-expanded="false" aria-controls="hauptnavigation">Menü</button>');
    expect(html).toContain('<nav id="hauptnavigation" aria-label="Hauptnavigation"');
    expect(html).toContain(REALM);
  });

  it('the sign-in page names the MRE account and an expired session', () => {
    expect(render(<LoginPage expired={false} />)).toContain('Mit dem Konto von MicroRealEstate');
    expect(render(<LoginPage expired={true} />)).toContain('Ihre Sitzung ist abgelaufen');
  });
});

describe('field errors in an error state (ui-guide.md §7.4, §90, §58W, §58X)', () => {
  const fields = [
    { field: 'splits.0.amount', code: 'SCALE_EXCEEDED' },
    { field: 'splits.0.zzz', code: 'INVALID_FORMAT' },
    { field: 'splits.0.amount.zzz', code: 'INVALID_FORMAT' },
    { field: '(body)', code: 'REQUIRED' },
    { field: '', code: 'INVALID_FORMAT' },
    { field: 'If-Match', code: 'SOMETHING_NEW' },
  ];

  it('shows every entry in the server order, dotted paths with their index as sent', () => {
    const html = render(<ErrorState error={new ApiError(400, 'VALIDATION_ERROR', 'Validation failed.', { fields }, fields)} />);
    const entries = [...html.matchAll(/<li><code class="font-mono">([^<]*)<\/code>: ([^<]*)<\/li>/g)].map((match) => `${match[1]}: ${match[2]}`);
    expect(entries).toEqual([
      'splits.0.amount: zu viele Nachkommastellen',
      'splits.0.zzz: ungültig oder nicht vorgesehen',
      'splits.0.amount.zzz: ungültig oder nicht vorgesehen',
      'Anfrageinhalt: fehlt',
      'Feld ohne Namen: ungültig oder nicht vorgesehen',
      'If-Match: Code SOMETHING_NEW',
    ]);
    expect(html).toContain('Eingaben prüfen');
    expect(html).toContain('Code VALIDATION_ERROR');
  });

  it('the 422 of the resolve of a review item shows its fields the same way (§58X question 2)', () => {
    const resolve = [{ field: 'decision', code: 'REQUIRED' }];
    const html = render(<ErrorState error={new ApiError(422, 'VALIDATION_ERROR', 'x', { fields: resolve }, resolve)} />);
    expect(html).toContain('<code class="font-mono">decision</code>: fehlt');
  });

  it('a refusal without fields has no list; names and codes that look special are taken literally', () => {
    expect(render(<ErrorState error={new ApiError(409, 'CONFLICT', 'x')} />)).not.toContain('Abgelehnte Angaben');
    expect(describeFieldError({ field: 'toString', code: 'constructor' })).toEqual({ name: 'toString', text: 'Code constructor' });
    expect(describeFieldError({ field: '(query)', code: 'INVALID_FORMAT' }).name).toBe('Abfrage');
  });
});

describe('error texts (ui-guide.md §7.4)', () => {
  it('403 says no access and offers no other Realm by itself', () => {
    expect(describeError(new ApiError(403, 'FORBIDDEN', 'No access to this Realm.')).title).toBe('Kein Zugriff');
  });

  it('503 names the service and the Retry-After', () => {
    expect(describeError(new ApiError(503, 'EXTERNAL_SYSTEM_ERROR', 'x', undefined, [], 12)).text).toContain('in 12 Sekunden');
  });

  it('no answer says the outcome is unclear; an unknown status keeps the code', () => {
    expect(describeError(new ApiError(0, CLIENT_CODES.network, 'x')).text).toContain('unklar');
    expect(describeError(new ApiError(418, 'SOMETHING_NEW', 'x')).text).toBe('HTTP 418, Code SOMETHING_NEW.');
    expect(describeError(new Error('x')).title).toBe('Unerwarteter Fehler');
  });
});
