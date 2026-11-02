import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = { DATABASE_URL: 'postgres://u:p@db:5432/de', MRE_API_URL: 'http://gateway:8080/api/v2' };

describe('loadConfig', () => {
  it('reads and defaults values', () => {
    expect(loadConfig(base)).toEqual({ ...base, PORT: 8090, MRE_TIMEOUT_MS: 5000, DEPRECIATION_RECORDING_ENABLED: false, DEPRECIATION_RECORDING_STAGE: 1 });
    expect(loadConfig({ ...base, PORT: '9000', MRE_TIMEOUT_MS: '1500' })).toMatchObject({ PORT: 9000, MRE_TIMEOUT_MS: 1500 });
  });

  it('fails fast on missing or invalid values without echoing them', () => {
    expect(() => loadConfig({})).toThrow('Invalid configuration: DATABASE_URL, MRE_API_URL');
    expect(() => loadConfig({ ...base, PORT: 'x' })).toThrow('PORT');
    expect(() => loadConfig({ ...base, DATABASE_URL: 'secret-not-a-url' })).toThrow(/^(?!.*secret)/);
  });

  describe('DEPRECIATION_RECORDING_ENABLED (api-design.md §60 "The recording switch")', () => {
    it('unset is false (the shipped default: recording off); exactly "true" and "false" are read', () => {
      expect(loadConfig(base).DEPRECIATION_RECORDING_ENABLED).toBe(false);
      expect(loadConfig({ ...base, DEPRECIATION_RECORDING_ENABLED: 'true' }).DEPRECIATION_RECORDING_ENABLED).toBe(true);
      // Counter-check against z.coerce.boolean(), which reads the string "false" as true.
      expect(loadConfig({ ...base, DEPRECIATION_RECORDING_ENABLED: 'false' }).DEPRECIATION_RECORDING_ENABLED).toBe(false);
    });

    it.each(['', 'TRUE', 'True', '1', 'yes', 'on', '0'])('%j fails the start, naming the switch without the value', (value) => {
      expect(() => loadConfig({ ...base, DEPRECIATION_RECORDING_ENABLED: value })).toThrow(/^Invalid configuration: DEPRECIATION_RECORDING_ENABLED$/);
    });
  });

  describe('DEPRECIATION_RECORDING_STAGE (VC-X-45, the released stage)', () => {
    it('unset is 1; exactly "1", "2" and "3" are read as numbers', () => {
      expect(loadConfig(base).DEPRECIATION_RECORDING_STAGE).toBe(1);
      expect(['1', '2', '3'].map((v) => loadConfig({ ...base, DEPRECIATION_RECORDING_STAGE: v }).DEPRECIATION_RECORDING_STAGE)).toEqual([1, 2, 3]);
    });

    it.each(['', '0', '4', '01', '1.0', ' 1', ' 2', 'two', 'true', '-1'])('%j fails the start, naming the stage without the value', (value) => {
      expect(() => loadConfig({ ...base, DEPRECIATION_RECORDING_STAGE: value })).toThrow(/^Invalid configuration: DEPRECIATION_RECORDING_STAGE$/);
    });

    it('a stage without the main switch is allowed (A6): the switch stays off, the stage is read and reported', () => {
      const config = loadConfig({ ...base, DEPRECIATION_RECORDING_STAGE: '3' });
      expect([config.DEPRECIATION_RECORDING_ENABLED, config.DEPRECIATION_RECORDING_STAGE]).toEqual([false, 3]);
      // The stage never turns the switch on, whatever its value.
      for (const v of ['1', '2', '3']) expect(loadConfig({ ...base, DEPRECIATION_RECORDING_STAGE: v }).DEPRECIATION_RECORDING_ENABLED).toBe(false);
    });

    it('an invalid stage and an invalid switch are both named', () => {
      expect(() => loadConfig({ ...base, DEPRECIATION_RECORDING_ENABLED: 'yes', DEPRECIATION_RECORDING_STAGE: '9' })).toThrow(
        /^Invalid configuration: DEPRECIATION_RECORDING_ENABLED, DEPRECIATION_RECORDING_STAGE$/,
      );
    });
  });
});
