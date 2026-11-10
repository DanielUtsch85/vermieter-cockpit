import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * VC-X-66: Express 5's `app.listen` hands a listen error (a port in use) to its callback, where Express 4 left the
 * `error` event unhandled and the process stopped. `main.ts` runs on import, so its callback is pinned on its source: it
 * takes the error and throws it before it logs "listening", and the start fails as before.
 */
const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

describe('the start fails on a listen error, as under Express 4 (VC-X-66)', () => {
  it('Express 5 hands a port in use to the listen callback, not to an unhandled error event', async () => {
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const { port } = blocker.address() as AddressInfo;
    const error = await new Promise<Error | undefined>((resolve) => {
      const server = express().listen(port, '127.0.0.1', (e?: Error) => resolve(e));
      servers.push(server);
    });
    expect((error as NodeJS.ErrnoException | undefined)?.code).toBe('EADDRINUSE');
  });

  it('main.ts throws the error in its listen callback before it logs listening', () => {
    const source = readFileSync(MAIN, 'utf8');
    const listen = source.indexOf('const server = app.listen(config.PORT, (error?: Error) => {');
    const thrown = source.indexOf('if (error !== undefined) throw error;', listen);
    const logged = source.indexOf('console.log(`de-backend listening on port ${config.PORT}`);', listen);
    expect(listen).toBeGreaterThan(-1);
    expect(thrown).toBeGreaterThan(listen);
    expect(logged).toBeGreaterThan(thrown);
    // Counter-check: the callback without the error parameter (Express 4's form) is not there any more.
    expect(source).not.toContain('app.listen(config.PORT, () => {');
  });
});
