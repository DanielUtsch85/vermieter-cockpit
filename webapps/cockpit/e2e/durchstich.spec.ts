import { devices, expect, test, type Page } from '@playwright/test';
import { expectAccess, expectNoSideScroll, realmPath, signIn } from './session';
import { ACCOUNT_IBAN, ACCOUNT_NAME, mrePayments, seed, TERM_OCT, WALK_CSV, WALK_CSV_NAME } from './stack';

/**
 * A reduced walk over steps 1–7 of ui-guide.md §10 plus step 8 against the real backend, the pinned MRE and PostgreSQL,
 * through Caddy (backlog VC-X-70): sign-in, CSV import with a synthetic file, both decisions on review items, the split
 * from MRE's proposal (step 8) saved and the booking confirmed, the rent suggestion confirmed and written back to MRE.
 * The jsdom Durchstich (src/durchstich) stays the place for error and conflict cases and exact request bodies; this file
 * shows that the same clicks work against the real services. One test: each step needs the one before.
 */

const NBSP = ' ';
const euro = (amount: string) => `${amount}${NBSP}€`;

async function nav(page: Page, area: 'Buchungen' | 'Import' | 'Mietabgleich') {
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('link', { name: area }).click();
  await expect(page.getByRole('heading', { level: 1, name: area })).toBeVisible();
}

