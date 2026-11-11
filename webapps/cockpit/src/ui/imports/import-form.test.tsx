// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeClient } from '../../api/client';
import { countingTokens, envelope, json, scriptedFetch, type Call } from '../../api/fetch.test-support';
import { importBankTransactions, type ImportBatchDto } from '../../api/imports';
import { batch, csvFile, VR_CSV } from '../../imports/fixtures.test-support';
import { MAX_IMPORT_FILE_BYTES } from '../../imports/import-config';
import { account, ACCOUNT, page, REALM_A, REALM_B } from '../../transactions/fixtures.test-support';
import { ImportForm } from './ImportForm';

/**
 * Steps 1 and 2 of the import (jsdom, the real client `importBankTransactions`): what is shown before the import, the
 * multipart request, the size and IBAN hints, the refusals and the lost answer (ui-guide.md §6.5, §7.4, §11).
 */

const IBAN = 'DE00 0000 0000 0000 0000 01';
const OTHER = 'b1ad4a3f-5c6e-4f78-8a9b-3b4c5d6e7f80';

function setup(options: { answers?: Parameters<typeof scriptedFetch>; accounts?: ReturnType<typeof account>[] } = {}) {
  const { fetch, calls } = scriptedFetch(...(options.answers ?? [json(201, batch())]));
  const client = createDeClient({ tokens: countingTokens(), realmId: REALM_A, fetch });
  const imported: ImportBatchDto[] = [];
  const view = render(
    <ImportForm
      accounts={page(options.accounts ?? [account({ iban: IBAN })])}
      upload={(upload) => importBankTransactions(client, upload)}
      onImported={(answer) => imported.push(answer)}
    />,
  );
  return { calls, imported, view };
}

const fileInput = () => document.getElementById('import-datei') as HTMLInputElement;
const accountSelect = () => document.getElementById('import-konto') as HTMLSelectElement;
const importButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /Import ausführen|Import läuft/ });
const choose = (file: File = csvFile()) => fireEvent.change(fileInput(), { target: { files: [file] } });
/** `act` typed as it is used here (the library's overloads are not resolved by the type-checked lint). */
const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const metadataOf = (call: Call | undefined) => call?.form?.get('metadata') as string;

afterEach(cleanup);

