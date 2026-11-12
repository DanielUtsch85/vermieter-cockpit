import { expect, type Page } from '@playwright/test';
import { seed } from './stack';

/** Helpers of the specs: what a user does, with the labels the user reads (roles and labels, no CSS selectors). */

export const realmPath = (realm: string, area = '') => `/cockpit/r/${realm}/${area}`;

/** Fills the cockpit's own sign-in form (the MRE authenticator behind Caddy, no DE login). */
export async function signIn(page: Page, email: string, password = seed().password): Promise<void> {
  await page.getByLabel('E-Mail-Adresse').fill(email);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
}

/**
 * The overview of a Realm after DE's access check (`GET /api/v1/health` with `organizationid`). The Realm DE confirmed
 * is in the collapsed „Technische Angaben“ (Issue #352 des Projektinhabers, 2026-11-12, point 3), read there.
 */
export async function expectAccess(page: Page, realm: string): Promise<void> {
  await expect(page.getByText('Zugriff bestätigt für diesen Bestand')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Technische Angaben der Verbindung' })).toContainText(`Zugriff bestätigt für${realm}`);
}

/**
 * ui-guide.md §4.2 at a phone's width (Issue #352, point 1): at 390 × 844 the page does not scroll sideways; the
 * viewport is set back afterwards, so the walk goes on as before.
 */
export async function expectNoSideScroll(page: Page, where: string): Promise<void> {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth), where).toBeLessThanOrEqual(390);
  if (before !== null) await page.setViewportSize(before);
}

/** The refresh token as the browser keeps it: the one cookie of the MRE authenticator. */
export async function refreshCookie(page: Page) {
  const cookies = (await page.context().cookies()).filter((cookie) => cookie.name === 'refreshToken');
  expect(cookies).toHaveLength(1);
  return cookies[0]!;
}
