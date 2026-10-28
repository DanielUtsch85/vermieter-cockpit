/** Cents as the API's Money JSON (EUR), unsigned and signed. */
export const eurCents = (cents: bigint) => ({ amount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`, currency: 'EUR' });

export const signedEurCents = (cents: bigint) => (cents < 0n ? { amount: `-${eurCents(-cents).amount}`, currency: 'EUR' } : eurCents(cents));
