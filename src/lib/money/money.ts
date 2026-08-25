/**
 * money.ts — integer minor units only. No floats in the money path, ever.
 *
 * ARCHITECTURE Principle 10. KES 100.50 is stored as 10050.
 *
 * This module MUST stay in exact agreement with the SQL helpers in
 * supabase/migrations/0005_functions.sql (round_half_up, vat_from_gross,
 * vat_from_net). The test suite asserts parity against the same fixtures.
 */

/** Money in minor units (cents). Branded so it can't be confused with a rate. */
export type Cents = number & { readonly __brand: 'Cents' };

/** A tax rate in basis points. 1600 = 16.00%. */
export type BasisPoints = number & { readonly __brand: 'BasisPoints' };

export const cents = (n: number): Cents => {
  if (!Number.isInteger(n)) {
    throw new RangeError(`Money must be an integer number of cents, got ${n}`);
  }
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`Money exceeds safe integer range: ${n}`);
  }
  return n as Cents;
};

export const bp = (n: number): BasisPoints => {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`Basis points must be a non-negative integer, got ${n}`);
  }
  return n as BasisPoints;
};

/**
 * Half-up rounding, away from zero. Deliberately NOT Math.round (which is
 * half-up toward +Infinity and therefore asymmetric for negatives) and NOT
 * banker's rounding.
 *
 *   roundHalfUp(2.5)  ===  3
 *   roundHalfUp(-2.5) === -3
 */
export function roundHalfUp(value: number): number {
  return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
}

// ── KRA tax types ───────────────────────────────────────────────────────────

export type TaxTypeCode = 'A' | 'B' | 'C' | 'D' | 'E';

/**
 * Fallback rates, used ONLY before /selectCodeList has been synced from KRA.
 * The live rates come from the etims_code_list table. Never trust these in
 * production — KRA's own spec sample returns B-18.00% (legacy Rwandan data)
 * while the code table says B-16.00%. See ARCHITECTURE §0.4 / K3.
 */
export const FALLBACK_RATES_BP: Record<TaxTypeCode, BasisPoints> = {
  A: bp(0),     // Exempt
  B: bp(1600),  // Standard 16%
  C: bp(0),     // Zero-rated
  D: bp(0),     // Non-VAT registered
  E: bp(800),   // 8%
};

/**
 * Fruit vs smoothie, in one comment so nobody has to guess:
 *   Unprocessed produce sold as-is  -> typically A or C
 *   Blended / prepared drinks       -> B (standard 16%)
 * The actual per-product mapping is the accountant's call (Q7) and arrives
 * via seed/catalogue.csv. This module never infers a tax type from a name.
 */

// ── VAT ─────────────────────────────────────────────────────────────────────

export interface VatSplit {
  /** Amount excluding VAT. */
  net: Cents;
  /** The VAT component. */
  vat: Cents;
  /** Amount including VAT. */
  gross: Cents;
}

/**
 * Extract VAT from a VAT-INCLUSIVE amount.
 *   vat = gross * rate / (1 + rate)
 * This is the normal Kenyan retail path — shelf prices are quoted inclusive.
 */
export function vatFromGross(gross: Cents, rate: BasisPoints): VatSplit {
  if (rate === 0) {
    return { net: gross, vat: cents(0), gross };
  }
  const vat = cents(roundHalfUp((gross * rate) / (10_000 + rate)));
  return { net: cents(gross - vat), vat, gross };
}

/**
 * Add VAT to a VAT-EXCLUSIVE amount.
 *   vat = net * rate
 */
export function vatFromNet(net: Cents, rate: BasisPoints): VatSplit {
  if (rate === 0) {
    return { net, vat: cents(0), gross: net };
  }
  const vat = cents(roundHalfUp((net * rate) / 10_000));
  return { net, vat, gross: cents(net + vat) };
}

export function computeVat(
  amount: Cents,
  rate: BasisPoints,
  pricesIncludeVat: boolean,
): VatSplit {
  return pricesIncludeVat ? vatFromGross(amount, rate) : vatFromNet(amount, rate);
}

// ── Line maths ──────────────────────────────────────────────────────────────

export interface LineInput {
  /** Supports fractional quantities (e.g. 0.5 kg of mango). */
  qty: number;
  unitPrice: Cents;
  discount?: Cents;
  taxRate: BasisPoints;
}

export interface LineResult {
  /** qty * unitPrice, before discount. */
  extended: Cents;
  discount: Cents;
  /** extended - discount. Discounts apply BEFORE tax (§13). */
  gross: Cents;
  net: Cents;
  vat: Cents;
  total: Cents;
}

