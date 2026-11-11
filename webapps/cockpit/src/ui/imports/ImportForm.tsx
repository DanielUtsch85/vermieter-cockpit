import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, partitionFieldErrors } from '../../api/errors';
import type { ImportBatchDto } from '../../api/imports';
import type { FinancialAccountDto, PageDto } from '../../api/transactions';
import {
  formatFileSize,
  IMPORT_ADAPTER,
  IMPORT_ENCODINGS,
  IMPORT_PRESETS,
  importMetadata,
  importUpload,
  overSizeLimit,
  type ImportEncoding,
  type ImportUpload,
} from '../../imports/import-config';
import { describeFieldError } from '../error-text';
import { buttonClass, ErrorState, isRetryable, Notice, secondaryButtonClass } from '../states';
import { importRefusalText } from './import-labels';
import { ImportSteps } from './ImportSteps';

type Stage =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  /** `retry`: the upload whose outcome is unknown, offered again unchanged. */
  | { readonly kind: 'failed'; readonly error: unknown; readonly retry: ImportUpload | undefined };

const FIELD_INPUTS = { financialAccountId: 'import-konto', file: 'import-datei' } as const;

const selectClass = 'min-h-touch rounded-input border border-border bg-surface px-3';

/**
 * Steps 1 and 2 of the import (ui-guide.md §6.5): choose file, account and preset, then run the import. Before it only
 * the file's name and size, the account, adapter, version and preset are shown; the file is never read here (no local
 * view, no duplicate guess: the result after the import is the review). One click is one `POST`; nothing is shown as
 * imported before the server's answer (§7.3). A lost answer never says that nothing was imported: it offers the same
 * upload again, which the server deduplicates.
 */
