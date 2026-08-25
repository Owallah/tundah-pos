import { describe, it, expect } from 'vitest';
import { toCsv, escapeCell, type Column } from './csv';

interface Row { name: string; qty: number; revenue_cents: number; margin_pct: number }

const columns: Column<Row>[] = [
  { key: 'name', header: 'Product' },
  { key: 'qty', header: 'Qty', kind: 'number' },
  { key: 'revenue_cents', header: 'Revenue', kind: 'money' },
  { key: 'margin_pct', header: 'Margin %', kind: 'percent' },
];

describe('escapeCell', () => {
  it('quotes cells containing commas, quotes or newlines', () => {
    expect(escapeCell('Mango, Large')).toBe('"Mango, Large"');
    expect(escapeCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(escapeCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection', () => {
    // A product literally named "=1+1" would otherwise be evaluated by Excel
    // when the accountant opens the file. Product names are user input.
    expect(escapeCell('=1+1')).toBe("'=1+1");
    expect(escapeCell('+44 700')).toBe("'+44 700");
    expect(escapeCell('-2')).toBe("'-2");
    expect(escapeCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('leaves ordinary text alone', () => {
    expect(escapeCell('Mango Smoothie')).toBe('Mango Smoothie');
  });

  it('renders null and undefined as empty', () => {
    expect(escapeCell(null)).toBe('');
    expect(escapeCell(undefined)).toBe('');
  });
});

describe('toCsv', () => {
  it('converts cents to a decimal the accountant expects', () => {
    const csv = toCsv([
      { name: 'Mango Smoothie', qty: 12, revenue_cents: 300_000, margin_pct: 62.5 },
    ], columns);

    const [header, row] = csv.split('\r\n');
    expect(header).toBe('Product,Qty,Revenue,Margin %');
    expect(row).toBe('Mango Smoothie,12,3000.00,62.5');
    // Not 300000 — a spreadsheet would read that as three hundred thousand.
    expect(row).not.toMatch(/300000/);
  });

  it('uses CRLF line endings for Excel', () => {
    const csv = toCsv([{ name: 'A', qty: 1, revenue_cents: 100, margin_pct: 0 }], columns);
    expect(csv).toContain('\r\n');
  });

  it('handles an empty result set without losing the header', () => {
    expect(toCsv([], columns)).toBe('Product,Qty,Revenue,Margin %');
  });

  it('escapes a product name containing a comma', () => {
    const csv = toCsv([
      { name: 'Fruit Cup, Medium', qty: 3, revenue_cents: 36_000, margin_pct: 50 },
    ], columns);
    expect(csv).toContain('"Fruit Cup, Medium"');
    // Still exactly four fields.
    expect(csv.split('\r\n')[1].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)).toHaveLength(4);
  });

  it('rounds money to exactly two decimals', () => {
    const csv = toCsv([
      { name: 'X', qty: 1, revenue_cents: 3_448, margin_pct: 33.333 },
    ], columns);
    expect(csv).toContain('34.48');
    expect(csv).toContain('33.3');
  });
});
