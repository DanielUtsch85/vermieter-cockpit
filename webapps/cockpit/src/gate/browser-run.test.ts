import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vite.config';

/**
 * The browser run (backlog VC-X-70) stays apart from the Vitest suites: its specs live in webapps/cockpit/e2e, end in
 * `.spec.ts` and are run by Playwright in the CI job browser-e2e only, never by `yarn test`. Playwright is pinned
 * exactly, one version in the lockfile, so the browser the job installs is the one the specs were written against.
 */

const cockpit = new URL('../../', import.meta.url);
const repository = new URL('../../', cockpit);
const read = (path: string, base = repository) => readFileSync(new URL(path, base), 'utf8');
const e2eFiles = readdirSync(new URL('e2e/', cockpit)).filter((name) => name.endsWith('.ts'));
const lockedVersions = (lock: string, name: string) =>
  [...lock.matchAll(new RegExp(`^"${name.replace('/', '\\/')}@npm:[^\\n]*\\n {2}version: (\\S+)$`, 'gm'))].map((match) => match[1]);

describe('the browser run is not a Vitest suite (VC-X-70)', () => {
  it('Vitest reads only test files under src; the Playwright specs are outside src and are no test files', () => {
    expect(config.test?.include).toEqual(['src/**/*.test.{ts,tsx}']);
    const specs = e2eFiles.filter((name) => name.endsWith('.spec.ts'));
    expect(specs.length).toBeGreaterThan(0);
    expect(e2eFiles.filter((name) => /\.test\.tsx?$/.test(name))).toEqual([]);
    for (const spec of specs) expect(read(`e2e/${spec}`, cockpit)).toMatch(/from '@playwright\/test'/);
  });

  it('the Playwright config runs exactly the specs of e2e, nothing of src', () => {
    const source = read('e2e/playwright.config.ts', cockpit);
    expect(source).toContain("testDir: '.'");
    expect(source).toContain("testMatch: '*.spec.ts'");
  });
});

describe('Playwright pinned (VC-X-70)', () => {
  it('the cockpit pins @playwright/test exactly, and the lockfile resolves it and playwright to that one version', () => {
    const manifest = JSON.parse(read('package.json', cockpit)) as { devDependencies: Record<string, string> };
    const pin = manifest.devDependencies['@playwright/test'];
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = read('yarn.lock');
    expect(lockedVersions(lock, '@playwright/test')).toEqual([pin]);
    expect(lockedVersions(lock, 'playwright')).toEqual([pin]);
    expect(lockedVersions(lock, 'playwright-core')).toEqual([pin]);
  });

  it('the CI job installs the Chromium of that workspace Playwright, never another version', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('npx --no-install playwright install --with-deps chromium');
    expect(ci).toContain('run: .github/scripts/compose-browser-e2e.sh');
  });
});
