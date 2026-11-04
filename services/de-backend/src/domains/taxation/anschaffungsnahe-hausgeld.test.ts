import { describe, expect, it } from 'vitest';
import { RuleRegistry, type RuleVersion } from '../../shared/index.js';
import {
  R1,
  TAX_RULES,
  acquisition,
  check,
  day,
  eur,
  example,
  flagOf,
  judged,
  keys,
  line,
  membership,
  performed,
  reasonsOf,
  statement,
  statement2030,
} from './anschaffungsnahe-hausgeld.test-support.js';
import { DE_ANSCHAFFUNGSNAHE_V1, type AnschaffungsnaheParameters, type HausgeldMaintenanceParameters } from './rules/de-anschaffungsnahe.js';
import { TAXATION_RULE_VERSIONS } from './rules/versions.js';

/**
 * §58M (VC-X-27; tax review of 2026-11-01, question 16, mündlich bestätigt durch den Steuerberater, laut Projektinhaber
 * am 2026-11-01; Entscheidung des Projektinhabers, 2026-11-04, M1–M11, M3 the alternative, M7 symmetric over M3's range):
 * the judged maintenance lines of the confirmed statements are sources of the check only, dated by their performance;
 * the read range is S to W + 365 days (2026-03-15 – 2030-03-15), and the same range names the missing years. The
 * examples literally (synthetic); the setup is in `anschaffungsnahe-hausgeld.test-support.ts`.
 */

const withHausgeld = (q: Partial<HausgeldMaintenanceParameters> | null) => {
  const v = DE_ANSCHAFFUNGSNAHE_V1;
  const { hausgeldMaintenance, ...rest } = v.parameters;
  const parameters: AnschaffungsnaheParameters =
    q === null ? rest : { ...rest, hausgeldMaintenance: { ...(hausgeldMaintenance as HausgeldMaintenanceParameters), ...q } };
  const changed: RuleVersion<AnschaffungsnaheParameters> = { ...v, parameters };
  return new RuleRegistry([...TAXATION_RULE_VERSIONS.filter((r) => r.ruleCode !== 'DE_ANSCHAFFUNGSNAHE'), changed]);
};

