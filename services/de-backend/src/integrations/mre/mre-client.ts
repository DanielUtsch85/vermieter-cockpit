import type { BusinessDate, ExactDecimal, Money } from '../../shared/index.js';

/**
 * Anti-corruption boundary to MicroRealEstate (ADR-034, mre-integration.md,
 * coding-guidelines §6). Domain and application code depend on this interface
 * and on the DE integration models below, never on MRE DTOs or HTTP.
 */

/** MRE realm roles a landlord-side member can hold (MRE `UserRole`). */
export type MreMemberRole = 'administrator' | 'renter';

/** A Realm the caller belongs to, reduced to what DE needs for authorization. */
export interface MreRealmMembership {
  readonly mreRealmId: string;
  readonly name: string;
  readonly members: readonly { readonly email: string; readonly role: MreMemberRole }[];
}

/** An MRE Property reduced to what DE caches for a PropertyReference (data-model.md §9). */
export interface MreProperty {
  readonly mrePropertyId: string;
  readonly name: string | null;
  readonly address: MreAddress | null;
  /** MRE stores surface as a JS number; DE keeps its decimal text exactly. */
  readonly surface: ExactDecimal | null;
}

export interface MreAddress {
  readonly street1?: string;
  readonly street2?: string;
  readonly zipCode?: string;
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
}

/**
 * One MRE rent term reduced to what the coverage read shows (api-design.md §37.2): its amount due without the carried
 * balance and MRE's own payment records. Amounts are MRE floats rounded half-up to the cent. Nothing else is read.
 */
export interface MreRentTerm {
  readonly amountDue: Money;
  readonly payments: readonly MreRentPayment[];
}

/** An MRE payment record: settlement, not cash (BR-RENT-001). `description` is not read. */
export interface MreRentPayment {
  /** MRE's `DD/MM/YYYY` as a business date; null when it does not parse. */
  readonly date: BusinessDate | null;
  readonly amount: Money;
  readonly type: string | null;
  readonly reference: string | null;
}

/** One rent of an MRE month read (api-design.md §37.3): the Tenant, the term key and the amount due only. */
export interface MreMonthRent {
  readonly mreTenantId: string;
  /** `YYYYMMDDHH` as text. */
  readonly term: string;
  readonly amountDue: Money;
}

/**
 * A payment of an MRE rent term as the write-back reads it (api-design.md §37.4): each value exactly as MRE answered it
 * (a JSON number, string, null or absent), never converted, so the round trip changes nothing.
 */
export interface MreRawPayment {
  readonly date: unknown;
  readonly amount: unknown;
  readonly type: unknown;
  readonly reference: unknown;
  readonly description: unknown;
}

/**
 * An MRE rent term as the write-back reads and writes it back (api-design.md §37.4): the Tenant's `_id`, its VAT ratio
 * and the term's whole settlement with raw values. The occupant object with the Tenant's personal data is dropped.
 */
export interface MreRawTerm {
  readonly mreTenantId: string;
  /** `YYYYMMDDHH` as text. */
  readonly term: string;
  /** 0 when MRE has none. */
  readonly vatRatio: number;
  readonly payments: readonly MreRawPayment[];
  readonly promo: number;
  readonly notepromo: string;
  readonly extracharge: number;
  readonly noteextracharge: string;
  readonly description: string;
}

/** A payment as the write-back sends it, in the form MRE's `_updateByTerm` stores. */
export interface MrePaymentWrite {
  readonly date: unknown;
  readonly amount: number;
  readonly type: unknown;
  readonly reference: unknown;
  readonly description: unknown;
}

/** The body of `PATCH /rents/payment/:id/:term` without its `_id`: the term's whole settlement (§37.4). */
export interface MreTermWrite {
  readonly payments: readonly MrePaymentWrite[];
  readonly promo: number;
  readonly notepromo: string;
  readonly extracharge: number;
  readonly noteextracharge: string;
  readonly description: string;
}

