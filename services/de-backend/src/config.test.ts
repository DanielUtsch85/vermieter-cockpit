import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('reads and defaults values', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://u:p@db:5432/de' })).toEqual({
      PORT: 8090,
      DATABASE_URL: 'postgres://u:p@db:5432/de',
    });
    expect(loadConfig({ DATABASE_URL: 'postgres://db/de', PORT: '9000' }).PORT).toBe(9000);
  });

  it('fails fast on missing or invalid values without echoing them', () => {
    expect(() => loadConfig({})).toThrow('Invalid configuration: DATABASE_URL');
    expect(() => loadConfig({ DATABASE_URL: 'postgres://db/de', PORT: 'x' })).toThrow('PORT');
    expect(() => loadConfig({ DATABASE_URL: 'secret-not-a-url' })).not.toThrow(/secret/);
  });
});