export function computeLine(line: LineInput, pricesIncludeVat: boolean): LineResult {
  const extended = cents(roundHalfUp(line.qty * line.unitPrice));
  const discount = line.discount ?? cents(0);

  if (discount > extended) {
    throw new RangeError(`Discount ${discount} exceeds line total ${extended}`);
  }

  const gross = cents(extended - discount);
  const split = computeVat(gross, line.taxRate, pricesIncludeVat);

  return {
    extended,
    discount,
    gross,
    net: split.net,
    vat: split.vat,
    total: pricesIncludeVat ? gross : split.gross,
  };
}

// ── Sale totals, grouped into KRA tax bands ─────────────────────────────────

export interface TaxBand {
  code: TaxTypeCode;
  rate: BasisPoints;
  taxable: Cents;
  tax: Cents;
}

export interface SaleTotals {
  subtotal: Cents;
  discount: Cents;
  taxTotal: Cents;
  total: Cents;
  bands: Record<TaxTypeCode, TaxBand>;
}

export function computeSaleTotals(
  lines: Array<LineInput & { taxCode: TaxTypeCode }>,
  pricesIncludeVat: boolean,
): SaleTotals {
  const bands = {} as Record<TaxTypeCode, TaxBand>;
  for (const code of ['A', 'B', 'C', 'D', 'E'] as TaxTypeCode[]) {
    bands[code] = { code, rate: bp(0), taxable: cents(0), tax: cents(0) };
  }

  let subtotal = 0;
  let discount = 0;
  let taxTotal = 0;
  let total = 0;

  for (const line of lines) {
    const r = computeLine(line, pricesIncludeVat);
    const band = bands[line.taxCode];

    band.rate = line.taxRate;
    // KRA's taxblAmt convention (gross vs net) is pinned at certification.
    // We follow the sales sample in OSCU v2.0: taxblAmt is the gross amount.
    band.taxable = cents(band.taxable + r.gross);
    band.tax = cents(band.tax + r.vat);

    subtotal += r.net;
    discount += r.discount;
    taxTotal += r.vat;
    total += r.total;
  }

  return {
    subtotal: cents(subtotal),
    discount: cents(discount),
    taxTotal: cents(taxTotal),
    total: cents(total),
    bands,
  };
}

// ── Discount allocation ─────────────────────────────────────────────────────

/**
 * Spread a sale-level discount across lines without losing or inventing cents.
 * Largest-remainder method: allocate the floor of each proportional share,
 * then hand out the leftover cents to the largest fractional remainders.
 *
 * The sum of the result is ALWAYS exactly `discount`.
 */
export function allocateDiscount(lineAmounts: Cents[], discount: Cents): Cents[] {
  const pool = lineAmounts.reduce((a, b) => a + b, 0);
  if (pool === 0) return lineAmounts.map(() => cents(0));
  if (discount > pool) {
    throw new RangeError(`Discount ${discount} exceeds sale total ${pool}`);
  }

  const exact = lineAmounts.map((amt) => (amt * discount) / pool);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = discount - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    out[order[k].i] += 1;
  }

  return out.map((v) => cents(v));
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatKes(amount: Cents, withSymbol = true): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const major = Math.floor(abs / 100);
  const minor = abs % 100;
  const grouped = major.toLocaleString('en-KE');
  const body = `${grouped}.${minor.toString().padStart(2, '0')}`;
  return `${negative ? '-' : ''}${withSymbol ? 'KES ' : ''}${body}`;
}

/** Parse a user-typed amount ("1,250.50") into cents. Rejects float drift. */
export function parseKes(input: string): Cents {
  const cleaned = input.replace(/[,\s]/g, '').replace(/^KES/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new RangeError(`Not a valid amount: "${input}"`);
  }
  const [major, minor = ''] = cleaned.split('.');
  const sign = major.startsWith('-') ? -1 : 1;
  const majorCents = Math.abs(parseInt(major, 10)) * 100;
  const minorCents = parseInt(minor.padEnd(2, '0'), 10);
  return cents(sign * (majorCents + minorCents));
}

/** eTIMS wants NUMBER(18,2). Convert at the boundary and nowhere else. */
export function centsToEtimsDecimal(amount: Cents): number {
  return Math.round(amount) / 100;
}

export const add = (...xs: Cents[]): Cents => cents(xs.reduce((a, b) => a + b, 0));
export const sub = (a: Cents, b: Cents): Cents => cents(a - b);
