/**
 * Money is stored as NUMERIC(12,2) and handled as integer cents in TypeScript.
 *
 * `number` arithmetic on currency drifts (0.1 + 0.2 !== 0.3), and this system
 * multiplies prices by percentages across 500k rows. Integer cents also let the
 * TypeScript and SQL pricing paths produce identical results.
 */

/** A monetary amount in minor units. Always an integer. */
export type Cents = number;

const MONEY_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Parse a NUMERIC value (arriving from pg as a string) into integer cents.
 * Parses the string directly rather than via parseFloat, which would round.
 */
export function parseMoneyToCents(value: string | number | null | undefined): Cents {
  if (value === null || value === undefined) return 0;

  const raw = typeof value === 'number' ? value.toFixed(2) : value.trim();
  if (!MONEY_PATTERN.test(raw)) {
    throw new TypeError(`Not a valid monetary value: ${JSON.stringify(value)}`);
  }

  const negative = raw.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? raw.slice(1) : raw).split('.');

  // Half-up on the third digit, matching ROUND(numeric, 2) in Postgres.
  const twoDigits = fraction.slice(0, 2).padEnd(2, '0');
  let cents = Number(whole) * 100 + Number(twoDigits);
  if (fraction.length > 2 && Number(fraction[2]) >= 5) cents += 1;

  return negative ? -cents : cents;
}

/** Render cents as a fixed-2 decimal string, the API wire format. */
export function centsToDecimalString(cents: Cents): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${s}` : s;
}

export function centsToNumber(cents: Cents): number {
  return Number(centsToDecimalString(cents));
}

/** Round half-up away from zero, matching Postgres NUMERIC rounding. */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