export function ImportForm(props: {
  readonly accounts: PageDto<FinancialAccountDto>;
  readonly upload: (upload: ImportUpload) => Promise<ImportBatchDto>;
  readonly onImported: (batch: ImportBatchDto) => void;
}) {
  const accounts = props.accounts.items;
  const [accountId, setAccountId] = useState(accounts.length === 1 ? (accounts[0]?.financialAccountId ?? '') : '');
  const [presetName, setPresetName] = useState(IMPORT_PRESETS[0]?.preset);
  const [encoding, setEncoding] = useState<ImportEncoding>('utf-8');
  const [file, setFile] = useState<File | undefined>(undefined);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const problem = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (stage.kind === 'failed') problem.current?.focus();
  }, [stage]);

  const account = accounts.find((candidate) => candidate.financialAccountId === accountId);
  const preset = IMPORT_PRESETS.find((candidate) => candidate.preset === presetName);
  const tooLarge = file !== undefined && overSizeLimit(file);
  const ibanMissing = account !== undefined && preset?.needsAccountIban === true && account.iban === null;
  const ready = account !== undefined && preset !== undefined && file !== undefined && !tooLarge && !ibanMissing;

  const send = (upload: ImportUpload) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStage({ kind: 'sending' });
    props
      .upload(upload)
      .then(
        (batch) => {
          if (mounted.current) props.onImported(batch);
        },
        (error: unknown) => {
          if (mounted.current) setStage({ kind: 'failed', error, retry: isRetryable(error) ? upload : undefined });
        },
      )
      .finally(() => {
        inFlight.current = false;
      });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || stage.kind === 'sending') return;
    send(importUpload(file, importMetadata(account.financialAccountId, preset.preset, encoding)));
  };
  // A changed choice is a new intent: the offer to send the earlier upload again goes (ui-guide.md §7.3).
  const changed = () => setStage({ kind: 'idle' });

  const error = stage.kind === 'failed' ? stage.error : undefined;
  const { known } = partitionFieldErrors(error instanceof ApiError ? error.fields : [], Object.keys(FIELD_INPUTS));
  const fieldError = (name: keyof typeof FIELD_INPUTS) => known.find((entry) => entry.pattern === name);
  const invalid = (name: keyof typeof FIELD_INPUTS) =>
    fieldError(name) === undefined ? {} : { 'aria-invalid': true, 'aria-describedby': `${FIELD_INPUTS[name]}-fehler` };
  const fieldText = (name: keyof typeof FIELD_INPUTS) => {
    const entry = fieldError(name);
    return entry === undefined ? null : (
      <p id={`${FIELD_INPUTS[name]}-fehler`} className="text-danger-text">
        {describeFieldError(entry).text}
      </p>
    );
  };

  if (accounts.length === 0) {
    return (
      <p className="rounded-card border border-border bg-surface p-6 text-muted">
        In diesem Bestand gibt es noch kein Finanzkonto. Ohne Konto ist kein Import möglich.
      </p>
    );
  }

  return (
    <>
      <ImportSteps current={stage.kind === 'sending' ? 2 : 1} />
      <form aria-label="Datei importieren" className="flex flex-col gap-4 rounded-card border border-border bg-surface p-6" onSubmit={submit} noValidate>
        <p className="text-muted">
          Es gibt keine Vorschau vor dem Import: das Ergebnis mit den Klärfällen ist die Prüfansicht. Ein zweiter Import derselben Datei legt keine Buchung
          doppelt an.
        </p>
        <div className="flex flex-col gap-1">
          <label htmlFor="import-konto" className="font-semibold">
            Konto
          </label>
          <select
            id="import-konto"
            className={selectClass}
            value={accountId}
            disabled={stage.kind === 'sending'}
            onChange={(event) => {
              setAccountId(event.target.value);
              changed();
            }}
            {...invalid('financialAccountId')}
          >
            <option value="">Bitte wählen</option>
            {accounts.map((candidate) => (
              <option key={candidate.financialAccountId} value={candidate.financialAccountId}>
                {`${candidate.displayName}${candidate.iban === null ? '' : ` · ${candidate.iban}`}${candidate.status === 'OPEN' ? '' : ' (geschlossen)'}`}
              </option>
            ))}
          </select>
          {fieldText('financialAccountId')}
          {props.accounts.total > accounts.length && (
            <p className="text-label text-muted">{`Gezeigt werden ${accounts.length} von ${props.accounts.total} Konten.`}</p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="import-vorlage" className="font-semibold">
            Vorlage
          </label>
          <select
            id="import-vorlage"
            className={selectClass}
            value={presetName}
            disabled={stage.kind === 'sending'}
            onChange={(event) => {
              setPresetName(IMPORT_PRESETS.find((candidate) => candidate.preset === event.target.value)?.preset);
              changed();
            }}
          >
            {IMPORT_PRESETS.map((candidate) => (
              <option key={candidate.preset} value={candidate.preset}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="import-kodierung" className="font-semibold">
            Zeichenkodierung
          </label>
          <select
            id="import-kodierung"
            className={selectClass}
            value={encoding}
            disabled={stage.kind === 'sending'}
            onChange={(event) => {
              setEncoding(IMPORT_ENCODINGS.find((candidate) => candidate.value === event.target.value)?.value ?? 'utf-8');
              changed();
            }}
          >
            {IMPORT_ENCODINGS.map((candidate) => (
              <option key={candidate.value} value={candidate.value}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="import-datei" className="font-semibold">
            CSV-Datei
          </label>
          <input
            id="import-datei"
            type="file"
            accept=".csv,text/csv"
            disabled={stage.kind === 'sending'}
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              changed();
            }}
            {...invalid('file')}
          />
          {fieldText('file')}
          <p className="text-label text-muted">Höchstens 5 MiB und 10.000 Zeilen; die Zeilen zählt der Server.</p>
        </div>

        <section aria-labelledby="import-auswahl">
          <h2 id="import-auswahl" className="text-section font-semibold">
            Auswahl
          </h2>
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[12rem_1fr]">
            <dt className="text-muted">Datei</dt>
            <dd>{file === undefined ? 'Noch keine Datei gewählt' : file.name}</dd>
            <dt className="text-muted">Größe</dt>
            <dd className="tabular-nums">{file === undefined ? 'Nicht verfügbar' : formatFileSize(file.size)}</dd>
            <dt className="text-muted">Konto</dt>
            <dd>
              {account === undefined ? 'Noch kein Konto gewählt' : `${account.displayName}${account.iban === null ? ' (ohne IBAN)' : ` · ${account.iban}`}`}
            </dd>
            <dt className="text-muted">Adapter</dt>
            <dd>{`${IMPORT_ADAPTER.adapterId}, Version ${IMPORT_ADAPTER.adapterVersion}`}</dd>
            <dt className="text-muted">Vorlage</dt>
            <dd>{preset === undefined ? 'Keine' : `${preset.label} (${preset.preset}); Spalten: ${preset.columns.join(', ')}`}</dd>
          </dl>
        </section>

        {tooLarge && (
          <Notice tone="warning">{`Die Datei ist größer als 5 MiB (${formatFileSize(file.size)}). Der Server nimmt sie nicht an; bitte den Export in kürzere Zeiträume teilen.`}</Notice>
        )}
        {ibanMissing && (
          <Notice tone="warning">
            {`Das Konto „${account.displayName}“ hat keine IBAN. Die Vorlage prüft die IBAN der Datei gegen das Konto, der Server lehnt den Import daher ab (ACCOUNT_HAS_NO_IBAN).`}
          </Notice>
        )}
        {account !== undefined && account.status !== 'OPEN' && (
          <Notice tone="info">Das Konto ist geschlossen: Buchungen bis einschließlich zum Schließtag werden übernommen, spätere als Fehler gemeldet.</Notice>
        )}

        {stage.kind === 'failed' && (
          <div ref={problem} tabIndex={-1}>
            <ErrorState error={stage.error}>
              {importRefusalText(stage.error).map((line) => (
                <p key={line} className="mt-2">
                  {line}
                </p>
              ))}
              {stage.retry !== undefined && (
                <div className="mt-3 flex flex-col gap-3">
                  <p>
                    {`Ob die Datei importiert wurde, ist unklar; es können bereits Buchungen angelegt sein. „Dieselbe Datei erneut senden“ schickt genau diese Datei (${stage.retry.file.name}) mit demselben Konto, Adapter und denselben Optionen. Schon eingelesene Zeilen erkennt der Server und legt sie nicht noch einmal an; sie erscheinen im Ergebnis als Duplikate.`}
                  </p>
                  <div>
                    <button type="button" className={secondaryButtonClass} onClick={() => stage.retry !== undefined && send(stage.retry)}>
                      Dieselbe Datei erneut senden
                    </button>
                  </div>
                </div>
              )}
            </ErrorState>
          </div>
        )}
        {stage.kind === 'sending' && <p role="status">Import läuft … Die Datei wird übertragen und vom Server geprüft.</p>}
        <div>
          <button type="submit" className={buttonClass} disabled={!ready || stage.kind === 'sending'}>
            {stage.kind === 'sending' ? 'Import läuft …' : 'Import ausführen'}
          </button>
        </div>
      </form>
    </>
  );
}
