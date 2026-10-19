/**
 * IBAN as an external identifier (data-model.md §6.5): never an internal id.
 * Input is normalized (spaces removed, upper case) and must pass the ISO 13616
 * structure and the ISO 7064 mod-97 check, so typos are rejected at the boundary.
 */

/** Country code, two check digits, 11–30 alphanumeric BBAN characters (15–34 in total). */
const IBAN_STRUCTURE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;

/** Canonical form of an IBAN, or undefined if it is not a valid IBAN. */
export function normalizeIban(input: string): string | undefined {
  const iban = input.replace(/ /g, '').toUpperCase();
  if (!IBAN_STRUCTURE.test(iban)) return undefined;
  return mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) === 1 ? iban : undefined;
}

/** Remainder of the IBAN's numeric form modulo 97, digit by digit (no big numbers). */
function mod97(rearranged: string): number {
  let remainder = 0;
  for (const char of rearranged) {
    const digits = char >= 'A' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}
