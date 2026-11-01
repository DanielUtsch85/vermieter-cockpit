import { describe, expect, it } from 'vitest';
import { sha256Fingerprinter } from './sha256-fingerprinter.js';

describe('the SHA-256 Fingerprinter (api-design.md §60)', () => {
  it('meets the published test vector for "abc"', () => {
    expect(sha256Fingerprinter.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the UTF-8 bytes of non-ASCII text (64 lower-case hex characters)', () => {
    // "ä" is c3 a4 in UTF-8; its SHA-256 is fixed.
    expect(sha256Fingerprinter.sha256Hex('ä')).toBe('33e6d73fee82904c8d7afb78de1154d1e8dc2a0edb08120e63df5b9385c2d9cc');
    expect(sha256Fingerprinter.sha256Hex('Einbauküche')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Fingerprinter.sha256Hex('Einbauküche')).not.toBe(sha256Fingerprinter.sha256Hex('Einbaukuche'));
  });
});
