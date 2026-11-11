import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VR_CSV } from './fixtures.test-support';
import {
  formatFileSize,
  IMPORT_ADAPTER,
  IMPORT_ENCODINGS,
  IMPORT_PRESETS,
  importForm,
  importMetadata,
  importUpload,
  MAX_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  overSizeLimit,
} from './import-config';

/**
 * The client's import configuration against the backend's source (ui-guide.md §6.5: a checked, versioned client
 * configuration, no invented preset). The backend modules are loaded here, in the test only: the bundle takes types from
 * `client-contract.ts` and nothing else of the backend (the build check in the PR).
 */
const backend = (path: string) => fileURLToPath(new URL(`../../../../services/de-backend/src/${path}`, import.meta.url));

type StatementResult = { statement?: { rows: { kind: string; row?: Record<string, unknown> }[] }; error?: { code: string } };
type Adapter = { id: string; version: string; parse(file: Uint8Array, options: unknown, currency: string): StatementResult };
interface AdapterModule {
  GENERIC_CSV_ID: string;
  GENERIC_CSV_VERSION_2: string;
  GENERIC_CSV_PRESETS: Record<string, Record<string, string>>;
  MAX_ROWS: number;
  findBankStatementAdapter(id: string, version: string): Adapter | undefined;
}

const adapters = (await import(/* @vite-ignore */ backend('integrations/bank-import/index.ts'))) as AdapterModule;
const routes = (await import(/* @vite-ignore */ backend('api/imports.ts'))) as {
  MAX_IMPORT_FILE_BYTES: number;
  metadataSchema: { safeParse(value: unknown): { success: boolean } };
};

const adapter = adapters.findBankStatementAdapter(IMPORT_ADAPTER.adapterId, IMPORT_ADAPTER.adapterVersion);
const bytes = (text: string) => new TextEncoder().encode(text);
/** The adapter's options of a metadata object: everything but target and adapter (api-design.md §32.1a). */
function optionsOf(metadata: Record<string, unknown>) {
  const { financialAccountId: _a, adapterId: _b, adapterVersion: _c, ...options } = metadata;
  return options;
}

describe('the import configuration is that of the backend (generic-csv v2, api-design.md §32.5)', () => {
  it('adapter id and version name a registered adapter', () => {
    expect(IMPORT_ADAPTER).toEqual({ adapterId: adapters.GENERIC_CSV_ID, adapterVersion: adapters.GENERIC_CSV_VERSION_2 });
    expect(adapter).toBeDefined();
  });

  it('every preset of the client is a preset of the backend, with its columns and its account check', () => {
    expect(IMPORT_PRESETS.length).toBeGreaterThan(0);
    for (const preset of IMPORT_PRESETS) {
      const mapping = adapters.GENERIC_CSV_PRESETS[preset.preset];
      expect(mapping, preset.preset).toBeDefined();
      expect([...preset.columns].sort()).toEqual(Object.values(mapping ?? {}).sort());
      expect(preset.needsAccountIban).toBe(Object.hasOwn(mapping ?? {}, 'accountIban'));
    }
  });

  it('counter-check: an invented preset is refused by the backend adapter (INVALID_OPTIONS)', () => {
    expect(adapters.GENERIC_CSV_PRESETS['sparkasse']).toBeUndefined();
    expect(adapter?.parse(bytes(VR_CSV), { preset: 'sparkasse' }, 'EUR').error?.code).toBe('INVALID_OPTIONS');
  });

  it('the limits are those of the server: 5 MiB per file, 10,000 rows', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(routes.MAX_IMPORT_FILE_BYTES);
    expect(MAX_IMPORT_FILE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_IMPORT_ROWS).toBe(adapters.MAX_ROWS);
  });

  it('the metadata the client sends passes the route schema and the adapter reads the synthetic file with it', () => {
    for (const { value: encoding } of IMPORT_ENCODINGS) {
      const metadata = importMetadata('0b8f2c1e-3d4a-4b5c-8d6e-7f8091a2b3c4', 'vr-banking', encoding);
      expect(routes.metadataSchema.safeParse(metadata).success).toBe(true);
      const result = adapter?.parse(bytes(VR_CSV), optionsOf(metadata), 'EUR');
      expect(result?.error, encoding).toBeUndefined();
      expect(result?.statement?.rows.map((row) => row.kind)).toEqual(['ROW', 'ROW']);
    }
  });

  it('counter-check: preset and columnMapping together are refused, so the client never sends both', () => {
    const metadata = importMetadata('0b8f2c1e-3d4a-4b5c-8d6e-7f8091a2b3c4', 'vr-banking', 'utf-8');
    expect(Object.keys(metadata)).not.toContain('columnMapping');
    const both = { ...optionsOf(metadata), columnMapping: { bookingDate: 'Buchungstag', amount: 'Betrag' } };
    expect(adapter?.parse(bytes(VR_CSV), both, 'EUR').error?.code).toBe('INVALID_OPTIONS');
  });
});

describe('metadata and form of one upload (api-design.md §32.1a)', () => {
  it('the metadata has exactly the contract keys; the default encoding is not sent', () => {
    expect(importMetadata('acc', 'vr-banking', 'utf-8')).toEqual({
      financialAccountId: 'acc',
      adapterId: 'generic-csv',
      adapterVersion: '2',
      preset: 'vr-banking',
    });
    expect(importMetadata('acc', 'vr-banking', 'windows-1252')).toEqual({
      financialAccountId: 'acc',
      adapterId: 'generic-csv',
      adapterVersion: '2',
      preset: 'vr-banking',
      encoding: 'windows-1252',
    });
  });

  it('the form has exactly one metadata part (the JSON as fixed) and one file part (the chosen File)', () => {
    const file = new File([VR_CSV], 'umsaetze.csv', { type: 'text/csv' });
    const upload = importUpload(file, importMetadata('acc', 'vr-banking', 'utf-8'));
    const form = importForm(upload);
    expect([...form.keys()]).toEqual(['metadata', 'file']);
    expect(form.getAll('metadata')).toEqual([upload.metadata]);
    expect(JSON.parse(upload.metadata)).toEqual(upload.sent);
    expect(form.get('file')).toBe(file);
  });

  it('the size hint: over 5 MiB is over the limit, 5 MiB exactly is not', () => {
    expect(overSizeLimit({ size: MAX_IMPORT_FILE_BYTES })).toBe(false);
    expect(overSizeLimit({ size: MAX_IMPORT_FILE_BYTES + 1 })).toBe(true);
    expect(formatFileSize(1)).toBe('1 Byte');
    expect(formatFileSize(512)).toBe('512 Bytes');
    expect(formatFileSize(2048)).toBe('2.048 Bytes (2,0 KiB)');
    expect(formatFileSize(MAX_IMPORT_FILE_BYTES + 1)).toBe('5.242.881 Bytes (5,0 MiB)');
  });
});
