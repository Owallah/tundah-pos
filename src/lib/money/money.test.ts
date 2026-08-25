import { describe, it, expect } from 'vitest';
import {
  cents, bp, roundHalfUp, vatFromGross, vatFromNet, computeLine,
  computeSaleTotals, allocateDiscount, formatKes, parseKes,
  centsToEtimsDecimal, FALLBACK_RATES_BP, type TaxTypeCode,
} from './money';

describe('roundHalfUp', () => {
  it('rounds .5 away from zero, symmetrically', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4)).toBe(2);
    expect(roundHalfUp(-2.4)).toBe(-2);
  });

  it('differs from Math.round for negative halves (the reason it exists)', () => {
    expect(Math.round(-2.5)).toBe(-2);
    expect(roundHalfUp(-2.5)).toBe(-3);
  });
});

describe('cents guard', () => {
  it('rejects non-integers so float drift cannot enter the money path', () => {
    expect(() => cents(10.5)).toThrow(RangeError);
    expect(() => cents(0.1 + 0.2)).toThrow(RangeError);
  });
});

describe('VAT extraction from gross (Kenyan retail default)', () => {
  it('extracts 16% from an inclusive KES 100.00', () => {
    // 10000 * 1600/11600 = 1379.31 -> 1379
    const r = vatFromGross(cents(10_000), bp(1600));
    expect(r.vat).toBe(1379);
    expect(r.net).toBe(8621);
    expect(r.net + r.vat).toBe(r.gross);
  });

  it('handles a KES 250 smoothie', () => {
    const r = vatFromGross(cents(25_000), bp(1600));
    expect(r.vat).toBe(3448);   // 25000*1600/11600 = 3448.27
    expect(r.net).toBe(21_552);
  });

  it('returns zero VAT for exempt and zero-rated bands', () => {
    for (const code of ['A', 'C', 'D'] as TaxTypeCode[]) {
      const r = vatFromGross(cents(25_000), FALLBACK_RATES_BP[code]);
      expect(r.vat).toBe(0);
      expect(r.net).toBe(25_000);
    }
  });

  it('always satisfies net + vat === gross (no lost cents)', () => {
    for (let g = 1; g <= 5000; g++) {
      const r = vatFromGross(cents(g), bp(1600));
      expect(r.net + r.vat).toBe(g);
    }
  });
});

describe('KRA OSCU v2.0 spec fixtures', () => {
  // The sales sample in the official spec uses 18% (legacy data) and
  // EXTRACTS tax from an inclusive amount:
  //   taxblAmtB 10500, taxRtB 18, taxAmtB 1602
  it('reproduces the spec sales sample under the extract convention', () => {
    const r = vatFromGross(cents(10_500), bp(1800));
    expect(r.vat).toBe(1602);   // 10500*1800/11800 = 1601.69
  });

  // The PURCHASE sample in the SAME document ADDS tax instead:
  //   taxblAmtB 10500, taxRtB 18, taxAmtB 1890
  // This contradiction is open question K3.
  it('reproduces the spec purchase sample under the add convention', () => {
    const r = vatFromNet(cents(10_500), bp(1800));
    expect(r.vat).toBe(1890);   // 10500*0.18
  });

  it('documents that the two conventions genuinely disagree', () => {
    const extract = vatFromGross(cents(10_500), bp(1800)).vat;
    const added = vatFromNet(cents(10_500), bp(1800)).vat;
    expect(extract).not.toBe(added);
    expect(added - extract).toBe(288);  // KES 2.88 per KES 105 of sale
  });
});

