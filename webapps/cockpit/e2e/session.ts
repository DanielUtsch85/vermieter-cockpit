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

/** The overview of a Realm after DE's access check (`GET /api/v1/health` with `organizationid`). */
export async function expectAccess(page: Page, realm: string): Promise<void> {
  await expect(page.getByText(`Zugriff bestätigt für Bestand ${realm}`)).toBeVisible();
}

/** The refresh token as the browser keeps it: the one cookie of the MRE authenticator. */
export async function refreshCookie(page: Page) {
  const cookies = (await page.context().cookies()).filter((cookie) => cookie.name === 'refreshToken');
  expect(cookies).toHaveLength(1);
  return cookies[0]!;
}