describe('before the import: only name, size, account, adapter and preset (ui-guide.md §6.5)', () => {
  it('shows the choice without reading the file; the button waits for account and file', () => {
    const { calls } = setup();
    expect(importButton().disabled).toBe(true);
    const steps = screen.getByRole('list', { name: 'Ablauf des Imports' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['1 Datei & Konto', '2 Import ausführen', '3 Ergebnis & Klärfälle']);
    expect(within(steps).getByText('1 Datei & Konto').getAttribute('aria-current')).toBe('step');
    choose();
    const choice = screen.getByRole('region', { name: 'Auswahl' });
    expect(within(choice).getByText('umsaetze-oktober.csv')).toBeTruthy();
    expect(new Blob([VR_CSV]).size).toBe(472);
    expect(within(choice).getByText('472 Bytes')).toBeTruthy();
    expect(within(choice).getByText(`Girokonto Testbank · ${IBAN}`)).toBeTruthy();
    expect(within(choice).getByText('generic-csv, Version 2')).toBeTruthy();
    expect(within(choice).getByText(/^VR-Banking .*\(vr-banking\); Spalten: Buchungstag, /)).toBeTruthy();
    // No local view of the content: nothing of the rows is on the page.
    expect(screen.queryByText(/Miete Oktober/)).toBeNull();
    expect(screen.queryByText(/Dateiinhalt/)).toBeNull();
    expect(importButton().disabled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('with several accounts, nothing is chosen for the user', () => {
    setup({ accounts: [account({ iban: IBAN }), account({ financialAccountId: OTHER, displayName: 'Mietkonto Test', iban: 'DE00 0000 0000 0000 0000 09' })] });
    choose();
    expect(accountSelect().value).toBe('');
    expect(importButton().disabled).toBe(true);
    fireEvent.change(accountSelect(), { target: { value: OTHER } });
    expect(importButton().disabled).toBe(false);
  });

  it('a file over 5 MiB gets the hint and is not sent; 5 MiB exactly can be sent', async () => {
    const { calls } = setup();
    choose(csvFile('gross.csv', new Uint8Array(MAX_IMPORT_FILE_BYTES + 1)));
    expect(screen.getByText(/Die Datei ist größer als 5 MiB \(5\.242\.881 Bytes/)).toBeTruthy();
    expect(importButton().disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: 'Datei importieren' }));
    await settle();
    expect(calls).toHaveLength(0);
    choose(csvFile('genau.csv', new Uint8Array(MAX_IMPORT_FILE_BYTES)));
    expect(screen.queryByText(/größer als 5 MiB/)).toBeNull();
    expect(importButton().disabled).toBe(false);
  });

  it('an account without IBAN cannot take the vr-banking preset: hint, nothing sent; a closed account is said so', () => {
    setup({ accounts: [account({ iban: null })] });
    choose();
    expect(screen.getByText(/hat keine IBAN\. Die Vorlage prüft die IBAN der Datei gegen das Konto/)).toBeTruthy();
    expect(importButton().disabled).toBe(true);
    cleanup();
    setup({ accounts: [account({ iban: IBAN, status: 'CLOSED', closedAt: '2026-09-30T22:00:00.000Z' })] });
    choose();
    expect(screen.getByText(/Das Konto ist geschlossen/)).toBeTruthy();
    expect(importButton().disabled).toBe(false);
  });

  it('no account in the Realm: said so, no form', () => {
    setup({ accounts: [] });
    expect(screen.getByText(/noch kein Finanzkonto/)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });
});

describe('the import (api-design.md §32.1a)', () => {
  it('one multipart POST with the chosen File and exactly the contract metadata; nothing is shown as imported before the answer', async () => {
    let answer: (response: Response) => void = () => undefined;
    const { calls, imported } = setup({ answers: [() => new Promise<Response>((resolve) => (answer = resolve))] });
    const file = csvFile();
    choose(file);
    fireEvent.click(importButton());
    await settle();
    expect(screen.getByRole('status').textContent).toMatch(/Import läuft/);
    expect(
      within(screen.getByRole('list', { name: 'Ablauf des Imports' }))
        .getByText('2 Import ausführen')
        .getAttribute('aria-current'),
    ).toBe('step');
    expect(importButton().disabled).toBe(true);
    expect(imported).toHaveLength(0);
    const call = calls[0];
    expect(call?.headers.has('content-type')).toBe(false);
    expect([...(call?.form?.keys() ?? [])]).toEqual(['metadata', 'file']);
    expect(call?.form?.get('file')).toBe(file);
    expect(JSON.parse(metadataOf(call))).toEqual({ financialAccountId: ACCOUNT, adapterId: 'generic-csv', adapterVersion: '2', preset: 'vr-banking' });
    await act(() => answer(json(201, batch())));
    await settle();
    expect(imported).toEqual([batch()]);
  });

  it('the encoding chosen is sent as an option at the same level; the default is not sent', async () => {
    const { calls } = setup();
    choose();
    fireEvent.change(document.getElementById('import-kodierung') as HTMLSelectElement, { target: { value: 'windows-1252' } });
    fireEvent.click(importButton());
    await settle();
    expect(JSON.parse(metadataOf(calls[0]))).toEqual({
      financialAccountId: ACCOUNT,
      adapterId: 'generic-csv',
      adapterVersion: '2',
      preset: 'vr-banking',
      encoding: 'windows-1252',
    });
  });

  it('a double click sends one request', async () => {
    const { calls } = setup({ answers: [json(201, batch()), json(201, batch())] });
    choose();
    await act(() => {
      fireEvent.click(importButton());
      fireEvent.submit(screen.getByRole('form', { name: 'Datei importieren' }));
      fireEvent.click(importButton());
    });
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('an answer of another Realm is refused: not shown as imported', async () => {
    const { imported } = setup({ answers: [json(201, batch({ mreRealmId: REALM_B }))] });
    choose();
    fireEvent.click(importButton());
    await screen.findByText('Antwort eines anderen Bestands');
    expect(imported).toHaveLength(0);
  });

  it('a late answer after the form is gone changes nothing', async () => {
    let answer: (response: Response) => void = () => undefined;
    const { imported, view } = setup({ answers: [() => new Promise<Response>((resolve) => (answer = resolve))] });
    choose();
    fireEvent.click(importButton());
    await settle();
    view.unmount();
    await act(() => answer(json(201, batch())));
    expect(imported).toHaveLength(0);
  });
});

describe('a lost answer (ui-guide.md §6.5: never claim that nothing was imported)', () => {
  it('no answer: the same File with the same metadata text is offered and sent again; nothing claims an empty import', async () => {
    const { calls, imported } = setup({ answers: [new TypeError('network down'), json(201, batch({ duplicateCount: 1, transactionCount: 0 }))] });
    const file = csvFile();
    choose(file);
    fireEvent.click(importButton());
    await screen.findByText('Keine Antwort');
    expect(document.body.textContent).not.toMatch(/nichts (wurde )?importiert|keine Buchung angelegt/i);
    expect(screen.getByText(/Ob die Datei importiert wurde, ist unklar/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dieselbe Datei erneut senden' }));
    await settle();
    expect(calls).toHaveLength(2);
    expect(metadataOf(calls[1])).toBe(metadataOf(calls[0]));
    expect(calls[1]?.form?.get('file')).toBe(file);
    expect([...(calls[1]?.form?.keys() ?? [])]).toEqual(['metadata', 'file']);
    expect(imported).toHaveLength(1);
  });

  it('a 503 offers the same; a changed choice is a new intent and the offer goes', async () => {
    setup({ answers: [envelope(503, 'SERVICE_UNAVAILABLE', undefined, { 'retry-after': '30' })] });
    choose();
    fireEvent.click(importButton());
    await screen.findByText(/Frühestens in 30 Sekunden/);
    expect(screen.getByRole('button', { name: 'Dieselbe Datei erneut senden' })).toBeTruthy();
    fireEvent.change(document.getElementById('import-kodierung') as HTMLSelectElement, { target: { value: 'windows-1252' } });
    expect(screen.queryByRole('button', { name: 'Dieselbe Datei erneut senden' })).toBeNull();
  });
});

describe('refusals (ui-guide.md §7.4)', () => {
  const refused = async (response: Response) => {
    const result = setup({ answers: [response] });
    choose();
    fireEvent.click(importButton());
    await screen.findByRole('alert');
    return result;
  };

  it('400 IMPORT_ERROR: the reason in German, the server hint, no Transaction created, no resend', async () => {
    await refused(envelope(400, 'IMPORT_ERROR', { reason: 'MISSING_COLUMN' }));
    expect(screen.getByText(/Eine Spalte der Vorlage fehlt in der Datei/)).toBeTruthy();
    expect(screen.getByText('Hinweis des Servers: IMPORT_ERROR message')).toBeTruthy();
    expect(screen.getByText('Die Datei wurde abgelehnt; es wurde keine Buchung angelegt.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Dieselbe Datei erneut senden' })).toBeNull();
  });

  it('INVALID_OPTIONS and an unknown reason are shown with their code', async () => {
    await refused(envelope(400, 'IMPORT_ERROR', { reason: 'INVALID_OPTIONS' }));
    expect(screen.getByText(/Die Importoptionen wurden nicht angenommen/)).toBeTruthy();
    expect(screen.getByText(/Code IMPORT_ERROR/)).toBeTruthy();
    cleanup();
    await refused(envelope(400, 'IMPORT_ERROR', { reason: 'NEW_REASON' }));
    expect(screen.getByText('Grund NEW_REASON.')).toBeTruthy();
  });

  it('413: the size is explained, the file is not split', async () => {
    await refused(envelope(413, 'VALIDATION_ERROR', { maxBytes: MAX_IMPORT_FILE_BYTES }));
    expect(screen.getByText('Zu groß')).toBeTruthy();
    expect(screen.getByText(/höchstens 5 MiB an\. .*nicht automatisch zerlegt/)).toBeTruthy();
  });

  it('422 ACCOUNT_IBAN_MISMATCH: the reason and both IBANs', async () => {
    await refused(
      envelope(422, 'ACCOUNT_IBAN_MISMATCH', { reason: 'ACCOUNT_IBAN_MISMATCH', accountIban: 'DE00000000000000000001', fileIbans: ['DE00000000000000000009'] }),
    );
    expect(screen.getByText('Die Datei gehört zu einem anderen Konto als dem gewählten.')).toBeTruthy();
    expect(screen.getByText('IBAN des Kontos: DE00000000000000000001; IBAN in der Datei: DE00000000000000000009')).toBeTruthy();
  });

  it('field errors: account and file bound to their inputs, all entries in the server order, (body) and metadata included', async () => {
    const fields = [
      { field: 'metadata', code: 'INVALID_FORMAT' },
      { field: 'financialAccountId', code: 'INVALID_FORMAT' },
      { field: '(body)', code: 'NEW_CODE' },
      { field: 'file', code: 'REQUIRED' },
    ];
    await refused(envelope(400, 'VALIDATION_ERROR', { fields }));
    expect(accountSelect().getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(accountSelect().getAttribute('aria-describedby') ?? '')?.textContent).toBe('ungültig oder nicht vorgesehen');
    expect(fileInput().getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(fileInput().getAttribute('aria-describedby') ?? '')?.textContent).toBe('fehlt');
    const summary = screen.getByRole('list', { name: 'Abgelehnte Angaben' });
    expect(
      within(summary)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'metadata: ungültig oder nicht vorgesehen',
      'financialAccountId: ungültig oder nicht vorgesehen',
      'Anfrageinhalt: Code NEW_CODE',
      'file: fehlt',
    ]);
    expect(document.activeElement).toBe(screen.getByRole('alert').parentElement);
  });

  it('an unknown error code is shown with its code, never an empty page', async () => {
    await refused(envelope(418, 'NEW_IMPORT_CODE'));
    expect(screen.getByText('HTTP 418, Code NEW_IMPORT_CODE.')).toBeTruthy();
  });
});
