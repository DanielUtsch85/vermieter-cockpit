import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from './app.js';

let server: Server | undefined;

async function start(deps: AppDependencies): Promise<string> {
  server = createApp(deps).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe('health endpoints', () => {
  it('liveness answers ok without touching dependencies', async () => {
    let called = false;
    const base = await start({ isReady: async () => ((called = true), false) });
    const res = await fetch(`${base}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(called).toBe(false);
  });

  const readinessCases: [string, AppDependencies['isReady'], number, string][] = [
    ['ready', async () => true, 200, 'ok'],
    ['not ready', async () => false, 503, 'unavailable'],
    ['throwing check', () => Promise.reject(new Error('boom')), 503, 'unavailable'],
  ];
  it.each(readinessCases)('readiness: %s → %i', async (_label, isReady, status, body) => {
    const base = await start({ isReady });
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ status: body });
  });

  it('unknown routes are 404 JSON and the framework is not advertised', async () => {
    const base = await start({ isReady: async () => true });
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
