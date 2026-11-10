import type { DeClient } from './client';

/** `GET /api/v1/health` (api/app.ts): the guard accepted token and Realm; answers the Realm DE verified (§47.1). */
export interface HealthDto {
  readonly status: 'ok';
  readonly mreRealmId: string;
}

export async function fetchHealth(client: DeClient, signal?: AbortSignal): Promise<HealthDto> {
  return (await client.get<HealthDto>('/health', signal === undefined ? {} : { signal })).data;
}
