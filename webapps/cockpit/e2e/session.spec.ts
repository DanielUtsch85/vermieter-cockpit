import { expect, test } from '@playwright/test';
import { expectAccess, realmPath, refreshCookie, signIn } from './session';
import { seed } from './stack';

/**
 * The gate of #319 in the browser (sign-in, refresh, Realm choice, `403` without a switch, sign-out, deep link), now
 * in CI against the real `cockpit-ui` behind Caddy, the pinned MRE and PostgreSQL (backlog VC-X-70). Synthetic accounts
 * only (stack.ts).
 */

const host = process.env['COCKPIT_HOSTNAME'] ?? 'cockpit.internal';

test('without a session the start page asks for the sign-in; a wrong password is said, no session', async ({ page }) => {
  const refresh = page.waitForResponse((r) => r.url().endsWith('/api/v2/authenticator/landlord/refreshtoken'));
  const script = page.waitForResponse((r) => /\/cockpit\/assets\/[^/]+\.js$/.test(new URL(r.url()).pathname));
  const start = await page.goto('/cockpit/');
  // The page as cockpit-ui serves it through Caddy (#322 F3): index.html never stored, the hashed script immutable.
  expect([start?.status(), await start?.headerValue('cache-control')]).toEqual([200, 'no-store']);
  expect(await (await script).headerValue('cache-control')).toContain('immutable');
  expect((await refresh).status()).toBe(403);
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  await signIn(page, seed().admin, 'E2e-wrong-password');
  await expect(page.getByText('E-Mail-Adresse oder Passwort ist falsch.')).toBeVisible();
  expect(await page.context().cookies()).toEqual([]);
});

test('sign-in, Realm choice, refresh by click and by reload, 403 without a switch, sign-out', async ({ page }) => {
  const { admin, realmA, realmB } = seed();
  await page.goto('/cockpit/');
  await signIn(page, admin);

  // The Realm list of MRE: A (administrator) and B (renter there), each by name.
  const realms = page.getByRole('list', { name: 'Bestände' });
  await expect(realms.getByRole('link', { name: new RegExp(realmA.name) })).toBeVisible();
  await expect(realms.getByRole('link', { name: new RegExp(realmB.name) })).toBeVisible();

  // The refresh token is a cookie the page cannot read; nothing of the session in the page's storage.
  const cookie = await refreshCookie(page);
  expect([cookie.httpOnly, cookie.secure, cookie.sameSite, cookie.domain.replace(/^\./, '')]).toEqual([true, true, 'Strict', host]);
  expect(await page.evaluate(() => [document.cookie, localStorage.length, sessionStorage.length])).toEqual(['', 0, 0]);

  // A: DE confirms the access with the token and the Realm; the Realm is in the URL.
  await realms.getByRole('link', { name: new RegExp(realmA.name) }).click();
  await expectAccess(page, realmA.id);
  await expect(page).toHaveURL(realmPath(realmA.id));

  // „Jetzt erneuern“: one refresh through Caddy with the cookie; it sets the cookie again with the same attributes. (The
  // value may equal the old one within the same second: MRE signs `iat` in seconds; #319 waited 32 s, a CI run does not.)
  const renewed = page.waitForResponse((r) => r.url().endsWith('/refreshtoken'));
  await page.getByRole('button', { name: 'Jetzt erneuern' }).click();
  const renewal = await renewed;
  expect(renewal.status()).toBe(200);
  expect(await renewal.headerValue('set-cookie')).toMatch(/^refreshToken=/);
  await expect(page.getByText(/zuletzt um \d{2}:\d{2}/)).toBeVisible();
  const again = await refreshCookie(page);
  expect([again.httpOnly, again.secure, again.sameSite, again.domain.replace(/^\./, '')]).toEqual([true, true, 'Strict', host]);

  // A reload: the session comes back from the cookie, no sign-in page.
  await page.reload();
  await expectAccess(page, realmA.id);
  await expect(page.getByRole('button', { name: 'Anmelden' })).toHaveCount(0);

  // B, where the account is only a renter: DE answers 403; the cockpit stays at B and offers the choice, never switches.
  await page.getByRole('button', { name: 'Bestand wechseln' }).click();
  const health = page.waitForResponse((r) => r.url().endsWith('/api/v1/health'));
  await page
    .getByRole('list', { name: 'Bestände' })
    .getByRole('link', { name: new RegExp(realmB.name) })
    .click();
  expect((await health).status()).toBe(403);
  await expect(page.getByText('Kein Zugriff')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anderen Bestand wählen' })).toBeVisible();
  await expect(page).toHaveURL(realmPath(realmB.id));
  await expect(page.getByText(`Zugriff bestätigt für Bestand ${realmA.id}`)).toHaveCount(0);

  // Sign-out: MRE ends the session; a reload stays signed out.
  await page.getByRole('button', { name: 'Anderen Bestand wählen' }).click();
  const signout = page.waitForResponse((r) => r.url().endsWith('/api/v2/authenticator/landlord/signout'));
  await page.getByRole('button', { name: 'Abmelden' }).click();
  expect((await signout).status()).toBe(204);
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Anmelden' })).toBeVisible();
});

test('a deep link signed out: after the sign-in the same URL; a renter gets 403 there, the administrator the page', async ({ browser }) => {
  const { admin, renter, realmA } = seed();
  const deep = realmPath(realmA.id, 'buchungen');

  const asRenter = await browser.newPage();
  await asRenter.goto(deep);
  await signIn(asRenter, renter);
  await expect(asRenter).toHaveURL(deep);
  await expect(asRenter.getByText('Kein Zugriff')).toBeVisible();
  await asRenter.close();

  const asAdmin = await browser.newPage();
  await asAdmin.goto(deep);
  await signIn(asAdmin, admin);
  await expect(asAdmin).toHaveURL(deep);
  await expect(asAdmin.getByRole('heading', { level: 1, name: 'Buchungen' })).toBeVisible();
  await expect(asAdmin.getByText('In diesem Bestand gibt es noch keine Buchungen.', { exact: false })).toBeVisible();
  await asAdmin.close();
});
