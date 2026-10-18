import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://u:p@db:5432/de', MRE_API_URL: 'http://gateway:8080/api/v2' };

describe('loadConfig', () => {
  it('reads and defaults values', () => {
    expect(loadConfig(base)).toEqual({ ...base, PORT: 8090, MRE_TIMEOUT_MS: 5000 });
    expect(loadConfig({ ...base, PORT: '9000', MRE_TIMEOUT_MS: '1500' })).toMatchObject({ PORT: 9000, MRE_TIMEOUT_MS: 1500 });
  });

  it('fails fast on missing or invalid values without echoing them', () => {
    expect(() => loadConfig({})).toThrow('Invalid configuration: DATABASE_URL, MRE_API_URL');
    expect(() => loadConfig({ ...base, PORT: 'x' })).toThrow('PORT');
    expect(() => loadConfig({ ...base, DATABASE_URL: 'secret-not-a-url' })).toThrow(/^(?!.*secret)/);
  });
});
