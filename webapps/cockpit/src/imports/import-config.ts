import type { ImportMetadataDto } from '@vermieter-cockpit/de-backend/client-contract';

/**
 * The client's versioned import configuration (ui-guide.md §6.5: there is no read endpoint for presets; the preset of
 * the reference state is a checked, versioned client configuration, and no preset is invented). Every value here is
 * the backend's: `import-config.test.ts` compares them with the adapter's source (`generic-csv.ts`, `imports.ts`), and
 * the preset name is typed by the backend's own preset table (`ImportPresetName`).
 */
export const IMPORT_ADAPTER = { adapterId: 'generic-csv', adapterVersion: '2' } as const;

/** The presets of `generic-csv` version 2 at the pinned backend (`GENERIC_CSV_PRESETS`, api-design.md §32.5). */
export type ImportPresetName = 'vr-banking';

export interface ImportPreset {
  readonly preset: ImportPresetName;
  readonly label: string;
  /** The columns the preset reads, as the bank names them (shown before the import, never used to read the file). */
  readonly columns: readonly string[];
  /** The preset checks the file's own account against the FinancialAccount's IBAN (`accountIban`, api-design.md §32.5). */
  readonly needsAccountIban: boolean;
}

export const IMPORT_PRESETS: readonly ImportPreset[] = [
  {
    preset: 'vr-banking',
    label: 'VR-Banking (BBBank, Volksbanken, Raiffeisenbanken)',
    columns: [
      'Buchungstag',
      'Valutadatum',
      'Betrag',
      'Waehrung',
      'Name Zahlungsbeteiligter',
      'IBAN Zahlungsbeteiligter',
      'Verwendungszweck',
      'Saldo nach Buchung',
      'IBAN Auftragskonto',
    ],
    needsAccountIban: true,
  },
];

/** The encodings of the adapter's options (`encoding`, api-design.md §32.4). */
export type ImportEncoding = 'utf-8' | 'windows-1252';

/** The encodings of the adapter (`utf-8` is its default and not sent). */
export const IMPORT_ENCODINGS: readonly { readonly value: ImportEncoding; readonly label: string }[] = [
  { value: 'utf-8', label: 'UTF-8 (Standard)' },
  { value: 'windows-1252', label: 'Windows-1252 (ältere Exporte mit Umlauten)' },
];

/** The server's cap of the uploaded file (`MAX_IMPORT_FILE_BYTES`, api-design.md §32.1a): 5 MiB. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
/** The adapter's cap of data rows (`MAX_ROWS`, §32.4); checked by the server only, the client does not read the file. */
export const MAX_IMPORT_ROWS = 10_000;

/** The import's `metadata` part (api-design.md §32.1a): target and adapter, the options at the same level. */
export type ImportMetadata = ImportMetadataDto & { readonly preset: ImportPresetName; readonly encoding?: ImportEncoding };

/**
 * The metadata of one import. Exactly the contract's keys: `financialAccountId`, `adapterId`, `adapterVersion`, the
 * `preset` and, only when it is not the default, `encoding`. Never a `columnMapping` (a preset replaces it, and both
 * together are `INVALID_OPTIONS`).
 */
export function importMetadata(financialAccountId: string, preset: ImportPresetName, encoding: ImportEncoding): ImportMetadata {
  return {
    financialAccountId,
    ...IMPORT_ADAPTER,
    preset,
    ...(encoding === 'utf-8' ? {} : { encoding }),
  };
}

/**
 * One upload as the user decided it: the chosen `File` and the metadata as sent. A retry after a lost answer sends this
 * same object again (ui-guide.md §6.5: the same file with the same account, adapter and options; the server's duplicate
 * detection decides), never a newly read or changed content.
 */
export interface ImportUpload {
  readonly file: File;
  /** The metadata as JSON text, fixed when the user started the import: sent as it is, again on a retry. */
  readonly metadata: string;
  /** The same metadata as values, to check the answer against. */
  readonly sent: ImportMetadata;
}

export function importUpload(file: File, metadata: ImportMetadata): ImportUpload {
  return { file, metadata: JSON.stringify(metadata), sent: metadata };
}

/**
 * The multipart body: exactly one `metadata` text part and one `file` part (api-design.md §32.1a), nothing else. The
 * `File` is appended as it is (no new name, so no copy): the part carries its name and bytes.
 */
export function importForm(upload: ImportUpload): FormData {
  const form = new FormData();
  form.append('metadata', upload.metadata);
  form.append('file', upload.file);
  return form;
}

/** Whether a file is over the server's cap: a hint before sending; the server stays authoritative (`413`). */
export function overSizeLimit(file: Pick<File, 'size'>): boolean {
  return file.size > MAX_IMPORT_FILE_BYTES;
}

const bytes = new Intl.NumberFormat('de-DE');
const oneDecimal = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** `2.345.678 Bytes (2,2 MiB)`: the exact count, and a rounded size for reading (a file size, not money). */
export function formatFileSize(size: number): string {
  const exact = `${bytes.format(size)} ${size === 1 ? 'Byte' : 'Bytes'}`;
  if (size < 1024) return exact;
  const [unit, factor] = size < 1024 * 1024 ? (['KiB', 1024] as const) : (['MiB', 1024 * 1024] as const);
  return `${exact} (${oneDecimal.format(size / factor)} ${unit})`;
}
