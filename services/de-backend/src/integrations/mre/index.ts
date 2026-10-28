/**
 * MRE integration: anti-corruption layer behind the MreClient interface
 * (ADR-034, mre-integration.md, coding-guidelines §6).
 */
export { MreClientError } from './mre-client.js';
export type { MreAddress, MreClient, MreClientErrorCode, MreMemberRole, MreProperty, MreRealmMembership } from './mre-client.js';
export { HttpMreClient } from './http-mre-client.js';
export type { HttpMreClientOptions } from './http-mre-client.js';
export { MreAuthError, bearerToken, verifyMrePrincipal } from './mre-auth.js';
export type { MreAuthErrorCode, VerifiedMrePrincipal } from './mre-auth.js';
