import { describe, expect, it } from 'vitest';
import { reloadWhenRestoredFromCache } from './navigation';

/** A window that only records its `pageshow` listener. */
function fakeWindow() {
  let listener: ((event: { persisted: boolean }) => void) | undefined;
  const target = {
    addEventListener: (type: string, handler: (event: { persisted: boolean }) => void) => {
      if (type === 'pageshow') listener = handler;
    },
  } as unknown as Pick<Window, 'addEventListener'>;
  return { target, show: (persisted: boolean) => listener?.({ persisted }) };
}

describe('a page restored from the back-forward cache (sign-out stays final)', () => {
  it('is loaded afresh, so its session is checked again with the authenticator', () => {
    const { target, show } = fakeWindow();
    let reloads = 0;
    reloadWhenRestoredFromCache(target, () => (reloads += 1));
    show(true);
    expect(reloads).toBe(1);
  });

  it('counter-check: a normal page load is not loaded twice', () => {
    const { target, show } = fakeWindow();
    let reloads = 0;
    reloadWhenRestoredFromCache(target, () => (reloads += 1));
    show(false);
    expect(reloads).toBe(0);
  });
});
