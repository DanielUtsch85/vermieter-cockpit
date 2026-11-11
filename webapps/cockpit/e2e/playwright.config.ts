import { defineConfig, devices } from '@playwright/test';

/**
 * The cockpit's browser run (backlog VC-X-70; Entscheidung des Projektinhabers, 2026-11-10, zu #319 Frage 3 (b), and
 * 2026-11-11, V1 point 4): Chromium headless through Caddy against the stack of docker-compose.yml plus
 * docker-compose.proxy.yml with the real `cockpit-ui` service. Started by `.github/scripts/compose-browser-e2e.sh`,
 * which brings the stack up and trusts the root of Caddy's local CA in the browser's certificate store; no
 * `ignoreHTTPSErrors`. Not Vitest: these specs live outside `src/` and end in `.spec.ts`.
 */
const host = process.env['COCKPIT_HOSTNAME'] ?? 'cockpit.internal';
const results = new URL('../e2e-results/', import.meta.url).pathname;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  outputDir: `${results}test-results`,
  // One stack, one worker, the files in order; nothing is retried, a flaky step is a red step.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: `${results}report` }]],
  use: {
    baseURL: `https://${host}`,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    // A click on a control that is not there fails after 15 s, not at the test's timeout.
    actionTimeout: 15_000,
    // `--trace off` by default (the CLI flag in the script says it again); a failure keeps its screenshot in the report.
    trace: 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      // The cockpit hostname is Caddy on 127.0.0.1:443 (as the gate's `curl --resolve`); no proxy between them.
      args: [`--host-resolver-rules=MAP ${host} 127.0.0.1`, '--no-proxy-server'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
