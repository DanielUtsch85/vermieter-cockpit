// @vitest-environment jsdom
import { act as testingLibraryAct, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Confirmed, ReversalResultDto } from '../../api/transactions';
import { correctionAnswer, detail, REALM_A, reversalAnswer, split, transaction } from '../../transactions/fixtures.test-support';
import { technicalBlocks, visibleText } from '../technical.test-support';
import { ConfirmAction } from './ConfirmAction';
import { CorrectionResult } from './CorrectionResult';
import { ReverseForm } from './ReverseForm';

/**
 * Entscheidung des Projektinhabers, 2026-11-13: „#355 F3, Versionsnummern in Erfolgs- und Rückfragetexten: aus dem
 * Sichtbereich, die Version steht in „Technische Angaben“.“ The confirmation steps and the answers say no „Version“
 * outside a block „Technische Angaben“; the answers keep the version there. The `If-Match` sent is unchanged (jsdom,
 * `fireEvent` only; the headers on the wire are asserted by the component and Durchstich tests).
 */

const act = testingLibraryAct as unknown as (callback: () => void | Promise<void>) => Promise<void>;
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const CLASSIFIED = detail({ status: 'CLASSIFIED', version: 4, splits: [split({ amount: { amount: '850.00', currency: 'EUR' } })] });
const CONFIRMED = detail({ status: 'CONFIRMED', version: 4, splits: [split({ amount: { amount: '850.00', currency: 'EUR' } })] });
const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name });
const technicalText = (root: ParentNode) =>
  technicalBlocks(root)
    .map((details) => details.textContent ?? '')
    .join(' | ');

afterEach(cleanup);

describe('no version number in the visible confirmation and success texts', () => {
  it('Buchung bestaetigen: the step and the answer say no Version; the answer keeps it in Technische Angaben', async () => {
    const sent: string[] = [];
    const answer: Confirmed = { transaction: transaction({ status: 'CONFIRMED', version: 5 }), etag: '"5"' };
    render(
      <ConfirmAction
        transaction={CLASSIFIED}
        etag={'"4"'}
        stale={false}
        confirm={(ifMatch) => {
          sent.push(ifMatch);
          return Promise.resolve(answer);
        }}
        onConfirmed={() => undefined}
        reload={() => undefined}
      />,
    );
    fireEvent.click(button('Buchung bestätigen'));
    const dialog = screen.getByRole('dialog', { name: 'Buchung jetzt bestätigen?' });
    expect(dialog.textContent).toContain('Bestätigt wird die gespeicherte Aufteilung. Danach sind Betrag, Datum, Konto und Aufteilung unveränderlich');
    expect(visibleText(document.body)).not.toMatch(/Version/);
    fireEvent.click(button('Jetzt bestätigen'));
    await settle();
    expect(sent).toEqual(['"4"']);
    const status = screen.getByRole('status');
    expect(visibleText(status)).toBe('Buchung bestätigt (Status „Bestätigt“). Die Aufteilung ist jetzt unveränderlich.');
    expect(visibleText(document.body)).not.toMatch(/Version/);
    expect(technicalText(status)).toBe('Technische AngabenVersion5 (ETag "5")');
  });

  it('Stornieren: the step says no Version; the answer keeps the versions of the chain in Technische Angaben', async () => {
    const sent: string[] = [];
    const answer: ReversalResultDto = reversalAnswer();
    render(
      <ReverseForm
        realmId={REALM_A}
        transaction={CONFIRMED}
        etag={'"4"'}
        stale={false}
        reverse={(_body, ifMatch) => {
          sent.push(ifMatch);
          return Promise.resolve(answer);
        }}
        onReversed={() => undefined}
        reload={() => undefined}
        newKey={() => 'absicht-1'}
      />,
    );
    fireEvent.click(button('Stornieren'));
    fireEvent.change(document.getElementById('storno-reason') as HTMLTextAreaElement, { target: { value: 'Doppelt erfasst' } });
    fireEvent.click(button('Storno ausführen'));
    const dialog = screen.getByRole('dialog', { name: 'Buchung jetzt stornieren?' });
    expect(dialog.textContent).toContain('DE legt eine Gegenbuchung an, die Buchung wird „Korrigiert/storniert“ und zählt nicht mehr.');
    expect(visibleText(document.body)).not.toMatch(/Version/);
    fireEvent.click(button('Jetzt stornieren'));
    await settle();
    expect(sent).toEqual(['"4"']);
    const result = screen.getByRole('region', { name: 'Storno ausgeführt' });
    expect(visibleText(result)).not.toMatch(/Version/);
    expect(technicalText(result)).toBe(`Technische AngabenVersion Original${answer.original.version}Version Storno${answer.reversal.version}`);
  });

  it('Korrektur ausgefuehrt: the chain says no Version; the three versions are in Technische Angaben', () => {
    const answer = correctionAnswer({ version: 7 });
    render(<CorrectionResult realmId={REALM_A} result={answer} />);
    const result = screen.getByRole('region', { name: 'Korrektur ausgeführt' });
    expect(visibleText(result)).not.toMatch(/Version/);
    expect(technicalText(result)).toBe(
      `Technische AngabenVersion Original${answer.original.version}Version Storno${answer.reversal.version}Version Ersatzbuchung7`,
    );
  });
});
