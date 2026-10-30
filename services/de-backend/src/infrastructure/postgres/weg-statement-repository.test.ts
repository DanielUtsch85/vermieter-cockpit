import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseMea, type Mea, type NewAnnualStatement, type NewStatementCostLine } from '../../domains/weg/index.js';
import { Money, type BusinessDate } from '../../shared/index.js';
import { createDatabase } from './database.js';
import { MIGRATION_ADVISORY_LOCK, migrateToLatest } from './migrate.js';
import { testSchemaName } from './test-schema.test-support.js';
import { PostgresWegAnnualStatementRepository } from './weg-annual-statement-repository.js';
import { PostgresWegEconomicPlanRepository } from './weg-economic-plan-repository.js';
import { PostgresWegRepository } from './weg-repository.js';

/**
 * VC-6-03 persistence (api-design.md §50): the Jahresabrechnung with its order of checks, the classification resolved
 * on write, replace, confirm with `supersedes`, void, the reads, the membership and WEG rules it adds, the schema's
 * rules past the repository, the serialisation under RC and RR, and `down`. Figures are invented.
 */
const databaseUrl = process.env['DE_TEST_DATABASE_URL'];

const REALM = '64b0c0ffee00000000000072';
const OTHER_REALM = '64b0c0ffee00000000000073';
const actor = { actorType: 'USER', actorId: 'anna@example.com' } as const;
const day = (value: string) => value as BusinessDate;
const eur = (amount: string) => Money.of(amount, 'EUR');
const mea = (text: string): Mea => {
  const parsed = parseMea(text);
  if (!('mea' in parsed)) throw new Error(text);
  return parsed.mea;
};
let counter = 0;

/** Runs `work` under the session advisory lock that migrations and schema teardown take (migrate.ts). */
async function withMigrationLock(work: () => Promise<unknown>): Promise<void> {
  const lock = new pg.Client({ connectionString: databaseUrl });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
    await work();
  } finally {
    await lock.end().catch(() => undefined);
  }
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function reasonOf(error: { message?: string; constraint?: string; code?: string }): string {
  return error.constraint ?? /\(([A-Z_]+)\)|is not a step|identity never changes|only inserted DRAFT/.exec(error.message ?? '')?.[0] ?? error.code ?? 'error';
}

const line = (overrides: Partial<NewStatementCostLine> = {}): NewStatementCostLine => ({
  position: 1,
  account: 'Hausmeister',
  group: 'RECOVERABLE',
  allocationKey: 'Miteigentumsanteile',
  allocationTotal: '10000',
  allocationShare: '250',
  totalAmount: eur('4000.00'),
  unitShare: eur('100.00'),
  classification: null,
  ...overrides,
});

