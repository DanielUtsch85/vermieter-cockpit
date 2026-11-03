import { describe, expect, it } from 'vitest';
import { Money, RuleRegistry, type BusinessDate } from '../../shared/index.js';
import { attributionChanges, changeFingerprint, type AttributionInput } from './attribution-changes.js';
import { closingYear, depositClosingChanges, replayClosing, type DepositClosingHistory, type DepositClosingState } from './attribution-reopen.js';
import { CHANGE_KINDS, DEPOSIT_YEAR_KINDS } from './attribution-rule.js';
import { testFingerprinter as fingerprinter } from './fingerprinter.test-support.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';
import { planAcknowledgement } from './tax-statements.js';

/**
 * §58I Part 1 (VC-X-50), pure: a deposit reopened and closed anew as the kinds `DEPOSIT_REOPENED`, `DEPOSIT_CLOSED` of
 * `ATTRIBUTION_INPUT_CHANGED` (Entscheidung des Projektinhabers, 2026-11-03, §58I Fragen 1–3: each record alone, a year
 * `null` for "in no year", the first closing after the year's end flagged, no source type in the year item). Example
 * (a) with its numbers: D held 900.00, 600.00 repaid, closed on 2027-12-20 `RETAINED` with 300.00, reopened on
 * 2028-02-12, a repayment of 50.00 on 2028-01-10, closed again on 2028-02-14 with 2028-01-10 and 250.00. Synthetic only.
 */
const TAX_RULES = new RuleRegistry(TAXATION_RULE_VERSIONS);
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const P1 = '0000e50a-0000-4000-8000-000000000001';
const D = '0000e50b-0000-4000-8000-000000000001';
const T = '6512f0c2a1b2c3d4e5f6e50a';
const CTX = { propertyReferenceId: P1, fingerprinter };
const closing = (closingDate: string, held: string, reason = 'RETAINED'): DepositClosingState => ({
  closingDate: day(closingDate),
  reason,
  heldAtClosing: eur(held),
});
const FIRST = closing('2027-12-20', '300.00');
const SECOND = closing('2028-01-10', '250.00');
const rec = (auditRecordId: string, action: string, iso: string, c: DepositClosingState | null = null) => ({
  auditRecordId,
  action,
  occurredAt: new Date(iso),
  closing: c,
});
const created = rec('c-0', 'CREATED', '2027-01-05T10:00:00Z');
const closed1 = rec('c-1', 'CLOSED', '2027-12-20T10:00:00Z', FIRST);
const reopened = rec('c-2', 'REOPENED', '2028-02-12T10:00:00Z', FIRST);
const closed2 = rec('c-3', 'CLOSED', '2028-02-14T10:00:00Z', SECOND);

const deposit = (records: DepositClosingHistory['records'], now: DepositClosingState | null): DepositClosingHistory => ({
  securityDepositId: D,
  mreTenantId: T,
  status: now === null ? 'ACTIVE' : 'CLOSED',
  closing: now,
  records,
});
const changesOf = (d: DepositClosingHistory, year: number) => attributionChanges({ references: [], candidates: [], deposits: [d] }, year, TAX_RULES, CTX);
const summary = (d: DepositClosingHistory, year: number) => changesOf(d, year).changes.map((c) => [c.kind, c.auditRecordId, c.items]);

