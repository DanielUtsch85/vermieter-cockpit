import type { Kysely } from 'kysely';
import type {
  ComparisonContext,
  ConfirmStatementOutcome,
  CreateStatementOutcome,
  NewAnnualStatement,
  Page,
  PageRequest,
  ReplaceStatementOutcome,
  SettlementContext,
  StatementContent,
  StatementFilter,
  StatementView,
  VoidStatementOutcome,
  WegAnnualStatementRepository,
} from '../../domains/weg/index.js';
import type { AuditActor } from '../../shared/index.js';
import type { Database } from './schema.js';
import * as comparison from './weg-statement-comparison.js';
import * as store from './weg-statement-store.js';

export { lockStatementsOf } from './weg-statement-comparison.js';
export { reserveFromJson } from './weg-statement-rows.js';

/**
 * PostgreSQL implementation of the Jahresabrechnung port (api-design.md §50).
 *
 * One class for the one port, delegating along the domain's cuts: the lifecycle (create, replace, confirm, void, find,
 * list) in `weg-statement-store.ts`; §51's comparison, a settlement's context and `lockStatementsOf` in
 * `weg-statement-comparison.ts`. The rows, the stored reserve and their mapping are in `weg-statement-rows.ts`.
 */
export class PostgresWegAnnualStatementRepository implements WegAnnualStatementRepository {
  constructor(private readonly db: Kysely<Database>) {}

  createStatement(
    statement: NewAnnualStatement,
    actor: AuditActor,
    idempotency?: { readonly key: string; readonly fingerprint: string },
  ): Promise<CreateStatementOutcome> {
    return store.createStatement(this.db, statement, actor, idempotency);
  }

  replaceStatement(
    id: string,
    mreRealmId: string,
    content: StatementContent,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<ReplaceStatementOutcome> {
    return store.replaceStatement(this.db, id, mreRealmId, content, actor, expectedVersions);
  }

  confirmStatement(id: string, mreRealmId: string, at: Date, actor: AuditActor, expectedVersions?: readonly number[]): Promise<ConfirmStatementOutcome> {
    return store.confirmStatement(this.db, id, mreRealmId, at, actor, expectedVersions);
  }

  voidStatement(
    id: string,
    mreRealmId: string,
    reason: string,
    at: Date,
    actor: AuditActor,
    expectedVersions?: readonly number[],
  ): Promise<VoidStatementOutcome> {
    return store.voidStatement(this.db, id, mreRealmId, reason, at, actor, expectedVersions);
  }

  findStatement(id: string, mreRealmId: string): Promise<StatementView | undefined> {
    return store.findStatement(this.db, id, mreRealmId);
  }

  listStatements(membershipId: string, mreRealmId: string, filter: StatementFilter, page: PageRequest): Promise<Page<StatementView> | undefined> {
    return store.listStatements(this.db, membershipId, mreRealmId, filter, page);
  }

  comparisonContext(statementId: string, mreRealmId: string): Promise<ComparisonContext> {
    return comparison.comparisonContext(this.db, statementId, mreRealmId);
  }

  settlementContext(transactionId: string, statementId: string, mreRealmId: string): Promise<SettlementContext> {
    return comparison.settlementContext(this.db, transactionId, statementId, mreRealmId);
  }
}