test('import, review items, split from the MRE proposal, confirm, rent suggestion confirmed and written back to MRE', async ({ page }) => {
  const s = seed();
  const W = s.realmW.id;

  // Step 1: a deep link into the Realm, signed out; after the sign-in the same page.
  await page.goto(realmPath(W));
  await signIn(page, s.admin);
  await expectAccess(page, W);
  await expectNoSideScroll(page, 'overview');

  // Step 5: import the synthetic statement; the new row is booked, the two rows of the earlier import are review items.
  await nav(page, 'Import');
  await page.getByLabel('Konto').selectOption({ label: `${ACCOUNT_NAME} · ${ACCOUNT_IBAN}` });
  await page.getByLabel('CSV-Datei').setInputFiles({ name: WALK_CSV_NAME, mimeType: 'text/csv', buffer: Buffer.from(WALK_CSV) });
  const upload = page.waitForResponse((r) => r.url().endsWith('/api/v1/imports/bank-transactions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Import ausführen' }).click();
  expect((await upload).status()).toBe(201);
  await expect(page.getByRole('heading', { name: 'Ergebnis des Imports' })).toBeVisible();
  const rows = page.getByRole('region', { name: 'Zeilen der Datei' }).getByRole('row');
  // By default only the rows with a hint; every row with „Alle Zeilen“.
  await expect(rows).toHaveCount(3);
  await expectNoSideScroll(page, 'import result');
  await page.getByRole('button', { name: 'Alle Zeilen' }).click();
  // „Alle Zeilen“ is the URL's `?zeilen=alle` (review of #349; optional, the owner has not decided on it).
  await expect(page).toHaveURL(/[?&]zeilen=alle$/);
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: 'Neu angelegt' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Klärfall' })).toHaveCount(2);

  // Both decisions, each with its confirmation step.
  const insurance = page.getByRole('article').filter({ hasText: 'Gutschrift Testversicherung Nachtrag' });
  await insurance.getByRole('button', { name: 'Als eigenständige Buchung übernehmen' }).click();
  await insurance.getByRole('button', { name: 'Jetzt übernehmen' }).click();
  await expect(insurance.getByText(/Entschieden: Als eigenständige Buchung übernommen/)).toBeVisible();
  const utility = page.getByRole('article').filter({ hasText: 'Abschlag Testzaehler' });
  await utility.getByRole('button', { name: 'Nicht als neue Buchung übernehmen' }).click();
  await utility.getByRole('button', { name: 'Jetzt nicht übernehmen' }).click();
  await expect(utility.getByText(/Entschieden: Nicht als neue Buchung übernommen/)).toBeVisible();

  // Step 2: the rent in the list, opened by its date.
  await nav(page, 'Buchungen');
  await expectNoSideScroll(page, 'booking list');
  // At 1280 px the account stays on one line; the purpose carries its whole text as title (Issue #353, point 7).
  const rent = page.getByRole('row').filter({ hasText: 'Miete Oktober Testwohnung' });
  await expect(rent.getByTitle('Miete Oktober Testwohnung', { exact: true })).toBeVisible();
  const account = rent.getByTitle(ACCOUNT_NAME, { exact: true });
  expect(await account.evaluate((el) => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 1.5)).toBe(true);
  await page.getByRole('link', { name: 'Buchung vom 01.10.2026 öffnen' }).click();
  await expect(page.getByText('Miete Oktober Testwohnung').first()).toBeVisible();
  // The h1 names the page; the area is in the breadcrumbs and the tab, the focus is on the title (Issue #353, point 5).
  const title = page.getByRole('heading', { level: 1, name: 'Buchung vom 01.10.2026' });
  await expect(title).toBeFocused();
  await expect(page.getByRole('navigation', { name: 'Brotkrumen' }).getByRole('link', { name: 'Buchungen' })).toBeVisible();
  await expect(page).toHaveTitle(/^Buchung vom 01\.10\.2026 · Buchungen · /);

  // Step 8 into step 3: MRE's proposal for the October term, taken over into the draft, then saved exactly.
  const proposal = page.getByRole('region', { name: 'Aufteilungsvorschlag aus MRE' });
  // The proposal starts collapsed, its first sentence as the summary (Issue #353, point 9).
  await expect(proposal.getByLabel('Mieter in MRE (ID)')).toBeHidden();
  await proposal.getByText('Für einen Mieteingang: Mieter und Miettermin in MRE wählen, bei einer Sammelzahlung mehrere.').click();
  await proposal.getByLabel('Mieter in MRE (ID)').fill(s.tenantId);
  await proposal.getByLabel('Miettermin (MRE-Schlüssel JJJJMMTTHH)').fill(TERM_OCT);
  await proposal.getByRole('button', { name: 'Vorschlag laden' }).click();
  const terms = proposal.getByRole('list', { name: 'Gewählte Termine' });
  await expect(terms).toContainText(`Kaltmiete laut Mietvertrag${euro('700,00')}`);
  await expect(terms).toContainText(`Nebenkosten laut Mietvertrag${euro('150,00')}`);
  await expect(terms).toContainText(`Sollbetrag des Termins (MRE)${euro('850,00')}`);
  await expect(proposal).toContainText('deckt sie genau.');
  await proposal.getByRole('button', { name: 'Vorschlag in Aufteilung übernehmen' }).click();
  await expect(page.getByText(/Vorschlag in den Entwurf übernommen/)).toBeVisible();
  const editor = page.getByRole('region', { name: 'Aufteilung bearbeiten' });
  const split = page.waitForResponse((r) => /\/api\/v1\/transactions\/[^/]+\/splits$/.test(r.url()) && r.request().method() === 'PUT');
  await editor.getByRole('button', { name: 'Aufteilung speichern' }).click();
  expect((await split).status()).toBe(200);
  await expect(editor.getByText(/Aufteilung gespeichert \(Version \d+, Status „Aufgeteilt“\)/)).toBeVisible();
  // The saved split at a phone's width: no side scroll, and both amounts of the read-only table whole on the screen.
  await expect(page.getByRole('region', { name: 'Aufteilung', exact: true }).getByRole('row')).toHaveCount(3);
  await expectNoSideScroll(page, 'booking detail');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const amount of [euro('700,00'), euro('150,00')]) {
    const cell = page.getByRole('region', { name: 'Aufteilung', exact: true }).getByText(amount, { exact: true });
    await cell.scrollIntoViewIfNeeded();
    const box = await cell.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 390, amount).toBe(true);
  }
  await page.setViewportSize(devices['Desktop Chrome'].viewport);

  // Step 4: confirm the booking with its confirmation step; the proposal is gone, the rent cash is free for matching.
  await page.getByRole('button', { name: 'Buchung bestätigen' }).click();
  await page.getByRole('button', { name: 'Jetzt bestätigen' }).click();
  await expect(page.getByText(/Buchung bestätigt \(Version \d+/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Aufteilungsvorschlag aus MRE' })).toHaveCount(0);
  const coverage = page.getByRole('region', { name: 'Mietabgleich dieser Buchung' });
  await expect(coverage).toContainText(`Mietanteil der Buchung${euro('850,00')}Davon bestätigt zugeordnet${euro('0,00')}Noch frei${euro('850,00')}`);

  // Step 6: suggest October, confirm the one suggestion, then write it back to MRE as its own step.
  await nav(page, 'Mietabgleich');
  await page.getByLabel('Erster Monat').fill('2026-10');
  await page.getByLabel('Letzter Monat').fill('2026-10');
  await page.getByRole('button', { name: 'Vorschläge ermitteln' }).click();
  await expect(page.getByText('1 neuer Vorschlag für 2026-10 bis 2026-10.')).toBeVisible();
  await expectNoSideScroll(page, 'rent suggestions');
  await page.getByRole('list', { name: 'Neue Vorschläge' }).getByRole('link', { name: 'Vorschlag prüfen' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Zuordnung' })).toBeFocused();
  await expect(page.getByLabel('Zu bestätigender Betrag (€)')).toHaveValue('850,00');
  await page.getByRole('button', { name: 'Zuordnung bestätigen' }).click();
  await expect(page.getByText('Zuordnung bestätigt', { exact: false }).first()).toBeVisible();
  expect(await mrePayments(s, TERM_OCT)).toEqual([]);

  const writeBack = page.waitForResponse((r) => r.url().endsWith('/write-back-to-mre'));
  await page.getByRole('button', { name: 'An MRE übertragen' }).click();
  await page.getByRole('button', { name: 'Jetzt an MRE übertragen' }).click();
  expect((await writeBack).status()).toBe(200);
  await expect(page.getByText('MRE: übertragen')).toBeVisible();
  await expectNoSideScroll(page, 'rent reconciliation');
  const reconciliation = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  expect(await mrePayments(s, TERM_OCT)).toEqual([{ amount: 850, reference: `DE-RPR-${reconciliation}` }]);
});