describe('maintenance paid from the Hausgeld in the check (§58M): the examples', () => {
  it('the base example: 29,180.67 to 31,197.48, NOT_COMPUTABLE PERFORMANCE_IN_WINDOW_UNKNOWN; L3 across the end exact, L4 undated', () => {
    const c = check(example());
    expect([c.sum, c.sumUpper, c.status, c.notComputableReason, c.final]).toEqual([
      eur('29180.67'),
      eur('31197.48'),
      'NOT_COMPUTABLE',
      'PERFORMANCE_IN_WINDOW_UNKNOWN',
      false,
    ]);
    expect(keys(c.sources)).toEqual(['R1', 'st-2027/3', 'st-2029/2']);
    expect(keys(c.undetermined)).toEqual(['st-2029/3']);
    const l3 = c.sources[2];
    expect(l3?.inWindow).toEqual({ lower: eur('1500.00'), upper: eur('1500.00') });
    expect(l3?.flags).toContainEqual({
      code: 'PERFORMANCE_STRADDLES_WINDOW',
      details: { edge: 'END', lower: eur('1500.00').toJSON(), upper: eur('1500.00').toJSON() },
    });
    expect(l3).toMatchObject({
      sourceType: 'WEG_STATEMENT_COST_LINE',
      date: '2029-12-31',
      taxYear: 2029,
      grossAmount: eur('3000.00'),
      amountUsed: eur('2521.01'),
      costLine: { statementPeriod: { from: '2029-01-01', until: '2029-12-31' }, account: 'Dachrinnen' },
    });
    expect(c.undetermined[0]?.flags).toContainEqual({ code: 'PERFORMANCE_DATE_MISSING', details: { date: '2029-12-31', dateSource: 'STATEMENT_PERIOD_END' } });
    expect(c.undetermined[0]?.inWindow).toEqual({ lower: eur('0.00'), upper: eur('2016.81') });
    // Every NON_RECOVERABLE line judged: no unjudged flag; the year 2030 of the read range has no statement yet.
    expect(flagOf(c, 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED')).toBeUndefined();
    expect(flagOf(c, 'WEG_STATEMENT_MISSING')).toEqual({ missing: [{ membershipId: 'm-1', financialYear: 2030 }] });
  });

  it('(a) L4 after the window: NOT_ABOVE_THRESHOLD 14.74, not final on 2030-08-01 by WEG_STATEMENT_MISSING for 2030 alone', () => {
    const c = check(example(performed('2029-05-02', '2029-05-20')));
    expect([c.status, c.percentOfBasis, c.sum, c.sumUpper, c.final]).toEqual(['NOT_ABOVE_THRESHOLD', '14.74', eur('29180.67'), eur('29180.67'), false]);
    expect(c.excluded.map((e) => [e.sourceId, e.sourcePosition, e.reason])).toEqual([['st-2029', 3, 'PERFORMED_OUTSIDE_WINDOW']]);
    expect(reasonsOf(c)).toEqual(['WEG_STATEMENT_MISSING']);
    expect(flagOf(c, 'WEG_STATEMENT_MISSING')).toEqual({ missing: [{ membershipId: 'm-1', financialYear: 2030 }] });
  });

  it('(a′) on 2031-08-01 with the statement of 2030 confirmed and judged: final, five years after the transfer', () => {
    const c = check([...example(performed('2029-05-02', '2029-05-20')), statement2030], { today: '2031-08-01' });
    expect([c.status, c.percentOfBasis, c.final, reasonsOf(c)]).toEqual(['NOT_ABOVE_THRESHOLD', '14.74', true, []]);
    // No statement of 2031 is required, and an unjudged line of one does not hold the check open.
    const l = statement(2031, () => [line(4, 'Verwaltervergütung', '600.00', null)]);
    expect(check([...example(performed('2029-05-02', '2029-05-20')), statement2030, l], { today: '2032-08-01' }).final).toBe(true);
  });

  it('(a″) the later statement of 2031: L5 performed in the window listed in outsideSearchRange, not summed; NOT_COMPUTABLE SOURCES_OUTSIDE_SEARCH_RANGE', () => {
    const later = statement(2031, (id) => [
      line(1, 'Instandsetzung Balkone', '1000.00', judged(id, 1, '840.34', performed('2029-01-05', '2029-01-25'))),
      line(2, 'Wartung', '300.00', null),
      line(3, 'Kleinreparaturen', '500.00', judged(id, 3, '420.17')),
      line(4, 'Verwaltervergütung', '600.00', judged(id, 4, null)),
      line(5, 'Instandsetzung Zaun', '200.00', judged(id, 5, '168.07', performed('2030-05-01', '2030-05-10'))),
    ]);
    const c = check([...example(performed('2029-05-02', '2029-05-20')), statement2030, later], { today: '2032-08-01' });
    expect([c.status, c.notComputableReason, c.sum, c.sumUpper, c.final]).toEqual([
      'NOT_COMPUTABLE',
      'SOURCES_OUTSIDE_SEARCH_RANGE',
      eur('29180.67'),
      eur('29180.67'),
      false,
    ]);
    // Only the dated maintenance line performed in the window; the unjudged, the undated and the one performed after are not.
    expect(keys(c.outsideSearchRange)).toEqual(['st-2031/1']);
    expect(c.outsideSearchRange[0]?.flags.map((f) => f.code)).not.toContain('PERFORMANCE_DATE_MISSING');
    expect(reasonsOf(c)).toEqual(['SOURCES_OUTSIDE_SEARCH_RANGE']);
    expect(flagOf(c, 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED')).toBeUndefined();
  });

  it('(b) L4 inside: ABOVE_THRESHOLD 15.76; R1 suggested, the cost lines flagged paidFromHausgeld without a suggestion; HAUSGELD_MAINTENANCE_ABOVE_THRESHOLD', () => {
    const c = check(example(performed('2029-01-10', '2029-01-20')));
    expect([c.status, c.percentOfBasis, c.sum, c.sumUpper, c.affectedYears]).toEqual(['ABOVE_THRESHOLD', '15.76', eur('31197.48'), eur('31197.48'), [2027]]);
    expect(c.sources.map((e) => [keys([e])[0], e.suggestedTreatment])).toEqual([
      ['R1', 'CAPITALIZED'],
      ['st-2027/3', null],
      ['st-2029/2', null],
      ['st-2029/3', null],
    ]);
    for (const e of c.sources.slice(1)) {
      expect(e.flags).toContainEqual({
        code: 'ANSCHAFFUNGSNAHE_HERSTELLUNGSKOSTEN',
        details: { acquisitionId: 'acq-q', final: false, rule: { ruleCode: 'DE_ANSCHAFFUNGSNAHE', version: 1 }, paidFromHausgeld: true },
      });
    }
    expect(reasonsOf(c)).toEqual(['WEG_STATEMENT_MISSING', 'HAUSGELD_MAINTENANCE_ABOVE_THRESHOLD']);
    expect(flagOf(c, 'HAUSGELD_MAINTENANCE_ANSCHAFFUNGSNAH')).toEqual({
      lines: [
        { statementId: 'st-2027', position: 3, inWindow: { lower: eur('1680.67'), upper: eur('1680.67') } },
        { statementId: 'st-2029', position: 2, inWindow: { lower: eur('1500.00'), upper: eur('1500.00') } },
        { statementId: 'st-2029', position: 3, inWindow: { lower: eur('2016.81'), upper: eur('2016.81') } },
      ],
    });
    // Not final even with the statement of 2030: the advisor reviews the Hausgeld deducted.
    expect(reasonsOf(check([...example(performed('2029-01-10', '2029-01-20')), statement2030], { today: '2031-08-01' }))).toEqual([
      'HAUSGELD_MAINTENANCE_ABOVE_THRESHOLD',
    ]);
  });

  it('(c) L2 not classified: WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED names the line; (a) then not final for it', () => {
    const c = check([...example(performed('2029-05-02', '2029-05-20'), { l2: null }), statement2030], { today: '2031-08-01' });
    expect(flagOf(c, 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED')).toEqual({
      statementIds: ['st-2027'],
      lines: [{ statementId: 'st-2027', position: 4, account: 'Verwaltervergütung', unitShare: eur('600.00') }],
    });
    expect([c.status, c.final, reasonsOf(c)]).toEqual(['NOT_ABOVE_THRESHOLD', false, ['WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED']]);
    // It adds nothing to the bounds and never makes the check NOT_COMPUTABLE.
    expect([c.sum, c.sumUpper]).toEqual([eur('29180.67'), eur('29180.67')]);
  });

  it('(d) no statement of 2029 yet (read on 2029-08-01): WEG_STATEMENT_MISSING for 2029 and 2030 (not ended)', () => {
    const c = check(
      example().filter((s) => s.financialYear !== 2029),
      { today: '2029-08-01' },
    );
    expect(flagOf(c, 'WEG_STATEMENT_MISSING')).toEqual({
      missing: [
        { membershipId: 'm-1', financialYear: 2029 },
        { membershipId: 'm-1', financialYear: 2030 },
      ],
    });
    expect([c.status, c.final]).toEqual(['NOT_ABOVE_THRESHOLD', false]);
  });
});

describe('maintenance paid from the Hausgeld (§58M): edges, ranges and the parameter', () => {
  const only = (l: ReturnType<typeof line>, period?: [string, string], year = 2027) => [statement(year, () => [l], period)];
  const dated = (from: string, until: string, progress: [string, string][] = [], estimated = false) =>
    line(1, 'Instandsetzung', '1000.00', judged('st-2027', 1, '1000.00', performed(from, until, progress, estimated)));

  it('the window edges: performed on S and on W counts; the day before S and after W does not', () => {
    for (const [from, until, counted] of [
      ['2026-03-15', '2026-03-15', true],
      ['2029-03-15', '2029-03-15', true],
      ['2026-03-14', '2026-03-14', false],
      ['2029-03-16', '2029-03-16', false],
    ] as const) {
      const c = check(only(dated(from, until), undefined, 2027), { sources: [] });
      expect([from, keys(c.sources).length]).toEqual([from, counted ? 1 : 0]);
    }
  });

  it('across S: only the evidenced part from S, edge START; across W without a point: bounds, edge END', () => {
    const start = check(only(dated('2026-03-01', '2026-03-31', [['2026-03-14', '300.00']])), { sources: [] }).sources[0];
    expect(start?.inWindow).toEqual({ lower: eur('700.00'), upper: eur('700.00') });
    expect(start?.flags.find((f) => f.code === 'PERFORMANCE_STRADDLES_WINDOW')?.details).toMatchObject({ edge: 'START' });
    const end = check(only(dated('2029-02-15', '2029-04-14')), { sources: [] });
    expect(end.sources[0]?.inWindow).toEqual({ lower: eur('0.00'), upper: eur('1000.00') });
    expect(end.sources[0]?.flags.find((f) => f.code === 'PERFORMANCE_STRADDLES_WINDOW')?.details).toMatchObject({ edge: 'END' });
  });

  it('an estimated point is ignored; a credit line swaps the bounds; annuallyRecurring is excluded', () => {
    expect(check(only(dated('2029-02-15', '2029-04-14', [['2029-03-15', '500.00']], true)), { sources: [] }).sources[0]?.inWindow).toEqual({
      lower: eur('0.00'),
      upper: eur('1000.00'),
    });
    const credit = check(only(line(1, 'Gutschrift Versicherung', '-500.00', judged('st-2027', 1, '420.17'))), { sources: [] });
    expect(credit.undetermined[0]).toMatchObject({ amountUsed: eur('-420.17'), inWindow: { lower: eur('-420.17'), upper: eur('0.00') } });
    expect([credit.sum, credit.sumUpper]).toEqual([eur('-420.17'), eur('0.00')]);
    const recurring = line(1, 'Wartungsvertrag Aufzug', '900.00', judged('st-2027', 1, '756.30', null, { annuallyRecurring: true }));
    expect(check(only(recurring), { sources: [] }).excluded.map((e) => e.reason)).toEqual(['ANNUALLY_RECURRING']);
  });

  it('a statement period straddling S or W, or a WEG year from July: read; one ending before S is not; one ending on S is', () => {
    const unjudged = (id: string) => [line(4, 'Verwaltervergütung', '600.00', null)].map((l) => ({ ...l, account: id }));
    const ids = (statements: ReturnType<typeof statement>[]) =>
      (flagOf(check(statements, { sources: [], memberships: [] }), 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED') as { statementIds: string[] } | undefined)
        ?.statementIds ?? [];
    expect(ids([statement(2025, unjudged, ['2025-01-01', '2025-12-31'])])).toEqual([]);
    expect(ids([statement(2025, unjudged, ['2025-03-16', '2026-03-14'])])).toEqual([]);
    expect(ids([statement(2025, unjudged, ['2025-03-16', '2026-03-15'])])).toEqual(['st-2025']);
    expect(ids([statement(2028, unjudged, ['2028-07-01', '2029-06-30'])])).toEqual(['st-2028']);
    expect(ids([statement(2029, unjudged, ['2029-07-01', '2030-06-30'])])).toEqual(['st-2029']);
    expect(ids([statement(2030, unjudged, ['2030-03-16', '2031-03-15'])])).toEqual([]);
    // A WEG year from July: the years 2025/26 (from S) to 2029/30 (W + 365 days) need their statement.
    const july = { ...membership, financialYearStartMonth: 7 };
    const missing = flagOf(check([], { sources: [], memberships: [july], today: '2031-08-01' }), 'WEG_STATEMENT_MISSING') as unknown as {
      missing: { financialYear: number }[];
    };
    expect(missing.missing.map((m) => m.financialYear)).toEqual([2025, 2026, 2027, 2028, 2029]);
  });

  it('M7 over the range of M3: the year of W + 365 days missing, not the year after; never before S; a membership ending stops it; a year not ended is missing', () => {
    const years = (input: Parameters<typeof check>[1], statements: ReturnType<typeof statement>[] = []) =>
      (
        (flagOf(check(statements, { sources: [], ...input }), 'WEG_STATEMENT_MISSING') as { missing: { financialYear: number }[] } | undefined)?.missing ?? []
      ).map((m) => m.financialYear);
    expect(years({ today: '2035-01-01' })).toEqual([2026, 2027, 2028, 2029, 2030]);
    expect(years({ today: '2035-01-01', memberships: [{ ...membership, validFrom: day('2020-01-01') }] })).toEqual([2026, 2027, 2028, 2029, 2030]);
    expect(years({ today: '2035-01-01', memberships: [{ ...membership, validUntil: day('2027-06-30') }] })).toEqual([2026, 2027]);
    // Confirmed but not ended (a statement of 2030 read on 2030-08-01): still missing.
    expect(years({ today: '2030-08-01' }, [statement2030])).toEqual([2026, 2027, 2028, 2029, 2030]);
    expect(years({ today: '2031-01-01' }, [statement2030])).toEqual([2026, 2027, 2028, 2029]);
  });

  it('the read range and the missing years are one parameter: statementsUntil OUTER_BOUND_END moves both', () => {
    const outer = withHausgeld({ statementsUntil: 'OUTER_BOUND_END' });
    const later = statement(2031, (id) => [line(1, 'Instandsetzung Balkone', '1000.00', judged(id, 1, '840.34', performed('2029-01-05', '2029-01-25')))]);
    const c = check([...example(performed('2029-05-02', '2029-05-20')), statement2030, later], { today: '2032-08-01', registry: outer });
    // L5's statement is now read: summed, not listed; and 2032 (the outer bound's year, not ended) is missing.
    expect([c.status, keys(c.outsideSearchRange), keys(c.sources).includes('st-2031/1')]).toEqual(['ABOVE_THRESHOLD', [], true]);
    expect(flagOf(c, 'WEG_STATEMENT_MISSING')).toEqual({ missing: [{ membershipId: 'm-1', financialYear: 2032 }] });
    expect(flagOf(check([...example(performed('2029-05-02', '2029-05-20'))], { registry: outer }), 'WEG_STATEMENT_MISSING')).toEqual({
      missing: [2030, 2031, 2032].map((financialYear) => ({ membershipId: 'm-1', financialYear })),
    });
  });

  it('a statement beyond the outer bound is not read; RECOVERABLE, RESERVE and 0.00 lines are never unjudged', () => {
    const beyond = statement(2032, (id) => [line(1, 'Instandsetzung', '1000.00', judged(id, 1, '840.34', performed('2029-01-05', '2029-01-25')))], [
      '2032-03-16',
      '2033-03-15',
    ]);
    expect(check([beyond], { sources: [], memberships: [] }).outsideSearchRange).toEqual([]);
    const lines = statement(2027, () => [
      line(1, 'Hausmeister', '1800.00', null, 'RECOVERABLE'),
      line(2, 'Zuführung Erhaltungsrücklage', '1200.00', null, 'RESERVE'),
      line(3, 'Rundung', '0.00', null),
    ]);
    const c = check([lines], { sources: [], memberships: [] });
    expect([flagOf(c, 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED'), c.final]).toEqual([undefined, true]);
  });

  it('a partial acquisition: the cost lines × acquiredShare, compared exactly', () => {
    const half = { ...acquisition, acquiredShare: { numerator: 1, denominator: 2 } };
    const c = check(example(performed('2029-01-10', '2029-01-20')), { acquisition: half });
    expect([c.sum, c.attributableAmount, c.status]).toEqual([eur('31197.48'), eur('15598.74'), 'NOT_ABOVE_THRESHOLD']);
  });

  it('a rule without hausgeldMaintenance: the flag as before for every statement overlapping the window, no line read', () => {
    const c = check(example(performed('2029-01-10', '2029-01-20')), { registry: withHausgeld(null) });
    expect(flagOf(c, 'WEG_HAUSGELD_MAINTENANCE_NOT_COUNTED')).toEqual({ statementIds: ['st-2026', 'st-2027', 'st-2028', 'st-2029'] });
    expect([keys(c.sources), c.sum, flagOf(c, 'WEG_STATEMENT_MISSING')]).toEqual([['R1'], eur('26000.00'), undefined]);
  });

  it('without economicTransferDate (§58K): no window, no cost line, no Hausgeld flag; TRANSFER_DATE_MISSING unchanged', () => {
    const c = check(example(performed('2029-01-10', '2029-01-20')), { acquisition: { ...acquisition, transferDate: null } });
    expect([c.status, c.notComputableReason, reasonsOf(c), c.sources, c.undetermined]).toEqual([
      'NOT_COMPUTABLE',
      'TRANSFER_DATE_MISSING',
      // Without a rule the cost classification decides nothing (§59D); no Hausgeld reason.
      ['TRANSFER_DATE_MISSING', 'ACQUISITION_COSTS_UNCLASSIFIED'],
      [],
      [],
    ]);
    expect(c.flags.map((f) => f.code)).toEqual(['NOT_FINAL', 'TRANSFER_DATE_MISSING']);
  });

  it('the cost lines follow the sources of the same date in the list order', () => {
    const atEnd = { ...R1, sourceId: 'R2', date: day('2027-12-31'), performance: performed('2027-11-01', '2027-11-30') };
    const c = check(example(), { sources: [R1, atEnd] });
    expect(keys(c.sources)).toEqual(['R1', 'R2', 'st-2027/3', 'st-2029/2']);
    expect(TAX_RULES.select('DE_ANSCHAFFUNGSNAHE', day('2026-03-15'))?.parameters).toHaveProperty('hausgeldMaintenance.statementsUntil', 'SEARCH_RANGE_END');
  });
});
