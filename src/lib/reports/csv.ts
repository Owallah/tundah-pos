/**
 * reports/csv.ts — CSV export.
 *
 * Generated in the browser: no serverless invocation, no cost, works the
 * instant the report renders.
 *
 * Two things this gets right that naive implementations do not:
 *
 * 1. **Money is exported as a decimal, not cents.** An accountant opening
 *    this in Excel expects 250.00, not 25000. The conversion happens here,
 *    at the boundary, exactly like the eTIMS one.
 *
 * 2. **Formula injection is neutralised.** A product named `=1+1` would be
 *    evaluated by Excel on open. Any cell starting with = + - @ tab or CR is
 *    prefixed with a single quote. Product names come from user input, so
 *    this is a real path, not a theoretical one.
 */

import { formatKes, type Cents } from '../money/money';

export type CellValue = string | number | boolean | null | undefined;

export interface Column<T> {
  key: keyof T & string;
  header: string;
  /** 'money' converts cents to a 2dp decimal. */
  kind?: 'text' | 'number' | 'money' | 'percent' | 'date';
}

const DANGEROUS = /^[=+\-@\t\r]/;

export function escapeCell(value: CellValue): string {
  if (value === null || value === undefined) return '';

  let s = String(value);

  // Excel/Sheets evaluate leading =, +, -, @ as formulas.
  if (DANGEROUS.test(s)) s = `'${s}`;

  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function renderCell<T>(row: T, col: Column<T>): string {
  const raw = row[col.key] as CellValue;
  if (raw === null || raw === undefined) return '';

  switch (col.kind) {
    case 'money':
      // Cents -> decimal. Unquoted so spreadsheets parse it as a number.
      return (Number(raw) / 100).toFixed(2);
    case 'percent':
      return Number(raw).toFixed(1);
    case 'number':
      return String(Number(raw));
    case 'date': {
      const d: unknown = raw;
      return escapeCell(
        d instanceof Date ? d.toISOString().slice(0, 10) : String(raw));
    }
    default:
      return escapeCell(raw);
  }
}

export function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const header = columns.map((c) => escapeCell(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => renderCell(r, c)).join(','));
  // CRLF: what Excel expects, and harmless everywhere else.
  return [header, ...body].join('\r\n');
}

/**
 * Prepends a BOM so Excel on Windows reads UTF-8 correctly. Without it,
 * accented characters and the shilling sign render as mojibake.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function reportFilename(name: string, from: Date, to: Date): string {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return `${name}-${d(from)}-to-${d(to)}.csv`;
}

/** Money for on-screen display. Re-exported so report views need one import. */
export const money = (c: number): string => formatKes(c as Cents, false);
