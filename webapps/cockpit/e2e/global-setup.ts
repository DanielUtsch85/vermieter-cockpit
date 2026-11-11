import { seedStack } from './stack';

/** Seeds once per run and hands the ids to the workers (Playwright passes the environment of the global setup on). */
export default async function globalSetup(): Promise<void> {
  process.env['E2E_SEED'] = JSON.stringify(await seedStack());
}
