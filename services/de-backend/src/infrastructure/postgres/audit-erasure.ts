import type { Kysely } from 'kysely';
import { AUDIT_PSEUDONYMISABLE_ACTION, auditRetentionEndsOn, berlinYear, isAuditRecordDue, pseudonymiseAuditMetadata } from '../../domains/audit/index.js';
import { pseudonymiseAuditRecord } from './audit-retention.js';
import type { Database } from './schema.js';

/**
 * VC-X-24 (api-design.md §58U rule 8; docs/development/betrieb.md §12 „Löschung auf Antrag“): the operator's procedure for a
 * deletion request (Art. 17 DSGVO) against the history of one Party, run by `scripts/ops/audit-erasure.sh` through
 * `dist/audit-erasure.js` inside the de-backend container. Read-only by default (`--dry-run`): it lists every `AMENDED`
 * record of the Party with its creation year, the end of its retention, `pseudonymised_at` and the paths that would
 * change. `--apply` pseudonymises the records whose retention has ended, by the job's own write (`basis:
 * "ERASURE_REQUEST"`); a record within retention is listed and kept (§ 147 AO, Art. 17 Abs. 3 lit. b DSGVO). The Realm is
 * derived from the Party's row (`party.mre_realm_id`; `audit_record` has none): a Party of another Realm is not found.
 * The request itself is filed outside the repository and the database.
 */
export type ErasureState = 'WITHIN_RETENTION' | 'DUE' | 'PSEUDONYMISED_NOW' | 'ALREADY_PSEUDONYMISED' | 'NO_PERSONAL_VALUE';

export interface ErasureRecord {
  readonly auditRecordId: string;
  readonly occurredAt: string;
  readonly creationYear: number;
  readonly retentionEndsOn: string;
  readonly pseudonymisedAt: string | null;
  readonly paths: readonly string[];
  readonly state: ErasureState;
}

export type ErasureOutcome =
  | { readonly kind: 'PARTY_NOT_FOUND' }
  | { readonly kind: 'LISTED'; readonly applied: boolean; readonly records: readonly ErasureRecord[]; readonly pseudonymised: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REALM = /^[0-9a-f]{24}$/;

export async function auditErasure(
  db: Kysely<Database>,
  request: { readonly mreRealmId: string; readonly partyId: string; readonly apply: boolean; readonly now: Date },
): Promise<ErasureOutcome> {
  if (!UUID.test(request.partyId) || !REALM.test(request.mreRealmId)) return { kind: 'PARTY_NOT_FOUND' };
  return db.transaction().execute(async (trx): Promise<ErasureOutcome> => {
    const party = await trx
      .selectFrom('party')
      .select('id')
      .where('id', '=', request.partyId)
      .where('mre_realm_id', '=', request.mreRealmId)
      .executeTakeFirst();
    if (party === undefined) return { kind: 'PARTY_NOT_FOUND' };
    const query = trx
      .selectFrom('audit_record')
      .select(['id', 'entity_type', 'entity_id', 'occurred_at', 'metadata', 'pseudonymised_at'])
      .where('entity_type', '=', 'Party')
      .where('entity_id', '=', party.id)
      .where('action', '=', AUDIT_PSEUDONYMISABLE_ACTION)
      .orderBy('occurred_at')
      .orderBy('id');
    const rows = await (request.apply ? query.forUpdate() : query).execute();
    const records: ErasureRecord[] = [];
    let pseudonymised = 0;
    for (const row of rows) {
      let state: ErasureState;
      let paths = pseudonymiseAuditMetadata(row.entity_type, row.metadata)?.paths ?? [];
      let pseudonymisedAt = row.pseudonymised_at;
      if (row.pseudonymised_at !== null) state = 'ALREADY_PSEUDONYMISED';
      else if (paths.length === 0) state = 'NO_PERSONAL_VALUE';
      else if (!isAuditRecordDue(row.occurred_at, request.now)) state = 'WITHIN_RETENTION';
      else if (!request.apply) state = 'DUE';
      else {
        paths = (await pseudonymiseAuditRecord(trx, row, request.now, 'ERASURE_REQUEST')) ?? [];
        state = 'PSEUDONYMISED_NOW';
        pseudonymisedAt = request.now;
        pseudonymised += 1;
      }
      records.push({
        auditRecordId: row.id,
        occurredAt: row.occurred_at.toISOString(),
        creationYear: berlinYear(row.occurred_at),
        retentionEndsOn: auditRetentionEndsOn(row.occurred_at),
        pseudonymisedAt: pseudonymisedAt === null ? null : pseudonymisedAt.toISOString(),
        paths,
        state,
      });
    }
    return { kind: 'LISTED', applied: request.apply, records, pseudonymised };
  });
}

const STATE_TEXT: Record<ErasureState, string> = {
  WITHIN_RETENTION: 'innerhalb der Aufbewahrung, bleibt',
  DUE: 'Aufbewahrung abgelaufen, würde ersetzt',
  PSEUDONYMISED_NOW: 'Aufbewahrung abgelaufen, jetzt ersetzt',
  ALREADY_PSEUDONYMISED: 'schon pseudonymisiert',
  NO_PERSONAL_VALUE: 'ohne personenbezogenen Wert',
};

/**
 * The command line: `<mreRealmId> <partyId> [--dry-run|--apply]`, `--dry-run` by default. Writes one line per record and
 * a summary; answers the exit status (0 listed, 1 Party not found, 2 wrong call). Ids and dates only, no value.
 */
export async function runAuditErasureCli(
  argv: readonly string[],
  deps: { readonly db: Kysely<Database>; readonly now: Date; readonly out: (line: string) => void; readonly err: (line: string) => void },
): Promise<number> {
  const [mreRealmId, partyId, mode = '--dry-run', ...rest] = argv;
  if (mreRealmId === undefined || partyId === undefined || rest.length > 0 || (mode !== '--dry-run' && mode !== '--apply')) {
    deps.err('Aufruf: audit-erasure <mreRealmId> <partyId> [--dry-run|--apply]');
    return 2;
  }
  const outcome = await auditErasure(deps.db, { mreRealmId, partyId, apply: mode === '--apply', now: deps.now });
  if (outcome.kind === 'PARTY_NOT_FOUND') {
    deps.err(`Partei ${partyId} im Realm ${mreRealmId} nicht gefunden`);
    return 1;
  }
  for (const r of outcome.records) {
    deps.out(
      [
        r.auditRecordId,
        r.occurredAt,
        `Jahr ${r.creationYear}`,
        `Aufbewahrung bis ${r.retentionEndsOn}`,
        `pseudonymisiert ${r.pseudonymisedAt ?? '-'}`,
        STATE_TEXT[r.state],
        r.paths.length === 0 ? '-' : r.paths.join(','),
      ].join(' | '),
    );
  }
  const within = outcome.records.filter((r) => r.state === 'WITHIN_RETENTION');
  const latest = within
    .map((r) => r.retentionEndsOn)
    .sort()
    .at(-1);
  deps.out(
    `${outcome.applied ? 'angewendet' : 'Probelauf (nichts geschrieben)'}: ${outcome.records.length} Datensatz/Datensätze, ` +
      `${outcome.pseudonymised} jetzt pseudonymisiert, ${within.length} innerhalb der Aufbewahrung` +
      (latest === undefined ? '' : ` (längste bis ${latest})`),
  );
  return 0;
}
