import { Money, type BusinessDate } from '../../shared/index.js';
import type { SecurityDeposit } from './deposit.js';

/**
 * A deposit's figures (api-design.md §47.3, phase-5-plan P5-D2, P5-D4), derived on every read from the cash that counts
 * (§47.2): the splits with its id on current Transactions. Never stored, so a correction moves them at once.
 */

export const CASH_KINDS = ['RECEIPT', 'REPAYMENT', 'INTEREST'] as const;
export type CashKind = (typeof CASH_KINDS)[number];

export const DEPOSIT_STATES = ['CLOSED', 'RETURNED', 'PARTIALLY_RETURNED', 'RECEIVED', 'PARTIALLY_RECEIVED', 'EXPECTED'] as const;
export type DepositState = (typeof DEPOSIT_STATES)[number];

/** One counted split, in booking-date order, then Transaction id and position. */
export interface CountedCash {
  readonly transactionId: string;
  readonly bookingDate: BusinessDate;
  readonly financialAccountId: string;
  readonly kind: CashKind;
  readonly amount: Money;
}

export type DepositFlag =
  | { readonly code: 'RECEIVED_EXCEEDS_EXPECTED'; readonly details: { readonly excess: Money } }
  | { readonly code: 'RETURNED_EXCEEDS_HELD'; readonly details: { readonly excess: Money } }
  | { readonly code: 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT'; readonly details: { readonly transactionIds: readonly string[] } };

export interface DepositFigures {
  readonly received: Money;
  readonly interestCredited: Money;
  readonly returned: Money;
  /** max(expected − received, 0); interest never reduces it (P5-D5). */
  readonly outstanding: Money;
  /** received + interest − returned, signed: negative when more was repaid than held. */
  readonly held: Money;
  readonly state: DepositState;
  readonly flags: readonly DepositFlag[];
}

/** A deposit as every response shows it: the record and its figures; `cash` on the single read only. */
export interface DepositView extends SecurityDeposit {
  readonly figures: DepositFigures;
  readonly cash?: readonly CountedCash[];
}

/** The kind of a counted split by category and direction (§47.3's table); undefined for anything else. */
export function cashKindOf(financialCategoryCode: string, direction: string): CashKind | undefined {
  if (financialCategoryCode === 'SECURITY_DEPOSIT') return direction === 'INFLOW' ? 'RECEIPT' : direction === 'OUTFLOW' ? 'REPAYMENT' : undefined;
  return financialCategoryCode === 'SECURITY_DEPOSIT_INTEREST' ? 'INTEREST' : undefined;
}

/** §47.3: the sums, `state` in its order and the flags in theirs. */
export function deriveFigures(
  deposit: Pick<SecurityDeposit, 'status' | 'expectedAmount' | 'holdingFinancialAccountId'>,
  cash: readonly CountedCash[],
): DepositFigures {
  const currency = deposit.expectedAmount.currency;
  const sum = (kind: CashKind) =>
    Money.sum(
      cash.filter((c) => c.kind === kind).map((c) => c.amount),
      currency,
    );
  const received = sum('RECEIPT');
  const interestCredited = sum('INTEREST');
  const returned = sum('REPAYMENT');
  const short = deposit.expectedAmount.subtract(received);
  const outstanding = short.isNegative() ? Money.zero(currency) : short;
  const held = received.add(interestCredited).subtract(returned);

  const state: DepositState =
    deposit.status === 'CLOSED'
      ? 'CLOSED'
      : returned.isPositive() && !held.isPositive()
        ? 'RETURNED'
        : returned.isPositive()
          ? 'PARTIALLY_RETURNED'
          : outstanding.isZero() && received.isPositive()
            ? 'RECEIVED'
            : received.isPositive()
              ? 'PARTIALLY_RECEIVED'
              : 'EXPECTED';

  const flags: DepositFlag[] = [];
  const excess = received.subtract(deposit.expectedAmount);
  if (excess.isPositive()) flags.push({ code: 'RECEIVED_EXCEEDS_EXPECTED', details: { excess } });
  if (held.isNegative()) flags.push({ code: 'RETURNED_EXCEEDS_HELD', details: { excess: held.negate() } });
  const holding = deposit.holdingFinancialAccountId;
  if (holding !== null) {
    const outside = [...new Set(cash.filter((c) => c.kind === 'RECEIPT' && c.financialAccountId !== holding).map((c) => c.transactionId))];
    if (outside.length > 0) flags.push({ code: 'RECEIVED_OUTSIDE_HOLDING_ACCOUNT', details: { transactionIds: outside } });
  }
  return { received, interestCredited, returned, outstanding, held, state, flags };
}