describe('computeLine', () => {
  it('applies discount before tax', () => {
    const r = computeLine(
      { qty: 2, unitPrice: cents(25_000), discount: cents(5_000), taxRate: bp(1600) },
      true,
    );
    expect(r.extended).toBe(50_000);
    expect(r.gross).toBe(45_000);
    expect(r.vat).toBe(6207);          // 45000*1600/11600
    expect(r.net + r.vat).toBe(r.gross);
  });

  it('supports fractional quantities for produce sold by weight', () => {
    const r = computeLine({ qty: 0.75, unitPrice: cents(20_000), taxRate: bp(0) }, true);
    expect(r.extended).toBe(15_000);
  });

  it('rejects a discount larger than the line', () => {
    expect(() =>
      computeLine({ qty: 1, unitPrice: cents(100), discount: cents(200), taxRate: bp(0) }, true),
    ).toThrow(RangeError);
  });
});

describe('computeSaleTotals — mixed tax bands (fruit + smoothie)', () => {
  it('separates zero-rated produce from standard-rated drinks', () => {
    const totals = computeSaleTotals(
      [
        // Whole mango, zero-rated
        { qty: 3, unitPrice: cents(5_000), taxRate: bp(0), taxCode: 'C' },
        // Mango smoothie, standard-rated
        { qty: 2, unitPrice: cents(25_000), taxRate: bp(1600), taxCode: 'B' },
      ],
      true,
    );

    expect(totals.total).toBe(65_000);          // 150 + 500
    expect(totals.bands.C.taxable).toBe(15_000);
    expect(totals.bands.C.tax).toBe(0);
    expect(totals.bands.B.taxable).toBe(50_000);
    expect(totals.bands.B.tax).toBe(6897);      // 50000*1600/11600
    expect(totals.taxTotal).toBe(6897);
  });

  it('keeps subtotal + tax - discount === total', () => {
    const totals = computeSaleTotals(
      [
        { qty: 1, unitPrice: cents(25_000), discount: cents(2_500), taxRate: bp(1600), taxCode: 'B' },
        { qty: 4, unitPrice: cents(7_500), taxRate: bp(0), taxCode: 'A' },
      ],
      true,
    );
    expect(totals.subtotal + totals.taxTotal).toBe(totals.total);
  });
});

describe('allocateDiscount', () => {
  it('never loses or invents a cent', () => {
    const lines = [cents(3_333), cents(3_333), cents(3_334)];
    const alloc = allocateDiscount(lines, cents(1_000));
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(1_000);
  });

  it('handles indivisible remainders deterministically', () => {
    const alloc = allocateDiscount([cents(100), cents(100), cents(100)], cents(10));
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(10);
    expect(alloc).toEqual([4, 3, 3]);
  });

  it('is exact across many random splits', () => {
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(Math.random() * 6);
      const lines = Array.from({ length: n }, () =>
        cents(1 + Math.floor(Math.random() * 50_000)),
      );
      const pool = lines.reduce((a, b) => a + b, 0);
      const d = cents(Math.floor(Math.random() * pool));
      expect(allocateDiscount(lines, d).reduce((a, b) => a + b, 0)).toBe(d);
    }
  });

  it('rejects a discount larger than the sale', () => {
    expect(() => allocateDiscount([cents(100)], cents(200))).toThrow(RangeError);
  });
});

describe('formatting and parsing', () => {
  it('round-trips', () => {
    for (const v of [0, 1, 99, 100, 12_345, 100_050, 999_999_99]) {
      expect(parseKes(formatKes(cents(v), false))).toBe(v);
    }
  });

  it('formats the brief example correctly', () => {
    expect(formatKes(cents(10_050))).toBe('KES 100.50');
  });

  it('rejects junk and over-precise input', () => {
    expect(() => parseKes('abc')).toThrow(RangeError);
    expect(() => parseKes('10.505')).toThrow(RangeError);
  });
});

describe('eTIMS boundary conversion', () => {
  it('converts cents to NUMBER(18,2)', () => {
    expect(centsToEtimsDecimal(cents(10_050))).toBe(100.5);
    expect(centsToEtimsDecimal(cents(3_448))).toBe(34.48);
    expect(centsToEtimsDecimal(cents(0))).toBe(0);
  });
});
