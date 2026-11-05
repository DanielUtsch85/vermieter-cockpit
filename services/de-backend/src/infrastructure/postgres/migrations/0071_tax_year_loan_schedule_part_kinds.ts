import { sql, type Kysely } from 'kysely';

/**
 * VC-X-54: a Loan's terms period added or voided, or its closing, as a part change (api-design.md §58P "Migration";
 * Entscheidung des Projektinhabers, 2026-11-05, §58P Fragen 1–11, alle wie vorgeschlagen: three kinds by record action,
 * voids count, one migration without a redundant `LoanTerms` clause). Additive to 0060, 0063–0065 and 0067; no column on
 * `loan_terms`, `loan`, `loan_allocation_set` or any ledger or Taxation table, no backfill, no AuditRecord.
 *
 * - `tax_year_acknowledgement_change_kind_check`: 0067's list plus `LOAN_TERMS_PART_ADDED`, `LOAN_TERMS_PART_VOIDED`,
 *   `LOAN_CLOSED_PART` (dropped and re-added under its name, as 0063–0067).
 * - `tax_year_acknowledgement_change_entity_type_check`: unchanged (`LoanTerms`, `Loan` are listed).
 * - `tax_year_acknowledgement_kind_entity`: 0067's text with the `Loan` clause widened by `LOAN_CLOSED_PART`. No
 *   `LoanTerms` clause: every other entity type's clause already refuses the terms kinds, and every other kind has a
 *   clause naming its own entity, so the terms kinds are bound to `LoanTerms` by elimination (pinned by a schema test).
 * - The shape guard `tax_year_acknowledgement_item_shape()` (0065's, as patched by 0067): the part kinds' `IN` list
 *   gains the three kinds, patched in its current definition (`pg_get_functiondef`, the passage found exactly once).
 * - `down` refuses (`check_violation`, before changing anything) while an acknowledgement of a new kind exists
 *   (`ACTIVE` or `WITHDRAWN`: a person's statement is never dropped silently), else reverses the patch and restores
 *   0067's CHECKs verbatim.
 */

const NEW_KINDS = `'LOAN_TERMS_PART_ADDED', 'LOAN_TERMS_PART_VOIDED', 'LOAN_CLOSED_PART'`;

/** 0067's CHECKs of `tax_year_acknowledgement`, restored by `down`. */
const KINDS_0067 = `'RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED', 'RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'LOAN_TERMS_ADDED', 'LOAN_TERMS_VOIDED', 'LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED', 'LOAN_CLOSED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED', 'DEPOSIT_REOPENED', 'DEPOSIT_CLOSED', 'TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED', 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER'`;
const kindEntity = (
  loanKinds: string,
) => `(change_entity_type = 'RentalContractReference') = (change_kind IN ('RENT_DUE_DAYS_AMENDED', 'RENT_DUE_DAYS_CREATED'))
        AND (change_entity_type = 'RentPaymentReconciliation') = (change_kind IN ('RECONCILIATION_CONFIRMED', 'RECONCILIATION_RELEASED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED'))
        AND (change_entity_type = 'LoanAllocationSet') = (change_kind IN ('LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED'))
        AND (change_entity_type = 'Loan') = (${loanKinds})
        AND (change_entity_type = 'SecurityDeposit') = (change_kind IN ('DEPOSIT_REOPENED', 'DEPOSIT_CLOSED'))
        AND (change_entity_type = 'Transaction') = (change_kind IN ('TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED'))
        AND (change_entity_type = 'Acquisition') = (change_kind = 'OWNERSHIP_START_BEFORE_ECONOMIC_TRANSFER')`;
const KIND_ENTITY_0067 = kindEntity(`change_kind = 'LOAN_CLOSED'`);
const KIND_ENTITY_0071 = kindEntity(`change_kind IN ('LOAN_CLOSED', 'LOAN_CLOSED_PART')`);

/** The part kinds of 0065's shape guard (its first test), and the same list with the three kinds of 0071. */
const PART_KINDS_0065 = `(kind IN ('LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED', 'TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED'))`;
const PART_KINDS_0071 = `(kind IN ('LOAN_ALLOCATION_SET_ADDED', 'LOAN_ALLOCATION_SET_VOIDED', 'DEPOSIT_RECONCILIATION_CONFIRMED', 'DEPOSIT_RECONCILIATION_RELEASED', 'TRANSACTION_CORRECTED', 'TRANSACTION_REVERSED', ${NEW_KINDS}))`;
const SHAPE_GUARD = 'tax_year_acknowledgement_item_shape()';

/** Replaces `from` by `to` in the function's current definition, which must hold `from` exactly once (as 0067). */
async function patchFunction(db: Kysely<unknown>, fn: string, from: string, to: string): Promise<void> {
  const { rows } = await sql<{ def: string }>`SELECT pg_get_functiondef(${fn}::regprocedure) AS def`.execute(db);
  const def = rows[0]?.def ?? '';
  const count = def.split(from).length - 1;
  if (count !== 1) throw new Error(`0071: ${fn} holds the passage to replace ${count} times, expected once`);
  await sql.raw(def.replace(from, () => to)).execute(db);
}

async function constraints(db: Kysely<unknown>, kinds: string, kindEntityText: string): Promise<void> {
  await sql`
    ALTER TABLE tax_year_acknowledgement
      DROP CONSTRAINT tax_year_acknowledgement_change_kind_check,
      DROP CONSTRAINT tax_year_acknowledgement_kind_entity,
      ADD CONSTRAINT tax_year_acknowledgement_change_kind_check CHECK (change_kind IN (${sql.raw(kinds)})),
      ADD CONSTRAINT tax_year_acknowledgement_kind_entity CHECK (${sql.raw(kindEntityText)})
  `.execute(db);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await constraints(db, `${KINDS_0067}, ${NEW_KINDS}`, KIND_ENTITY_0071);
  await patchFunction(db, SHAPE_GUARD, PART_KINDS_0065, PART_KINDS_0071);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Refused before anything is changed (api-design §58P "down"; §58E: a person's statement is never dropped silently).
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM tax_year_acknowledgement WHERE change_kind IN (${sql.raw(NEW_KINDS)})) THEN
        RAISE EXCEPTION 'tax_year_acknowledgement: an acknowledgement of a kind of §58P exists; it is never dropped silently (api-design §58P)'
          USING ERRCODE = 'check_violation';
      END IF;
    END $$
  `.execute(db);
  await patchFunction(db, SHAPE_GUARD, PART_KINDS_0071, PART_KINDS_0065);
  await constraints(db, KINDS_0067, KIND_ENTITY_0067);
}
