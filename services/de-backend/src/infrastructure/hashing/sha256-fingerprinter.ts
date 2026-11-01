import { createHash } from 'node:crypto';
import type { Fingerprinter } from '../../shared/index.js';

/**
 * The `Fingerprinter` port of api-design.md §60 (review on #180): SHA-256 over the UTF-8 bytes of the text, 64
 * lower-case hex characters. The domain and the application import no Node module; this adapter is handed to them
 * through their dependencies (`main.ts`), and the start check uses it directly.
 */
export const sha256Fingerprinter: Fingerprinter = {
  sha256Hex: (text: string) => createHash('sha256').update(text, 'utf8').digest('hex'),
};