describe.skipIf(databaseUrl === undefined)('Jahresabrechnung (§50)', () => {
  const schema = testSchemaName('weg_statement_test');
  let pool: pg.Pool;
  let wegs: PostgresWegRepository;
  let plans: PostgresWegEconomicPlanRepository;
  let statements: PostgresWegAnnualStatementRepository;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
    await migrateToLatest(pool, { migrationTableSchema: schema });
    const db = createDatabase(pool);
    wegs = new PostgresWegRepository(db);
    plans = new PostgresWegEconomicPlanRepository(db);
    statements = new PostgresWegAnnualStatementRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function member(options: { validFrom?: string; validUntil?: string | null; startMonth?: number } = {}) {
    const weg = await wegs.createWeg(
      { mreRealmId: REALM, displayName: `WEG ${++counter}`, administratorPartyId: null, financialYearStartMonth: options.startMonth ?? 1, notes: null },
      actor,
    );
    if (weg.kind !== 'CREATED') throw new Error(weg.kind);
    const mrePropertyId = (0x6512f0c2a1b2c3d4e5f80000n + BigInt(++counter)).toString(16).padStart(24, '0');
    const { rows } = await pool.query(
      `INSERT INTO property_reference (mre_realm_id, mre_property_id, external_reference_state, created_by) VALUES ($1, $2, 'ACTIVE', 'x') RETURNING id`,
      [REALM, mrePropertyId],
    );
    const m = await wegs.createMembership(
      {
        mreRealmId: REALM,
        wegId: weg.weg.id,
        propertyReferenceId: rows[0].id as string,
        mea: mea('250/10000'),
        validFrom: day(options.validFrom ?? '2024-01-01'),
        validUntil: options.validUntil === undefined || options.validUntil === null ? null : day(options.validUntil),
        sourceReferences: [],
        notes: null,
      },
      actor,
    );
    if (m.kind !== 'CREATED') throw new Error(m.kind);
    return { wegId: weg.weg.id, unit: rows[0].id as string, membership: m.membership };
  }

  const newStatement = (membershipId: string, overrides: Partial<NewAnnualStatement> = {}): NewAnnualStatement => ({
    mreRealmId: REALM,
    membershipId,
    financialYear: 2025,
    periodFrom: day('2025-01-01'),
    periodUntil: day('2025-12-31'),
    documentDate: day('2026-04-15'),
    resolutionDate: null,
    dueDate: null,
    supersedes: null,
    costLines: [
      line(),
      line({
        position: 2,
        account: 'Verwaltung',
        group: 'NON_RECOVERABLE',
        allocationKey: 'Einheit',
        allocationTotal: '20',
        allocationShare: '1',
        totalAmount: eur('1200.00'),
        unitShare: eur('60.00'),
      }),
      line({ position: 3, account: 'Zinserträge', group: 'NON_RECOVERABLE', totalAmount: eur('-40.00'), unitShare: eur('-1.00') }),
    ],
    recoverableSubtotal: eur('100.00'),
    nonRecoverableSubtotal: eur('59.00'),
    totalCosts: eur('159.00'),
    hausgeldRequested: eur('240.00'),
    hausgeldPaid: eur('240.00'),
    reserveRequested: eur('120.00'),
    reservePaid: eur('120.00'),
    settlementPeak: eur('-81.00'),
    settlementResult: null,
    reserve: {
      source: 'ANNUAL_STATEMENT',
      lines: [
        {
          position: 1,
          description: 'Erhaltungsrücklage',
          kind: 'CONTRIBUTION',
          opening: eur('10000.00'),
          addition: eur('4800.00'),
          withdrawal: null,
          closing: eur('14800.00'),
        },
      ],
      unitShareOpening: eur('250.00'),
      unitShareClosing: eur('370.00'),
    },
    sourceReferences: ['Einzelabrechnung S. 1'],
    notes: null,
    ...overrides,
  });
  async function draft(membershipId: string, overrides: Partial<NewAnnualStatement> = {}) {
    const outcome = await statements.createStatement(newStatement(membershipId, overrides), actor);
    if (outcome.kind !== 'CREATED') throw new Error(outcome.kind);
    return outcome.statement;
  }
  async function confirmed(membershipId: string, overrides: Partial<NewAnnualStatement> = {}) {
    const created = await draft(membershipId, overrides);
    const outcome = await statements.confirmStatement(created.id, REALM, new Date(), actor);
    if (outcome.kind !== 'CONFIRMED') throw new Error(outcome.kind);
    return outcome.statement;
  }
  const audit = async (id: string) =>
    (await pool.query(`SELECT action, metadata FROM audit_record WHERE entity_id = $1 ORDER BY occurred_at, id`, [id])).rows as {
      action: string;
      metadata: Record<string, unknown>;
    }[];

  describe('create and read', () => {
    it('a DRAFT with its lines, the classification resolved and stored, flags and sums derived; AuditRecords; Realm-scoped', async () => {
      const { membership } = await member();
      const created = await draft(membership.id);
      expect(created).toMatchObject({ status: 'DRAFT', version: 1, financialYear: 2025, supersedes: null, supersededBy: null });
      expect(created.costLines.map((l) => [l.position, l.classification, l.classificationSource, l.allocationTotal])).toEqual([
        [1, 'RECOVERABLE', 'PRINTED_GROUP', '10000'],
        [2, 'NON_RECOVERABLE', 'PRINTED_GROUP', '20'],
        [3, 'NON_RECOVERABLE', 'PRINTED_GROUP', '10000'],
      ]);
      expect(created.costLines[2]!.unitShare).toEqual(eur('-1.00'));
      expect(created.flags).toEqual([]);
      expect(created.byClassification).toEqual({ RECOVERABLE: eur('100.00'), NON_RECOVERABLE: eur('59.00'), RESERVE: eur('0.00') });
      expect(created.reserve?.lines[0]).toMatchObject({ kind: 'CONTRIBUTION', withdrawal: null, closing: eur('14800.00') });
      expect(await statements.findStatement(created.id, REALM)).toEqual(created);
      expect(await statements.findStatement(created.id, OTHER_REALM)).toBeUndefined();
      expect((await audit(created.id)).map((a) => a.action)).toEqual(['CREATED']);
      expect((await audit(membership.id)).map((a) => a.action)).toContain('ANNUAL_STATEMENT_ADDED');
    });

    it('an Idempotency-Key replays the created statement; another body under it conflicts', async () => {
      const { membership } = await member();
      const key = { key: `k-${++counter}`, fingerprint: 'f1' };
      const first = await statements.createStatement(newStatement(membership.id), actor, key);
      const again = await statements.createStatement(newStatement(membership.id), actor, key);
      expect(first.kind).toBe('CREATED');
      expect(again).toMatchObject({ kind: 'REPLAYED' });
      if (first.kind === 'CREATED' && again.kind === 'REPLAYED') expect(again.statement).toEqual(first.statement);
      expect(await statements.createStatement(newStatement(membership.id), actor, { ...key, fingerprint: 'f2' })).toEqual({ kind: 'IDEMPOTENCY_CONFLICT' });
    });

    it('order of checks: membership, period in the year, ACTIVE, period in the membership, supersedes', async () => {
      const { membership } = await member({ validFrom: '2025-03-01', startMonth: 1 });
      expect(await statements.createStatement(newStatement('00000000-0000-4000-8000-000000000000'), actor)).toEqual({ kind: 'MEMBERSHIP_NOT_FOUND' });
      expect(await statements.createStatement({ ...newStatement(membership.id), mreRealmId: OTHER_REALM }, actor)).toEqual({ kind: 'MEMBERSHIP_NOT_FOUND' });
      expect(await statements.createStatement(newStatement(membership.id, { periodFrom: day('2024-12-31') }), actor)).toEqual({
        kind: 'PERIOD_OUTSIDE_YEAR',
        field: 'periodFrom',
        from: '2025-01-01',
        until: '2025-12-31',
      });
      expect(await statements.createStatement(newStatement(membership.id, { periodUntil: day('2026-01-01') }), actor)).toMatchObject({ field: 'periodUntil' });
      // Part of the year after a purchase: inside the membership it passes, before it it is refused.
      expect(await statements.createStatement(newStatement(membership.id), actor)).toEqual({
        kind: 'STATEMENT_OUTSIDE_MEMBERSHIP',
        validFrom: '2025-03-01',
        validUntil: null,
      });
      expect((await statements.createStatement(newStatement(membership.id, { periodFrom: day('2025-03-01') }), actor)).kind).toBe('CREATED');
      const unknown = '00000000-0000-4000-8000-000000000001';
      expect(await statements.createStatement(newStatement(membership.id, { periodFrom: day('2025-03-01'), supersedes: unknown }), actor)).toEqual({
        kind: 'INVALID_SUPERSEDES',
        reason: 'NOT_FOUND',
        supersedes: unknown,
      });
      const voided = await member();
      await wegs.voidMembership(voided.membership.id, REALM, 'x', new Date(), actor);
      expect(await statements.createStatement(newStatement(voided.membership.id), actor)).toEqual({
        kind: 'MEMBERSHIP_NOT_ACTIVE',
        membershipId: voided.membership.id,
      });
      // The financial year follows the WEG's start month.
      const july = await member({ startMonth: 7 });
      expect(await statements.createStatement(newStatement(july.membership.id), actor)).toMatchObject({ kind: 'PERIOD_OUTSIDE_YEAR', from: '2025-07-01' });
      expect(
        (await statements.createStatement(newStatement(july.membership.id, { periodFrom: day('2025-07-01'), periodUntil: day('2026-06-30') }), actor)).kind,
      ).toBe('CREATED');
    });

    it('supersedes: of another membership, of another year, not CONFIRMED, or of another Realm', async () => {
      const { membership } = await member();
      const other = await member();
      const elsewhere = await confirmed(other.membership.id);
      const earlier = await confirmed(membership.id, { financialYear: 2024, periodFrom: day('2024-01-01'), periodUntil: day('2024-12-31') });
      const open = await draft(membership.id);
      const refusal = async (supersedes: string, realm = REALM) =>
        statements
          .createStatement({ ...newStatement(membership.id, { supersedes }), mreRealmId: realm }, actor)
          .then((o) => ('reason' in o ? o.reason : o.kind));
      expect(await refusal(elsewhere.id)).toBe('OTHER_MEMBERSHIP');
      expect(await refusal(earlier.id)).toBe('OTHER_YEAR');
      expect(await refusal(open.id)).toBe('NOT_CONFIRMED');
      expect(await refusal(open.id, OTHER_REALM)).toBe('MEMBERSHIP_NOT_FOUND');
    });

    it("the classification: the user's, else the last earlier CONFIRMED statement's by account, else the printed group; frozen once written", async () => {
      const { membership } = await member();
      // A 2026 draft first: no earlier confirmed statement yet.
      const early = await draft(membership.id, { financialYear: 2026, periodFrom: day('2026-01-01'), periodUntil: day('2026-12-31') });
      expect(early.costLines.map((l) => l.classificationSource)).toEqual(['PRINTED_GROUP', 'PRINTED_GROUP', 'PRINTED_GROUP']);
      await confirmed(membership.id, {
        costLines: [line({ classification: 'RESERVE' }), line({ position: 2, account: 'Verwaltung', group: 'NON_RECOVERABLE' })],
      });
      // Confirming an earlier year later leaves the stored one as it was (review on #148).
      expect((await statements.findStatement(early.id, REALM))?.costLines.map((l) => l.classificationSource)).toEqual([
        'PRINTED_GROUP',
        'PRINTED_GROUP',
        'PRINTED_GROUP',
      ]);
      const later = await draft(membership.id, {
        financialYear: 2026,
        periodFrom: day('2026-01-01'),
        periodUntil: day('2026-12-31'),
        costLines: [
          line(),
          line({ position: 2, account: 'Aufzug' }),
          line({ position: 3, account: 'Verwaltung', group: 'NON_RECOVERABLE', classification: 'RECOVERABLE' }),
        ],
      });
      expect(later.costLines.map((l) => [l.account, l.classification, l.classificationSource])).toEqual([
        ['Hausmeister', 'RESERVE', 'PREVIOUS_STATEMENT'],
        ['Aufzug', 'RECOVERABLE', 'PRINTED_GROUP'],
        ['Verwaltung', 'RECOVERABLE', 'USER'],
      ]);
      expect(later.flags.map((f) => f.code)).toContain('CLASSIFIED_AGAINST_GROUP');
      // A later year's statement is not a previous one.
      const before = await draft(membership.id, { financialYear: 2024, periodFrom: day('2024-01-01'), periodUntil: day('2024-12-31') });
      expect(before.costLines[0]).toMatchObject({ classification: 'RECOVERABLE', classificationSource: 'PRINTED_GROUP' });
    });

    it('the classification comes from a CONFIRMED statement only, never from a draft or a voided one', async () => {
      const { membership } = await member();
      await draft(membership.id, { costLines: [line({ classification: 'RESERVE' })] });
      const voided = await draft(membership.id, { costLines: [line({ classification: 'NON_RECOVERABLE' })] });
      await statements.voidStatement(voided.id, REALM, 'x', new Date(), actor);
      const next = await draft(membership.id, { financialYear: 2026, periodFrom: day('2026-01-01'), periodUntil: day('2026-12-31') });
      expect(next.costLines[0]).toMatchObject({ classification: 'RECOVERABLE', classificationSource: 'PRINTED_GROUP' });
    });

    it('list: by year, then creation; filters; Realm-scoped; unknown membership', async () => {
      const { membership } = await member();
      const late = await draft(membership.id, { financialYear: 2026, periodFrom: day('2026-01-01'), periodUntil: day('2026-12-31') });
      const first = await confirmed(membership.id);
      const second = await draft(membership.id);
      const page = await statements.listStatements(membership.id, REALM, {}, { page: 1, pageSize: 50 });
      expect(page?.items.map((s) => s.id)).toEqual([first.id, second.id, late.id]);
      expect(page?.total).toBe(3);
      expect(
        (await statements.listStatements(membership.id, REALM, { statuses: ['DRAFT'], financialYear: 2025 }, { page: 1, pageSize: 50 }))?.items.map(
          (s) => s.id,
        ),
      ).toEqual([second.id]);
      expect((await statements.listStatements(membership.id, REALM, {}, { page: 2, pageSize: 2 }))?.items.map((s) => s.id)).toEqual([late.id]);
      expect(page?.items[0]?.flags).toEqual([]);
      expect(await statements.listStatements(membership.id, OTHER_REALM, {}, { page: 1, pageSize: 50 })).toBeUndefined();
    });
  });

  describe('replace, confirm, void', () => {
    it('replace: the whole content while DRAFT, AuditRecord with fields and line count; the same content is a no-op; If-Match', async () => {
      const { membership } = await member();
      const created = await draft(membership.id);
      const { mreRealmId: _r, membershipId: _m, ...content } = newStatement(membership.id);
      expect(await statements.replaceStatement(created.id, REALM, content, actor)).toMatchObject({
        kind: 'REPLACED',
        changed: false,
        statement: { version: 1 },
      });
      const changed = { ...content, settlementPeak: eur('-80.00'), costLines: content.costLines.slice(0, 2) };
      expect(await statements.replaceStatement(created.id, REALM, changed, actor, [7])).toEqual({
        kind: 'VERSION_CONFLICT',
        expectedVersions: [7],
        currentVersion: 1,
      });
      const replaced = await statements.replaceStatement(created.id, REALM, changed, actor, [1]);
      expect(replaced).toMatchObject({ kind: 'REPLACED', changed: true, statement: { version: 2, settlementPeak: eur('-80.00') } });
      if (replaced.kind === 'REPLACED') {
        expect(replaced.statement.costLines).toHaveLength(2);
        expect(replaced.statement.flags.map((f) => f.code)).toEqual(['LINES_DIFFER_FROM_SUBTOTAL', 'SETTLEMENT_DIFFERS']);
      }
      expect((await audit(created.id)).at(-1)).toMatchObject({
        action: 'REPLACED',
        metadata: { changedFields: ['settlementPeak'], lineCount: { from: 3, to: 2 } },
      });
      expect(await statements.replaceStatement(created.id, REALM, { ...content, periodFrom: day('2023-01-01') }, actor)).toMatchObject({
        kind: 'PERIOD_OUTSIDE_YEAR',
      });
      expect(await statements.replaceStatement(created.id, OTHER_REALM, content, actor)).toEqual({ kind: 'NOT_FOUND' });
      await statements.confirmStatement(created.id, REALM, new Date(), actor);
      expect(await statements.replaceStatement(created.id, REALM, content, actor)).toEqual({ kind: 'STATEMENT_NOT_DRAFT', status: 'CONFIRMED' });
    });

    it('confirm: DRAFT → CONFIRMED, a no-op once CONFIRMED; STATEMENT_EXISTS without supersedes; flags do not block', async () => {
      const { membership } = await member();
      const first = await draft(membership.id, { settlementPeak: eur('1.00') });
      expect(first.flags.map((f) => f.code)).toEqual(['SETTLEMENT_DIFFERS']);
      const done = await statements.confirmStatement(first.id, REALM, new Date('2026-05-01T10:00:00Z'), actor, [1]);
      expect(done).toMatchObject({
        kind: 'CONFIRMED',
        changed: true,
        statement: { status: 'CONFIRMED', version: 2, confirmedAt: new Date('2026-05-01T10:00:00Z') },
      });
      expect(await statements.confirmStatement(first.id, REALM, new Date(), actor)).toMatchObject({
        kind: 'CONFIRMED',
        changed: false,
        statement: { version: 2 },
      });
      const second = await draft(membership.id);
      expect(await statements.confirmStatement(second.id, REALM, new Date(), actor)).toEqual({ kind: 'STATEMENT_EXISTS', statementId: first.id });
      // The refusal comes before the version check, as every refusal of §50.
      expect(await statements.confirmStatement(second.id, REALM, new Date(), actor, [9])).toEqual({ kind: 'STATEMENT_EXISTS', statementId: first.id });
      expect(await statements.confirmStatement(second.id, OTHER_REALM, new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
      expect((await audit(first.id)).map((a) => a.action)).toEqual(['CREATED', 'CONFIRMED']);
    });

    it('supersede: the old one SUPERSEDED with its successor, the new one CONFIRMED; the old one stays readable; no second successor', async () => {
      const { membership } = await member();
      const old = await confirmed(membership.id);
      const correction = await draft(membership.id, { supersedes: old.id, settlementPeak: eur('-80.00'), notes: 'Korrektur' });
      const rival = await draft(membership.id, { supersedes: old.id });
      const done = await statements.confirmStatement(correction.id, REALM, new Date(), actor);
      expect(done).toMatchObject({ kind: 'CONFIRMED', statement: { status: 'CONFIRMED', supersedes: old.id } });
      expect(await statements.findStatement(old.id, REALM)).toMatchObject({ status: 'SUPERSEDED', supersededBy: correction.id, version: 3 });
      expect((await audit(old.id)).at(-1)).toMatchObject({ action: 'SUPERSEDED', metadata: { supersededBy: correction.id } });
      expect((await audit(correction.id)).at(-1)).toMatchObject({ action: 'CONFIRMED', metadata: { supersedes: old.id } });
      expect(await statements.confirmStatement(rival.id, REALM, new Date(), actor)).toEqual({
        kind: 'INVALID_SUPERSEDES',
        reason: 'NOT_CONFIRMED',
        supersedes: old.id,
      });
      expect(await statements.confirmStatement(old.id, REALM, new Date(), actor)).toEqual({ kind: 'STATEMENT_NOT_DRAFT', status: 'SUPERSEDED' });
      // The correction of the correction.
      const third = await draft(membership.id, { supersedes: correction.id });
      expect((await statements.confirmStatement(third.id, REALM, new Date(), actor)).kind).toBe('CONFIRMED');
    });

    it('void: DRAFT → VOID with its reason; a no-op once VOID; CONFIRMED is never voided', async () => {
      const { membership } = await member();
      const wrong = await draft(membership.id);
      expect(await statements.voidStatement(wrong.id, REALM, 'Tippfehler', new Date(), actor, [1])).toMatchObject({
        kind: 'VOIDED',
        changed: true,
        statement: { status: 'VOID', voidReason: 'Tippfehler', version: 2 },
      });
      expect(await statements.voidStatement(wrong.id, REALM, 'again', new Date(), actor)).toMatchObject({ kind: 'VOIDED', changed: false });
      expect(await statements.confirmStatement(wrong.id, REALM, new Date(), actor)).toEqual({ kind: 'STATEMENT_NOT_DRAFT', status: 'VOID' });
      const kept = await confirmed(membership.id);
      expect(await statements.voidStatement(kept.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'STATEMENT_NOT_DRAFT', status: 'CONFIRMED' });
      expect(await statements.voidStatement(kept.id, OTHER_REALM, 'x', new Date(), actor)).toEqual({ kind: 'NOT_FOUND' });
    });
  });

  describe('rules elsewhere', () => {
    it('MEMBERSHIP_HAS_STATEMENTS on end and void, after MEMBERSHIP_HAS_PLANS; a VOID statement does not hold', async () => {
      const { membership } = await member();
      const held = await draft(membership.id);
      expect(await wegs.endMembership(membership.id, REALM, day('2025-06-30'), actor)).toEqual({ kind: 'MEMBERSHIP_HAS_STATEMENTS', statementIds: [held.id] });
      expect(await wegs.voidMembership(membership.id, REALM, 'x', new Date(), actor)).toEqual({ kind: 'MEMBERSHIP_HAS_STATEMENTS', statementIds: [held.id] });
      expect((await wegs.endMembership(membership.id, REALM, day('2025-12-31'), actor)).kind).toBe('ENDED');
      const plan = await plans.createPlan(
        {
          mreRealmId: REALM,
          membershipId: membership.id,
          financialYear: 2025,
          effectiveFrom: day('2025-09-01'),
          resolutionDate: null,
          monthlyHausgeld: eur('20.00'),
          monthlyReserveContribution: eur('10.00'),
          recoverableCosts: eur('0'),
          nonRecoverableCosts: eur('0'),
          income: null,
          annualReserveContribution: null,
          costLines: [],
          sourceReferences: [],
          notes: null,
        },
        actor,
      );
      expect(plan.kind).toBe('CREATED');
      expect(await wegs.endMembership(membership.id, REALM, day('2025-06-30'), actor)).toMatchObject({ kind: 'MEMBERSHIP_HAS_PLANS' });
      await statements.voidStatement(held.id, REALM, 'x', new Date(), actor);
      if (plan.kind === 'CREATED') await plans.voidPlan(plan.plan.id, REALM, 'x', new Date(), actor);
      expect((await wegs.voidMembership(membership.id, REALM, 'x', new Date(), actor)).kind).toBe('VOIDED');
    });

    it('WEG_HAS_YEARS for a statement that is not VOID', async () => {
      const { wegId, membership } = await member();
      const held = await draft(membership.id);
      expect(await wegs.amendWeg(wegId, REALM, { financialYearStartMonth: 7 }, actor)).toEqual({ kind: 'WEG_HAS_YEARS' });
      await statements.voidStatement(held.id, REALM, 'x', new Date(), actor);
      expect((await wegs.amendWeg(wegId, REALM, { financialYearStartMonth: 7 }, actor)).kind).toBe('AMENDED');
    });
  });

  describe('schema past the repository', () => {
    const insert = (membershipId: string, set: { year?: number; from?: string; until?: string; status?: string; supersedes?: string | null } = {}) =>
      pool
        .query(
          `INSERT INTO weg_annual_statement (mre_realm_id, membership_id, financial_year, period_from, period_until, supersedes_id, recoverable_subtotal,
             non_recoverable_subtotal, total_costs, hausgeld_requested, hausgeld_paid, settlement_peak, currency, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, 0, 0, 0, 'EUR', $7, 'x') RETURNING id`,
          [REALM, membershipId, set.year ?? 2025, set.from ?? '2025-01-01', set.until ?? '2025-12-31', set.supersedes ?? null, set.status ?? 'DRAFT'],
        )
        .then((r) => r.rows[0].id as string, reasonOf);
    const update = (table: string, set: string, id: string) => pool.query(`UPDATE ${table} SET ${set} WHERE id = $1`, [id]).then(() => 'accepted', reasonOf);
    const confirmSql = `status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1`;
    const insertLine = (statementId: string, position = 9, set = `'Hausmeister', 'RECOVERABLE', 'MEA', 10, 5`) =>
      pool
        .query(
          `INSERT INTO weg_statement_cost_line (mre_realm_id, statement_id, position, account, cost_group, allocation_key, allocation_total, allocation_share,
             total_amount, unit_share, currency, classification, classification_source)
           VALUES ($1, $2, $3, ${set}, 10, 5, 'EUR', 'RECOVERABLE', 'USER')`,
          [REALM, statementId, position],
        )
        .then(() => 'accepted', reasonOf);

    it('weg_annual_statement_membership and _initial: the membership, the period, the year, supersedes', async () => {
      const { membership } = await member({ validFrom: '2025-03-01' });
      expect(await insert(membership.id)).toBe('(STATEMENT_OUTSIDE_MEMBERSHIP)');
      expect(await insert(membership.id, { from: '2025-03-01', until: '2026-01-31' })).toBe('(PERIOD_OUTSIDE_YEAR)');
      expect(await insert(membership.id, { from: '2025-03-01', status: 'CONFIRMED' })).toBe('only inserted DRAFT');
      const id = await insert(membership.id, { from: '2025-03-01' });
      expect(await update('weg_annual_statement', `period_from = '2025-02-01', version = version + 1`, id)).toBe('(STATEMENT_OUTSIDE_MEMBERSHIP)');
      expect(await update('weg_annual_statement', `financial_year = 2026, version = version + 1`, id)).toBe('(PERIOD_OUTSIDE_YEAR)');
      const later = await insert(membership.id, { year: 2026, from: '2026-01-01', until: '2026-12-31' });
      expect(await update('weg_annual_statement', `supersedes_id = '${later}', version = version + 1`, id)).toBe('(INVALID_SUPERSEDES)');
      expect(await update('weg_annual_statement', `period_until = period_from - 1, version = version + 1`, id)).toBe('weg_annual_statement_period');
      const other = await member();
      const foreign = await insert(other.membership.id);
      expect(await update('weg_annual_statement', `supersedes_id = '${foreign}', version = version + 1`, id)).toBe('weg_annual_statement_supersedes_fk');
      const voided = await member();
      await wegs.voidMembership(voided.membership.id, REALM, 'x', new Date(), actor);
      expect(await insert(voided.membership.id)).toBe('(MEMBERSHIP_NOT_ACTIVE)');
    });

    it('weg_annual_statement_frozen: content only while DRAFT; the steps; version + 1; the no-op passes; no delete', async () => {
      const { membership } = await member();
      const id = await insert(membership.id);
      expect(await update('weg_annual_statement', `notes = 'n'`, id)).toBe('identity never changes');
      expect(await update('weg_annual_statement', `notes = 'n', version = version + 1`, id)).toBe('accepted');
      expect(await update('weg_annual_statement', `version = version`, id)).toBe('accepted');
      expect(await update('weg_annual_statement', `supersedes_id = id, version = version + 1`, id)).toBe('weg_annual_statement_not_itself');
      expect(await update('weg_annual_statement', confirmSql, id)).toBe('accepted');
      expect(await update('weg_annual_statement', `notes = 'm', version = version + 1`, id)).toBe('(STATEMENT_NOT_DRAFT)');
      expect(
        await update(
          'weg_annual_statement',
          `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', confirmed_at = NULL, confirmed_by = NULL, version = version + 1`,
          id,
        ),
      ).toBe('is not a step');
      expect(await insertLine(id)).toBe('(STATEMENT_NOT_DRAFT)');
      expect(await pool.query(`DELETE FROM weg_statement_cost_line WHERE statement_id = $1`, [id]).then(() => 'accepted', reasonOf)).toBe('accepted');
      expect(await pool.query(`DELETE FROM weg_annual_statement WHERE id = $1`, [id]).then(() => 'accepted', reasonOf)).not.toBe('accepted');
      // A second CONFIRMED of the year: the partial unique index.
      const second = await insert(membership.id);
      expect(await update('weg_annual_statement', confirmSql, second)).toBe('weg_annual_statement_confirmed_key');
      // Supersede: the old one first, by a DRAFT naming it; the new one only after.
      const correction = await insert(membership.id, { supersedes: id });
      expect(await update('weg_annual_statement', confirmSql, correction)).toBe('(INVALID_SUPERSEDES)');
      expect(await update('weg_annual_statement', `status = 'SUPERSEDED', superseded_by_id = '${second}', version = version + 1`, id)).toBe(
        '(INVALID_SUPERSEDES)',
      );
      // At commit the successor must be CONFIRMED (review on #150): alone, the step is refused; then voided, too.
      const supersede = `UPDATE weg_annual_statement SET status = 'SUPERSEDED', superseded_by_id = '${correction}', version = version + 1 WHERE id = '${id}'`;
      const inOne = async (...statements: string[]) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          for (const statement of statements) await client.query(statement);
          await client.query('COMMIT');
          return 'accepted';
        } catch (error) {
          await client.query('ROLLBACK');
          return reasonOf(error as { message?: string });
        } finally {
          client.release();
        }
      };
      expect(await inOne(supersede)).toBe('(UNCONFIRMED_SUCCESSOR)');
      expect(
        await inOne(
          supersede,
          `UPDATE weg_annual_statement SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = '${correction}'`,
        ),
      ).toBe('(UNCONFIRMED_SUCCESSOR)');
      expect(await inOne(supersede, `UPDATE weg_annual_statement SET ${confirmSql} WHERE id = '${correction}'`)).toBe('accepted');
      expect(await update('weg_annual_statement', `status = 'CONFIRMED', version = version + 1`, id)).toBe('is not a step');
      // A chain: the successor superseded in turn keeps the first one valid.
      const third = await insert(membership.id, { supersedes: correction });
      expect(
        await inOne(
          `UPDATE weg_annual_statement SET status = 'SUPERSEDED', superseded_by_id = '${third}', version = version + 1 WHERE id = '${correction}'`,
          `UPDATE weg_annual_statement SET ${confirmSql} WHERE id = '${third}'`,
        ),
      ).toBe('accepted');
    });

    it('weg_statement_cost_line: only while DRAFT; share ≤ total; the position unique; the Realm by key', async () => {
      const { membership } = await member();
      const id = await insert(membership.id);
      expect(await insertLine(id, 1)).toBe('accepted');
      expect(await insertLine(id, 1)).toBe('weg_statement_cost_line_position_key');
      expect(await insertLine(id, 2, `'Hausmeister', 'RECOVERABLE', 'MEA', 5, 10`)).toBe('weg_statement_cost_line_share');
      expect(
        await pool
          .query(
            `INSERT INTO weg_statement_cost_line (mre_realm_id, statement_id, position, account, cost_group, allocation_key, total_amount, unit_share, currency,
               classification, classification_source) VALUES ($1, $2, 3, 'a', 'RECOVERABLE', 'k', 1, 1, 'EUR', 'RECOVERABLE', 'USER')`,
            [OTHER_REALM, id],
          )
          .then(() => 'accepted', reasonOf),
      ).toBe('weg_statement_cost_line_statement_fk');
      await update('weg_annual_statement', `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1`, id);
      expect(await pool.query(`UPDATE weg_statement_cost_line SET account = 'b' WHERE statement_id = $1`, [id]).then(() => 'accepted', reasonOf)).toBe(
        '(STATEMENT_NOT_DRAFT)',
      );
    });

    it('weg_membership_statements and weg_financial_year_statements past the repository', async () => {
      const { wegId, membership } = await member();
      const id = await insert(membership.id, { from: '2025-07-01' });
      expect(await update('weg_membership', `valid_until = '2025-09-30', version = version + 1`, membership.id)).toBe('(MEMBERSHIP_HAS_STATEMENTS)');
      expect(await update('weg_membership', `valid_until = '2025-12-31', version = version + 1`, membership.id)).toBe('accepted');
      expect(await update('weg', `financial_year_start_month = 7, version = version + 1`, wegId)).toBe('(WEG_HAS_YEARS)');
      await update('weg_annual_statement', `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1`, id);
      expect(await update('weg', `financial_year_start_month = 7, version = version + 1`, wegId)).toBe('accepted');
      expect(
        await update('weg_membership', `status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1`, membership.id),
      ).toBe('accepted');
    });

    // Down tests wait on each other's migration lock when run in parallel: more than the default 5 s.
    it('down drops both tables and the functions of 0042 (under MIGRATION_ADVISORY_LOCK)', { timeout: 30_000 }, async () => {
      const downSchema = testSchemaName('weg_statement_down_test');
      const admin = new pg.Client({ connectionString: databaseUrl });
      await admin.connect();
      await admin.query(`CREATE SCHEMA "${downSchema}"`);
      await admin.end();
      const downPool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${downSchema}`, max: 2 });
      try {
        await migrateToLatest(downPool, { migrationTableSchema: downSchema });
        // Dropping a table while another worker's Migrator introspects the database breaks it: hold the migration lock.
        // 0043 builds on 0042's table: it goes first.
        await withMigrationLock(async () => {
          await (await import('./migrations/0044_weg_special_assessment.js')).down(createDatabase(downPool) as never);
          await (await import('./migrations/0043_weg_statement_settlement.js')).down(createDatabase(downPool) as never);
          await (await import('./migrations/0042_weg_annual_statement.js')).down(createDatabase(downPool) as never);
        });
        expect((await downPool.query(`SELECT to_regclass('weg_annual_statement') AS a, to_regclass('weg_statement_cost_line') AS b`)).rows[0]).toEqual({
          a: null,
          b: null,
        });
        const { rows } = await downPool.query(
          `SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE nspname = $1 AND (proname LIKE 'weg_annual_statement%' OR proname LIKE 'weg_statement%' OR proname IN ('weg_membership_statements', 'weg_financial_year_statements'))`,
          [downSchema],
        );
        expect(rows).toEqual([]);
        const { rows: triggers } = await downPool.query(
          `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE nspname = $1 AND tgname IN ('weg_membership_statements', 'weg_financial_year_statements')`,
          [downSchema],
        );
        expect(triggers).toEqual([]);
      } finally {
        await downPool.end();
      }
    });
  });

  describe('concurrency', () => {
    const waitForLock = (text: string) =>
      waitUntil(
        async () =>
          Number(
            (
              await pool.query(`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [
                `%${text}%`,
              ])
            ).rows[0].count,
          ) >= 1,
      );
    const rawInsert = (client: pg.PoolClient | pg.Pool, membershipId: string, from = '2025-01-01') =>
      client.query(
        `INSERT INTO weg_annual_statement (mre_realm_id, membership_id, financial_year, period_from, period_until, recoverable_subtotal,
           non_recoverable_subtotal, total_costs, hausgeld_requested, hausgeld_paid, settlement_peak, currency, status, created_by)
         VALUES ($1, $2, 2025, $3, '2025-12-31', 0, 0, 0, 0, 0, 0, 'EUR', 'DRAFT', 'x') RETURNING id`,
        [REALM, membershipId, from],
      );
    const confirmSql = `UPDATE weg_annual_statement SET status = 'CONFIRMED', confirmed_at = now(), confirmed_by = 'x', version = version + 1 WHERE id = $1`;

    it('RC: two confirms for one membership and year; the loser answers STATEMENT_EXISTS', async () => {
      const { membership } = await member();
      const [a, b] = [await draft(membership.id), await draft(membership.id)];
      const outcomes = await Promise.all([a, b].map((s) => statements.confirmStatement(s.id, REALM, new Date(), actor)));
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['CONFIRMED', 'STATEMENT_EXISTS']);
      const winner = outcomes.find((o) => o.kind === 'CONFIRMED');
      expect(outcomes.find((o) => o.kind === 'STATEMENT_EXISTS')).toEqual({
        kind: 'STATEMENT_EXISTS',
        statementId: winner?.kind === 'CONFIRMED' ? winner.statement.id : '',
      });
    });

    it('RC, the repository waiting: a confirm behind a raw confirm of the year sees it and answers STATEMENT_EXISTS', async () => {
      const { membership } = await member();
      const [a, b] = [await draft(membership.id), await draft(membership.id)];
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(confirmSql, [a.id]);
        const confirming = statements.confirmStatement(b.id, REALM, new Date(), actor);
        await waitForLock('update "weg_annual_statement" set "status"');
        await holder.query('COMMIT');
        expect(await confirming).toEqual({ kind: 'STATEMENT_EXISTS', statementId: a.id });
      } finally {
        holder.release();
      }
    });

    it('RR: two confirms for one membership and year; the later one fails on the unique index', async () => {
      const { membership } = await member();
      const [a, b] = [await draft(membership.id), await draft(membership.id)];
      const [first, second] = [await pool.connect(), await pool.connect()];
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM weg_annual_statement');
        await second.query('SELECT count(*) FROM weg_annual_statement');
        await first.query(confirmSql, [a.id]);
        const late = second.query(confirmSql, [b.id]).then(
          () => 'confirmed',
          (error: { code?: string }) => error.code,
        );
        await waitForLock('UPDATE weg_annual_statement SET status');
        await first.query('COMMIT');
        // The unique index refuses the second CONFIRMED (a unique violation, not a serialisation failure): never two.
        expect(await late).toBe('23505');
        await second.query('ROLLBACK');
      } finally {
        first.release();
        second.release();
      }
    });

    it('two confirms superseding the same statement: they serialise on it, the second sees SUPERSEDED', async () => {
      const { membership } = await member();
      const old = await confirmed(membership.id);
      const [a, b] = [await draft(membership.id, { supersedes: old.id }), await draft(membership.id, { supersedes: old.id })];
      const outcomes = await Promise.all([a, b].map((s) => statements.confirmStatement(s.id, REALM, new Date(), actor)));
      expect(outcomes.map((o) => (o.kind === 'INVALID_SUPERSEDES' ? `${o.kind}:${o.reason}` : o.kind)).sort()).toEqual([
        'CONFIRMED',
        'INVALID_SUPERSEDES:NOT_CONFIRMED',
      ]);
    });

    it('RC, raw SQL: an end waiting on a statement insert in flight sees it and is refused', async () => {
      const { membership } = await member();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await rawInsert(holder, membership.id, '2025-07-01');
        const ending = pool
          .query(`UPDATE weg_membership SET valid_until = '2025-06-30', version = version + 1 WHERE id = $1`, [membership.id])
          .then(() => 'ended', reasonOf);
        await waitForLock('UPDATE weg_membership');
        await holder.query('COMMIT');
        expect(await ending).toBe('(MEMBERSHIP_HAS_STATEMENTS)');
      } finally {
        holder.release();
      }
    });

    it('RC: a create waiting on a void of the membership sees VOID and is refused', async () => {
      const { membership } = await member();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          `UPDATE weg_membership SET status = 'VOID', voided_at = now(), voided_by = 'x', void_reason = 'r', version = version + 1 WHERE id = $1`,
          [membership.id],
        );
        const creating = statements.createStatement(newStatement(membership.id), actor);
        await waitForLock('"property_reference"');
        await holder.query('COMMIT');
        expect(await creating).toEqual({ kind: 'MEMBERSHIP_NOT_ACTIVE', membershipId: membership.id });
      } finally {
        holder.release();
      }
    });

    it('RC (review on #148): a create waiting on an amend of the start month reads the new one and is refused', async () => {
      const { wegId, membership } = await member();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE weg SET financial_year_start_month = 7, version = version + 1 WHERE id = $1`, [wegId]);
        const creating = statements.createStatement(newStatement(membership.id), actor);
        await waitForLock('"weg"');
        await holder.query('COMMIT');
        expect(await creating).toEqual({ kind: 'PERIOD_OUTSIDE_YEAR', field: 'periodFrom', from: '2025-07-01', until: '2026-06-30' });
      } finally {
        holder.release();
      }
    });

    it('RC, raw SQL: an amend of the start month waiting on a statement insert sees it and is refused (WEG_HAS_YEARS)', async () => {
      const { wegId, membership } = await member();
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await rawInsert(holder, membership.id);
        const amending = pool
          .query(`UPDATE weg SET financial_year_start_month = 7, version = version + 1 WHERE id = $1`, [wegId])
          .then(() => 'amended', reasonOf);
        await waitForLock('UPDATE weg SET financial_year_start_month');
        await holder.query('COMMIT');
        expect(await amending).toBe('(WEG_HAS_YEARS)');
      } finally {
        holder.release();
      }
    });

    it('RR: a statement insert and an amend of the start month; the later one fails to serialise', async () => {
      const { wegId, membership } = await member();
      const [first, second] = [await pool.connect(), await pool.connect()];
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM weg_annual_statement');
        await second.query('SELECT count(*) FROM weg');
        await rawInsert(first, membership.id);
        const late = second.query(`UPDATE weg SET financial_year_start_month = 7, version = version + 1 WHERE id = $1`, [wegId]).then(
          () => 'amended',
          (error: { code?: string }) => error.code,
        );
        await waitForLock('UPDATE weg SET financial_year_start_month');
        await first.query('COMMIT');
        expect(await late).toBe('40001');
        await second.query('ROLLBACK');
      } finally {
        first.release();
        second.release();
      }
    });

    it('RC: a replace waiting on a confirm sees CONFIRMED; a line write waiting on a confirm is refused', async () => {
      const { membership } = await member();
      const created = await draft(membership.id);
      const { mreRealmId: _r, membershipId: _m, ...content } = newStatement(membership.id, { notes: 'neu' });
      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(confirmSql, [created.id]);
        const replacing = statements.replaceStatement(created.id, REALM, content, actor);
        const writingLine = pool
          .query(
            `INSERT INTO weg_statement_cost_line (mre_realm_id, statement_id, position, account, cost_group, allocation_key, total_amount, unit_share, currency,
               classification, classification_source) VALUES ($1, $2, 99, 'a', 'RECOVERABLE', 'k', 1, 1, 'EUR', 'RECOVERABLE', 'USER')`,
            [REALM, created.id],
          )
          .then(() => 'accepted', reasonOf);
        await waitForLock('INSERT INTO weg_statement_cost_line');
        await holder.query('COMMIT');
        expect(await replacing).toEqual({ kind: 'STATEMENT_NOT_DRAFT', status: 'CONFIRMED' });
        expect(await writingLine).toBe('(STATEMENT_NOT_DRAFT)');
      } finally {
        holder.release();
      }
    });

    it('RR, raw SQL: a line write and a confirm; the later one fails to serialise', async () => {
      const { membership } = await member();
      const created = await draft(membership.id);
      const [first, second] = [await pool.connect(), await pool.connect()];
      try {
        await first.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await second.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await first.query('SELECT count(*) FROM weg_annual_statement');
        await second.query('SELECT count(*) FROM weg_statement_cost_line');
        await first.query(confirmSql, [created.id]);
        const late = second
          .query(
            `INSERT INTO weg_statement_cost_line (mre_realm_id, statement_id, position, account, cost_group, allocation_key, total_amount, unit_share, currency,
               classification, classification_source) VALUES ($1, $2, 99, 'a', 'RECOVERABLE', 'k', 1, 1, 'EUR', 'RECOVERABLE', 'USER')`,
            [REALM, created.id],
          )
          .then(
            () => 'accepted',
            (error: { code?: string }) => error.code,
          );
        await waitForLock('INSERT INTO weg_statement_cost_line');
        await first.query('COMMIT');
        expect(await late).toBe('40001');
        await second.query('ROLLBACK');
      } finally {
        first.release();
        second.release();
      }
    });
  });
});
