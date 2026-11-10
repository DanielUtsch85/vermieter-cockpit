import { createApp, type AppCommands } from './app.js';
import { unusedCommands } from './app.test-support.js';
import type { InventoryRoute } from './route-inventory.js';
import { REALM, admin } from './transactions.test-support.js';

/**
 * The walk over the route inventory shared by VC-X-61's and VC-X-69's generic tests (api-design.md §58W, §58X): one valid
 * value per path parameter, the app with every command rejecting and counted, and a raw request helper. No database.
 * Test support only; synthetic values only.
 */

export const UUID = '0000f061-0000-4000-8000-000000000001';
/** One valid value per path parameter, by name: a name missing here fails the walk (a new route cannot slip through). */
export const PATH_VALUES: Readonly<Record<string, string>> = {
  acknowledgementId: UUID,
  acquisitionId: UUID,
  allocationSetId: UUID,
  assessmentId: UUID,
  assetId: UUID,
  classificationId: UUID,
  code: 'RENT_BASE',
  confirmationId: UUID,
  costId: UUID,
  depositId: UUID,
  externalReferenceId: UUID,
  financialAccountId: UUID,
  importBatchId: UUID,
  loanId: UUID,
  membershipId: UUID,
  mreRentTerm: '2027010100',
  mreTenantId: '6512f0c2a1b2c3d4e5f60a61',
  ownershipId: UUID,
  partyId: UUID,
  paymentId: UUID,
  planId: UUID,
  position: '1',
  propertyReferenceId: UUID,
  reconciliationId: UUID,
  recordId: UUID,
  rentalContractReferenceId: UUID,
  reviewItemId: UUID,
  ruleCode: 'DE_82B_DISTRIBUTION',
  securityDepositId: UUID,
  splitId: UUID,
  statementId: UUID,
  termsId: UUID,
  transactionId: UUID,
  versionId: UUID,
  wegId: UUID,
  year: '2027',
};

/** A malformed value per path parameter that is checked for its format (`ruleCode` is looked up, never malformed). */
const MALFORMED: Readonly<Record<string, string>> = { code: 'x', mreRentTerm: '2027', mreTenantId: 'x', position: 'x', year: 'x' };
export const malformed = (name: string) => (PATH_VALUES[name] === UUID ? 'not-an-id' : MALFORMED[name]);

export const paramsOf = (path: string) => [...path.matchAll(/:(\w+)/g)].map((m) => m[1] as string);
export const fill = (path: string, value: (name: string) => string) => path.replace(/:(\w+)/g, (_m, name: string) => value(name));
export const valueOf = (name: string) => {
  const value = PATH_VALUES[name];
  if (value === undefined) throw new Error(`no test value for the path parameter ${name}`);
  return value;
};
export const key = (r: InventoryRoute) => `${r.method} ${r.path}`;

export type Call = { module: string; command: string; args: unknown };
export type Answer = { status: number; code: string | undefined; fields: { field: string; code: string }[] | undefined };

/**
 * A server whose every command rejects and is recorded in `calls`, or answers with `answers[module.command]` when given
 * (a spy of the arguments). The caller registers `start` and `stop` (`beforeAll`, `afterAll`; this file imports no test
 * framework and no Node module, by the architecture rule of `api/`). Returns the calls and the raw request helper.
 */
export function countedApp(answers: Readonly<Record<string, (args: unknown) => unknown>> = {}) {
  const calls: Call[] = [];
  const counted = Object.fromEntries(
    Object.entries(unusedCommands).map(([module, commands]) => [
      module,
      Object.fromEntries(
        Object.keys(commands as object).map((command) => [
          command,
          (args: unknown) => {
            calls.push({ module, command, args });
            const answer = answers[`${module}.${command}`];
            return answer === undefined ? Promise.reject(new Error('not used in this test')) : Promise.resolve(answer(args));
          },
        ]),
      ),
    ]),
  ) as unknown as AppCommands;

  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  let base = '';
  const start = async () => {
    const listening = createApp({ isReady: async () => true, verifyPrincipal: admin, ...counted }).listen(0, '127.0.0.1');
    server = listening;
    await new Promise<void>((resolve) => listening.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;
  };
  const stop = async () => {
    const listening = server;
    if (listening === undefined) return;
    listening.closeAllConnections();
    await new Promise<void>((resolve) => listening.close(() => resolve()));
  };

  /** Sends `body` as given (raw text, so a key like `__proto__` arrives as sent); no content type without a body. */
  async function send(method: string, url: string, body?: string, contentType = 'application/json', extra: Record<string, string> = {}): Promise<Answer> {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { authorization: 'Bearer a.b.c', organizationid: REALM, ...(body === undefined ? {} : { 'content-type': contentType }), ...extra },
      ...(body === undefined ? {} : { body }),
    });
    const text = await res.text();
    const json = text.startsWith('{') ? (JSON.parse(text) as { error?: { code?: string; details?: { fields?: Answer['fields'] } } }) : {};
    return { status: res.status, code: json.error?.code, fields: json.error?.details?.fields };
  }

  return { calls, send, start, stop };
}
