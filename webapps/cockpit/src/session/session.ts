import { ApiError, CLIENT_CODES } from '../api/errors';
import type { TokenSource } from '../api/transport';
import type { MreAuthenticator } from './mre-authenticator';

/**
 * The MRE session of the cockpit (mre-integration.md §47.2, ui-guide.md §7.2). The access token lives in this object's
 * memory only, never in `localStorage`, `sessionStorage` or a cookie of its own; a reload restores the session from the
 * authenticator's refresh cookie. MRE access tokens live 30 s, so a token is renewed shortly before it expires and once
 * more after a `401`; concurrent renewals share one refresh call, because the authenticator spends a refresh token on use.
 */
export type SessionState =
  | { readonly status: 'checking' }
  /** `expired`: the session ended without a sign-out (refresh refused, renewed token refused again). */
  | { readonly status: 'signedOut'; readonly expired: boolean }
  /** The authenticator did not answer at start; shown, retried only on the user's request (§47.2 point 4). */
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'signedIn';
      /** The token's `account.email`, for display only; access is decided by DE on every call (§47.1). */
      readonly email: string | undefined;
      /** Counts sign-ins: the first part of every query key after the Realm (ui-guide.md §7.3). */
      readonly epoch: number;
      /** When the token was last renewed through the refresh cookie (the gate shows it). */
      readonly renewedAt: Date | undefined;
    };

/** Renew a token this long before its `exp`. */
const RENEW_MARGIN_MS = 5_000;
/** A token without a readable `exp` is treated as MRE's 30 s token: renewed after 25 s. */
const FALLBACK_LIFETIME_MS = 30_000;

/** The unverified payload of a JWT, for `exp` and the email only; the signature is MRE's and DE's business (§47.1). */
export function readTokenClaims(token: string): { exp: number | undefined; email: string | undefined } {
  try {
    const part = token.split('.')[1] ?? '';
    const json = atob(
      part
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(part.length / 4) * 4, '='),
    );
    const payload = JSON.parse(json) as { exp?: unknown; account?: { email?: unknown } };
    return {
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
      email: typeof payload.account?.email === 'string' ? payload.account.email : undefined,
    };
  } catch {
    return { exp: undefined, email: undefined };
  }
}

const sessionExpired = () => new ApiError(401, CLIENT_CODES.sessionExpired, 'The MRE session has ended; sign in again.');

export class Session implements TokenSource {
  private state: SessionState = { status: 'checking' };
  private token: { readonly value: string; readonly renewAt: number } | undefined;
  private pending: Promise<string> | undefined;
  private epoch = 0;
  /**
   * Counts every end or start of a session (sign-in, sign-out, expiry). A refresh answer is applied only when the
   * generation is still the one it started in, so a late answer never signs a user back in after a sign-out.
   */
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly mre: MreAuthenticator,
    private readonly now: () => number = Date.now,
  ) {}

  readonly getState = (): SessionState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** At start: reuse the MRE session of the refresh cookie, if there is one. */
  async start(): Promise<void> {
    this.set({ status: 'checking' });
    const generation = this.generation;
    try {
      const token = await this.mre.refresh();
      if (generation !== this.generation) return;
      if (token === undefined) this.set({ status: 'signedOut', expired: false });
      else this.signedIn(token, undefined);
    } catch {
      if (generation === this.generation) this.set({ status: 'unavailable' });
    }
  }

  /** Rejects with a `SignInError`; the state stays signed out then. */
  async signIn(email: string, password: string): Promise<void> {
    const token = await this.mre.signIn(email, password);
    this.generation += 1;
    this.epoch += 1;
    this.signedIn(token, undefined);
  }

  /**
   * Ends the session at once in memory, then in MRE. A refresh already on its way is awaited first: its answer may set a
   * new refresh cookie, and only a sign-out after it clears that cookie. Its result is discarded (generation).
   */
  async signOut(): Promise<void> {
    this.generation += 1;
    this.token = undefined;
    this.set({ status: 'signedOut', expired: false });
    await this.pending?.catch(() => undefined);
    await this.mre.signOut();
  }

  async accessToken(): Promise<string> {
    if (this.state.status !== 'signedIn' || this.token === undefined) throw sessionExpired();
    if (this.now() < this.token.renewAt) return this.token.value;
    return this.renew();
  }

  renew(): Promise<string> {
    if (this.state.status !== 'signedIn') return Promise.reject(sessionExpired());
    const generation = this.generation;
    this.pending ??= this.mre
      .refresh()
      .then((token) => {
        if (generation !== this.generation) throw sessionExpired();
        if (token === undefined) {
          this.expire();
          throw sessionExpired();
        }
        this.signedIn(token, new Date(this.now()));
        return token;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  expire(): void {
    this.generation += 1;
    this.token = undefined;
    this.set({ status: 'signedOut', expired: true });
  }

  private signedIn(token: string, renewedAt: Date | undefined): void {
    const { exp, email } = readTokenClaims(token);
    const expiresAt = exp === undefined ? this.now() + FALLBACK_LIFETIME_MS : exp * 1000;
    this.token = { value: token, renewAt: expiresAt - RENEW_MARGIN_MS };
    this.set({ status: 'signedIn', email, epoch: this.epoch, renewedAt });
  }

  private set(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}