describe('a deposit reopened and closed anew (§58I Part 1)', () => {
  it('example (a): 2027 flagged by the reopen only (2027 to null), the CLOSED record (null to 2028) touches no side of 2027; 2028 not flagged', () => {
    const d = deposit([created, closed1, reopened, closed2], SECOND);
    const c27 = changesOf(d, 2027);
    expect(c27.changes).toEqual([
      expect.objectContaining({
        kind: 'DEPOSIT_REOPENED',
        entityType: 'SecurityDeposit',
        entityId: D,
        auditRecordId: 'c-2',
        amendedAt: new Date('2028-02-12T10:00:00Z'),
        keys: { securityDepositId: D, mreTenantId: T, closingDate: '2027-12-20', reason: 'RETAINED' },
        items: [{ sourceId: D, yearBefore: 2027, yearAfter: null }],
      }),
    ]);
    expect(c27.inconsistent).toEqual([]);
    // 2028: the CLOSED record was made during 2028, before its end.
    expect(changesOf(d, 2028).changes).toEqual([]);
    // The retained amounts of the two closings: 300.00 and 250.00, in 2027 and 2028.
    expect([closingYear(FIRST), closingYear(SECOND), closingYear(null)]).toEqual([2027, 2028, null]);
  });

  it('the 31-December rule on the record: a reopen on 31 December of the year is not flagged, on 1 January it is', () => {
    const on = (iso: string) => summary(deposit([created, closed1, { ...reopened, occurredAt: new Date(iso) }, closed2], SECOND), 2027);
    // Europe/Berlin: 2027-12-31T22:59Z is still 31 December; 23:00Z is 1 January.
    expect(on('2027-12-31T22:59:00Z')).toEqual([]);
    expect(on('2028-01-01T08:00:00Z')).toEqual([['DEPOSIT_REOPENED', 'c-2', [{ sourceId: D, yearBefore: 2027, yearAfter: null }]]]);
  });

  it('a reopen never followed by a closing flags the year it leaves at once (null after)', () => {
    expect(summary(deposit([created, closed1, reopened], null), 2027)).toEqual([
      ['DEPOSIT_REOPENED', 'c-2', [{ sourceId: D, yearBefore: 2027, yearAfter: null }]],
    ]);
  });

  it('variant, a reopen by mistake: closed again with 2027-12-20 and 300.00, two entries of 2027 (2027 to null, null to 2027)', () => {
    const again = rec('c-3', 'CLOSED', '2028-02-14T10:00:00Z', FIRST);
    expect(summary(deposit([created, closed1, reopened, again], FIRST), 2027)).toEqual([
      ['DEPOSIT_REOPENED', 'c-2', [{ sourceId: D, yearBefore: 2027, yearAfter: null }]],
      ['DEPOSIT_CLOSED', 'c-3', [{ sourceId: D, yearBefore: null, yearAfter: 2027 }]],
    ]);
    // The DEPOSIT_CLOSED entry keys the record's closing: the new one.
    expect(changesOf(deposit([created, closed1, reopened, again], FIRST), 2027).changes[1]?.keys).toMatchObject({ closingDate: '2027-12-20' });
  });

  it('variant, the same year with another amount: 250.00 on 2027-12-20, both records are entries of 2027', () => {
    const other = closing('2027-12-20', '250.00');
    const d = deposit([created, closed1, reopened, rec('c-3', 'CLOSED', '2028-02-14T10:00:00Z', other)], other);
    expect(summary(d, 2027).map(([kind]) => kind)).toEqual(['DEPOSIT_REOPENED', 'DEPOSIT_CLOSED']);
  });

  it('a first closing recorded after the year s end is flagged, null to the year (§58I Frage 2); recorded in the year it is not', () => {
    const late = rec('c-1', 'CLOSED', '2028-01-15T10:00:00Z', FIRST);
    expect(summary(deposit([created, late], FIRST), 2027)).toEqual([['DEPOSIT_CLOSED', 'c-1', [{ sourceId: D, yearBefore: null, yearAfter: 2027 }]]]);
    expect(summary(deposit([created, closed1], FIRST), 2027)).toEqual([]);
  });

  it('RETURNED or nothing retained on both sides moves nothing (null to null); an amend leaves the closing', () => {
    const returned = closing('2027-12-20', '0.00', 'RETURNED');
    const late = rec('c-1', 'CLOSED', '2028-01-15T10:00:00Z', returned);
    expect(summary(deposit([created, late], returned), 2027)).toEqual([]);
    const reopenReturned = rec('c-2', 'REOPENED', '2028-02-12T10:00:00Z', returned);
    expect(summary(deposit([created, late, reopenReturned], null), 2027)).toEqual([]);
    // An AMENDED record (notes) between two records is no step and no change.
    const amended = rec('c-a', 'AMENDED', '2028-02-13T10:00:00Z');
    expect(summary(deposit([created, closed1, reopened, amended, closed2], SECOND), 2027).map(([kind]) => kind)).toEqual(['DEPOSIT_REOPENED']);
  });

  it('an inconsistent history: a CLOSED deposit without a record, a REOPENED whose cleared differs; ATTRIBUTION_HISTORY_INCONSISTENT with SecurityDeposit, its records unused', () => {
    const none = depositClosingChanges([deposit([created], FIRST)], 2027);
    expect(none).toEqual({ changes: [], inconsistent: [{ entityType: 'SecurityDeposit', entityId: D }] });
    const wrong = rec('c-2', 'REOPENED', '2028-02-12T10:00:00Z', closing('2027-12-21', '300.00'));
    const differs = depositClosingChanges([deposit([created, closed1, wrong, closed2], SECOND), deposit([created, closed1, wrong], null)], 2027);
    expect(differs.changes).toEqual([]);
    expect(differs.inconsistent).toEqual([
      { entityType: 'SecurityDeposit', entityId: D },
      { entityType: 'SecurityDeposit', entityId: D },
    ]);
    // A replay ending in another closing than the row's, two closings without a reopen: unusable too.
    expect(replayClosing(deposit([created, closed1], SECOND))).toBeUndefined();
    expect(replayClosing(deposit([created, closed1, closed2], SECOND))).toBeUndefined();
    // Named only where it concerns the year: 2026 names no closing of D.
    expect(depositClosingChanges([deposit([created], FIRST)], 2026).inconsistent).toEqual([]);
    // Counter-check: the consistent history replays to its two steps.
    expect(replayClosing(deposit([created, closed1, reopened, closed2], SECOND))?.map((s) => s.record.action)).toEqual(['CLOSED', 'REOPENED', 'CLOSED']);
  });

  it('the fingerprint: a null year is null in the canonical JSON; the existing kinds fingerprints are byte for byte unchanged', () => {
    const [change] = changesOf(deposit([created, closed1, reopened], null), 2027).changes;
    expect(change?.changeFingerprint).toBe(
      fingerprinter.sha256Hex(
        `{"auditRecordId":"c-2","items":[{"sourceId":"${D}","yearAfter":null,"yearBefore":2027}],"kind":"DEPOSIT_REOPENED","propertyReferenceId":"${P1}","year":2027}`,
      ),
    );
    // A year kind of §58E: the canonical JSON as VC-X-28 stored it (no sourceType, §58I Frage 3).
    const old = changeFingerprint(fingerprinter, {
      propertyReferenceId: P1,
      year: 2027,
      auditRecordId: 'r-1',
      kind: 'RECONCILIATION_CONFIRMED',
      items: [{ sourceId: 'S', yearBefore: 2027, yearAfter: 2028 }],
    });
    expect(old).toBe(
      fingerprinter.sha256Hex(
        `{"auditRecordId":"r-1","items":[{"sourceId":"s","yearAfter":2028,"yearBefore":2027}],"kind":"RECONCILIATION_CONFIRMED","propertyReferenceId":"${P1}","year":2027}`,
      ),
    );
  });

  it('acknowledged by kind and record; the CLOSED record of example (a) is not a change of 2027 (CHANGE_NOT_FLAGGED)', () => {
    const changes = changesOf(deposit([created, closed1, reopened, closed2], SECOND), 2027).changes;
    const entry = changes[0] as (typeof changes)[number];
    expect(planAcknowledgement(changes, { auditRecordId: 'c-2', kind: 'DEPOSIT_REOPENED', expectedFingerprint: entry.changeFingerprint }, [])).toMatchObject({
      kind: 'CREATE',
    });
    expect(planAcknowledgement(changes, { auditRecordId: 'c-3', expectedFingerprint: entry.changeFingerprint }, [])).toEqual({ kind: 'NOT_FLAGGED' });
    expect(DEPOSIT_YEAR_KINDS.every((k) => CHANGE_KINDS.includes(k))).toBe(true);
  });

  it('absent deposits change nothing: an input of VC-X-49 derives as before', () => {
    const input: AttributionInput = { references: [], candidates: [] };
    expect(attributionChanges(input, 2027, TAX_RULES, CTX)).toEqual({ changes: [], inconsistent: [] });
  });
});
