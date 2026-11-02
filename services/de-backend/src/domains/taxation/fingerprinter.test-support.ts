import type { Fingerprinter } from '../../shared/index.js';

/**
 * A deterministic stand-in for the SHA-256 adapter in Taxation's pure tests (the domain imports no Node module): four
 * FNV-1a passes over the text, 64 lower-case hex characters, so equal texts give equal fingerprints and a changed text
 * a different one. Synthetic. Test support only.
 */
export const testFingerprinter: Fingerprinter = {
  sha256Hex: (text) =>
    [0x811c9dc5, 0x01000193, 0x1b873593, 0xcc9e2d51]
      .map((seed) => {
        let h = seed >>> 0;
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
        const g = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
        return h.toString(16).padStart(8, '0') + g.toString(16).padStart(8, '0');
      })
      .join(''),
};