/**
 * How a PATCH ended: MRE answered the saved term; no answer (a timeout, a dropped connection, an unreadable body), so
 * it may or may not have been saved; or MRE refused it with an error status.
 */
export type MreTermWriteResult =
  | { readonly kind: 'ANSWERED'; readonly term: MreRawTerm }
  | { readonly kind: 'NO_ANSWER'; readonly message: string }
  | { readonly kind: 'REFUSED'; readonly status: number };

export type MreClientErrorCode =
  /** MRE rejected the token (missing, malformed, expired, bad signature): HTTP 401. */
  | 'UNAUTHENTICATED'
  /** MRE accepted the token but refused the caller (e.g. a tenant token): HTTP 403. */
  | 'FORBIDDEN'
  /** MRE unreachable, timed out, or answered with an unexpected status or body. */
  | 'UNAVAILABLE';

export class MreClientError extends Error {
  override readonly name = 'MreClientError';

  constructor(
    readonly code: MreClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MreClient {
  /**
   * Realms the bearer of `accessToken` is a member of. MRE verifies the token
   * (signature, expiry) and resolves membership server-side.
   */
  listRealms(accessToken: string): Promise<readonly MreRealmMembership[]>;

  /**
   * Properties of one Realm as visible to the bearer of `accessToken`; MRE
   * enforces membership and Realm isolation (mre-integration.md §21.1).
   */
  listProperties(accessToken: string, mreRealmId: string): Promise<readonly MreProperty[]>;

  /**
   * The `_id`s of one Realm's Tenants, as visible to the bearer of `accessToken`. MRE's list has no filter, so the
   * caller looks for the id itself (mre-integration.md §20.1); nothing else of a Tenant is read.
   */
  listTenantIds(accessToken: string, mreRealmId: string): Promise<readonly string[]>;

  /**
   * Whether the MRE Tenant `mreTenantId` of the Realm has the rent term `term` (`YYYYMMDDHH`), read through
   * `GET /rents/tenant/:id/:term` (mre-integration.md §19). MRE answers `404` for an unknown Tenant, an unknown term
   * and a Tenant of another Realm; at the baseline also when its own database read fails (the error is swallowed),
   * so `false` means "MRE did not return this term" (api-design.md §37.1). Nothing of the term is kept.
   */
  rentTermExists(accessToken: string, mreRealmId: string, mreTenantId: string, term: string): Promise<boolean>;

  /**
   * The rent term as `rentTermExists` reads it, parsed to its amount due and payments (api-design.md §37.2);
   * undefined on MRE's `404`, with the same meaning.
   */
  readRentTerm(accessToken: string, mreRealmId: string, mreTenantId: string, term: string): Promise<MreRentTerm | undefined>;

  /**
   * Every rent of the Realm in one month, `GET /rents/:year/:month` (api-design.md §37.3), parsed to the Tenant's
   * `_id`, the term and the amount due; the occupant object with the Tenant's name and contacts is dropped.
   */
  listRentTerms(accessToken: string, mreRealmId: string, year: number, month: number): Promise<readonly MreMonthRent[]>;

  /**
   * The rent term as `readRentTerm` reads it, with its raw values for the write-back's round trip (api-design.md
   * §37.4); undefined on MRE's `404`.
   */
  readRentTermForWriteBack(accessToken: string, mreRealmId: string, mreTenantId: string, term: string): Promise<MreRawTerm | undefined>;

  /**
   * `PATCH /rents/payment/:id/:term` with `_id: mreTenantId` in the body (MRE ignores the path's `:id`, review on
   * #75): replaces the term's whole settlement with `write`. `401` / `403` throw as everywhere; every other outcome is
   * a result, since a PATCH without an answer may still have been saved.
   */
  writeRentTermPayments(accessToken: string, mreRealmId: string, mreTenantId: string, term: string, write: MreTermWrite): Promise<MreTermWriteResult>;
}
