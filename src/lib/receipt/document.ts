/**
 * receipt/document.ts — the receipt as DATA, not markup.
 *
 * ARCHITECTURE §I. Because `ReceiptDocument` is a pure structure and every
 * provider is a pure renderer, adding a thermal printer later is one new
 * class and one settings toggle — no change to the sales engine (§25).
 *
 * TWO STATES:
 *   PROVISIONAL — issued instantly. Not a tax invoice.
 *   FISCAL      — issued once KRA returns a signature. Normally within
 *                 seconds; the gap only widens during an eTIMS outage.
 *
 * A provisional receipt is never dressed up to look fiscal. Only KRA can
 * produce `rcptSign`, and pretending otherwise would be a compliance problem
 * rather than a UX improvement.
 */

import { formatKes, type Cents, type TaxTypeCode, type BasisPoints } from '../money/money';

export interface ReceiptBusiness {
  legalName: string;
  tradingName?: string | null;
  kraPin: string;
  address?: string | null;
  phone?: string | null;
  vatRegistered: boolean;
}

export interface ReceiptLine {
  lineNo: number;
  name: string;
  qty: number;
  uom: string;
  unitPrice: Cents;
  discount: Cents;
  lineTotal: Cents;
  taxCode: TaxTypeCode;
}

export interface ReceiptTaxBand {
  code: TaxTypeCode;
  rateBp: BasisPoints;
  taxable: Cents;
  tax: Cents;
}

export interface ReceiptPayment {
  method: string;
  amount: Cents;
  reference?: string | null;
  verified: boolean;
}

export interface FiscalBlock {
  invcNo: number;
  curRcptNo: number;
  totRcptNo: number;
  intrlData: string;
  rcptSign: string;
  sdcDateTime: Date;
  qrPayload?: string;
}

export interface ReceiptDocument {
  business: ReceiptBusiness;
  localRef: string;
  issuedAt: Date;
  cashierName: string;
  deviceCode: string;
  eventName: string;
  customer?: { name?: string | null; kraPin?: string | null; phone?: string | null };
  lines: ReceiptLine[];
  subtotal: Cents;
  discountTotal: Cents;
  taxBands: ReceiptTaxBand[];
  taxTotal: Cents;
  total: Cents;
  payments: ReceiptPayment[];
  changeGiven: Cents;
  /** Absent until KRA signs. Its presence IS the difference between states. */
  fiscal?: FiscalBlock;
  publicUrl?: string;
  isBackfilled: boolean;
  backfillRef?: string | null;
}

export const isFiscal = (doc: ReceiptDocument): boolean => doc.fiscal !== undefined;

export interface ReceiptOutput {
  contentType: string;
  body: string | Uint8Array;
  filename?: string;
}

export interface ReceiptProvider {
  readonly capability: 'VIEW' | 'FILE' | 'PHYSICAL';
  readonly name: string;
  render(doc: ReceiptDocument): Promise<ReceiptOutput>;
}

// ── Plain text, 32 columns (80mm thermal width) ────────────────────────────
// Used for on-screen preview and as the future ESC/POS body. Building it now
// means the printer provider is a transport change, not a layout project.

const COLS = 32;

const rule = (ch = '-') => ch.repeat(COLS);
const centre = (s: string) =>
  s.length >= COLS ? s.slice(0, COLS) : ' '.repeat(Math.floor((COLS - s.length) / 2)) + s;

function row(left: string, right: string): string {
  const gap = COLS - left.length - right.length;
  return gap >= 1
    ? left + ' '.repeat(gap) + right
    : left.slice(0, COLS - right.length - 1) + ' ' + right;
}

function wrap(text: string, width = COLS): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width) {
      if (line) out.push(line.trim());
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) out.push(line);
  return out;
}

export function renderText(doc: ReceiptDocument): string {
  const L: string[] = [];
  const fiscal = isFiscal(doc);

  L.push(centre((doc.business.tradingName ?? doc.business.legalName).toUpperCase()));
  if (doc.business.tradingName) L.push(centre(doc.business.legalName));
  L.push(centre(`PIN: ${doc.business.kraPin}`));
  if (doc.business.address) wrap(doc.business.address).forEach((l) => L.push(centre(l)));
  if (doc.business.phone) L.push(centre(doc.business.phone));
  L.push('');

  L.push(centre(fiscal ? 'TAX INVOICE' : 'PROVISIONAL RECEIPT'));
  if (!fiscal) {
    L.push(centre('NOT A TAX INVOICE'));
    L.push('');
    wrap('The tax invoice will be available at the link below once it is issued.')
      .forEach((l) => L.push(l));
  }
  if (doc.isBackfilled) {
    L.push('');
    L.push(centre('*** ENTERED FROM PAPER ***'));
    if (doc.backfillRef) L.push(centre(`Slip ${doc.backfillRef}`));
  }
  L.push(rule('='));

  L.push(row('Ref', doc.localRef));
  if (fiscal) L.push(row('Invoice', String(doc.fiscal!.invcNo)));
  L.push(row('Date', doc.issuedAt.toLocaleString('en-KE', { hour12: false })));
  L.push(row('Till', doc.deviceCode));
  L.push(row('Served by', doc.cashierName));
  if (doc.customer?.kraPin) L.push(row('Customer PIN', doc.customer.kraPin));
  L.push(rule());

  for (const line of doc.lines) {
    L.push(`${line.name}${line.taxCode !== 'B' ? ` (${line.taxCode})` : ''}`.slice(0, COLS));
    const qty = Number.isInteger(line.qty) ? String(line.qty) : line.qty.toFixed(3);
    L.push(row(`  ${qty} ${line.uom} x ${formatKes(line.unitPrice, false)}`,
               formatKes(line.lineTotal, false)));
    if (line.discount > 0) {
      L.push(row('  Discount', `-${formatKes(line.discount, false)}`));
    }
  }

  L.push(rule());
  if (doc.discountTotal > 0) {
    L.push(row('Discount', `-${formatKes(doc.discountTotal, false)}`));
  }
  L.push(row('Subtotal', formatKes(doc.subtotal, false)));

  for (const band of doc.taxBands) {
    if (band.taxable === 0) continue;
    const label = band.rateBp === 0
      ? `${band.code} (no VAT)`
      : `VAT ${band.code} ${(band.rateBp / 100).toFixed(0)}%`;
    L.push(row(label, formatKes(band.tax, false)));
  }

  L.push(rule('='));
  L.push(row('TOTAL KES', formatKes(doc.total, false)));
  L.push(rule('='));

  for (const p of doc.payments) {
    const label = p.method.replace(/_/g, ' ');
    L.push(row(label + (p.verified ? '' : ' *'), formatKes(p.amount, false)));
    if (p.reference) L.push(`  ${p.reference}`);
  }
  if (doc.changeGiven > 0) L.push(row('Change', formatKes(doc.changeGiven, false)));
  if (doc.payments.some((p) => !p.verified)) {
    L.push('');
    L.push('* payment awaiting verification');
  }

  if (fiscal) {
    const f = doc.fiscal!;
    L.push(rule());
    L.push(centre('KRA eTIMS'));
    L.push(row('Receipt no', `${f.curRcptNo}/${f.totRcptNo}`));
    L.push(row('Signature', f.rcptSign));
    L.push('Internal data:');
    // 26 chars will not fit one 32-col row alongside a label.
    wrap(f.intrlData).forEach((l) => L.push(`  ${l}`));
    L.push(row('SDC time', f.sdcDateTime.toLocaleString('en-KE', { hour12: false })));
  }

  if (doc.publicUrl) {
    L.push(rule());
    L.push(centre('View or download this receipt'));
    wrap(doc.publicUrl).forEach((l) => L.push(centre(l)));
  }

  L.push('');
  L.push(centre('Thank you'));
  L.push('');

  return L.join('\n');
}

// ── Kitchen ticket ──────────────────────────────────────────────────────────
// Deliberately NOT a cut-down copy of the customer receipt. No prices, no
// tax, no payment method — a kitchen glances at this for seconds between
// orders, and every extra number on it is something to misread under
// pressure. Bigger, sparser, and printed in a larger font at the print
// layer (see print.ts) so it reads from arm's length.

export function renderKitchenTicket(doc: ReceiptDocument): string {
  const L: string[] = [];

  L.push(centre('KITCHEN COPY'));
  L.push(rule('='));
  L.push(row('Order', doc.localRef));
  L.push(row('Time', doc.issuedAt.toLocaleTimeString('en-KE', { hour12: false })));
  if (doc.customer?.name) L.push(row('For', doc.customer.name));
  L.push(rule());

  for (const line of doc.lines) {
    const qty = Number.isInteger(line.qty) ? String(line.qty) : line.qty.toFixed(3);
    L.push(`${qty} x ${line.name}`.slice(0, COLS));
  }

  L.push(rule('='));
  L.push('');

  return L.join('\n');
}

// ── Providers ───────────────────────────────────────────────────────────────

export class TextReceiptProvider implements ReceiptProvider {
  readonly capability = 'VIEW' as const;
  readonly name = 'text';
  async render(doc: ReceiptDocument): Promise<ReceiptOutput> {
    return { contentType: 'text/plain; charset=utf-8', body: renderText(doc) };
  }
}

export class HtmlReceiptProvider implements ReceiptProvider {
  readonly capability = 'VIEW' as const;
  readonly name = 'html';

  async render(doc: ReceiptDocument): Promise<ReceiptOutput> {
    const fiscal = isFiscal(doc);
    const esc = (s: string) =>
      s.replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

    const lines = doc.lines.map((l) => `
      <tr>
        <td>${esc(l.name)}<small>${Number.isInteger(l.qty) ? l.qty : l.qty.toFixed(3)}
          ${esc(l.uom)} &times; ${formatKes(l.unitPrice, false)}</small></td>
        <td class="n">${formatKes(l.lineTotal, false)}</td>
      </tr>`).join('');

    const bands = doc.taxBands.filter((b) => b.taxable > 0).map((b) => `
      <tr class="sub"><td>${b.rateBp === 0
        ? `Band ${b.code} (no VAT)` : `VAT ${b.code} ${(b.rateBp / 100).toFixed(0)}%`}</td>
        <td class="n">${formatKes(b.tax, false)}</td></tr>`).join('');

    const payments = doc.payments.map((p) => `
      <tr class="sub"><td>${esc(p.method.replace(/_/g, ' '))}${p.verified ? '' : ' *'}
        ${p.reference ? `<small>${esc(p.reference)}</small>` : ''}</td>
        <td class="n">${formatKes(p.amount, false)}</td></tr>`).join('');

    const body = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${fiscal ? 'Tax invoice' : 'Receipt'} ${esc(doc.localRef)}</title>
<style>
  :root { --ink:#12211A; --dim:#65796E; --line:#DCE5DF; --stop:#B4342F; }
  *{box-sizing:border-box}
  body{margin:0;padding:24px 16px;background:#F1F4F1;color:var(--ink);
       font:15px/1.5 ui-sans-serif,system-ui,sans-serif;display:flex;justify-content:center}
  .r{width:100%;max-width:420px;background:#fff;border-radius:12px;padding:28px 24px;
     box-shadow:0 1px 3px rgba(0,0,0,.08)}
  h1{font-size:19px;margin:0;text-align:center;letter-spacing:.01em}
  .pin,.meta small{color:var(--dim)}
  .pin{text-align:center;font-size:13px;margin:4px 0 18px}
  .tag{display:block;text-align:center;font-size:12px;font-weight:700;
       letter-spacing:.12em;text-transform:uppercase;padding:7px;border-radius:6px;
       margin-bottom:18px}
  .tag.fiscal{background:#E4F3EA;color:#1B6B45}
  .tag.prov{background:#FBECEC;color:var(--stop)}
  .note{font-size:13px;color:var(--dim);text-align:center;margin:-8px 0 18px}
  table{width:100%;border-collapse:collapse}
  td{padding:7px 0;vertical-align:top}
  td small{display:block;color:var(--dim);font-size:12.5px;margin-top:2px}
  .n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .sub td{color:var(--dim);font-size:13.5px;padding:3px 0}
  .sep td{border-top:1px solid var(--line);padding:0;height:12px}
  .tot td{font-size:24px;font-weight:700;padding-top:12px;
          border-top:2px solid var(--ink)}
  .meta{margin:18px 0 0;font-size:13px;color:var(--dim);display:grid;
        grid-template-columns:auto 1fr;gap:3px 14px}
  .meta b{color:var(--ink);font-weight:600;text-align:right}
  .fis{margin-top:20px;padding-top:16px;border-top:1px dashed var(--line);
       font-size:12.5px;color:var(--dim);word-break:break-all}
  .fis b{display:block;color:var(--ink);font-family:ui-monospace,monospace;
         font-size:13px;margin-bottom:6px}
  footer{margin-top:22px;text-align:center;color:var(--dim);font-size:13px}
  @media print{body{background:#fff;padding:0}.r{box-shadow:none;max-width:none}}
</style></head><body><div class="r">
  <h1>${esc(doc.business.tradingName ?? doc.business.legalName)}</h1>
  <p class="pin">PIN ${esc(doc.business.kraPin)}${
    doc.business.phone ? ` &middot; ${esc(doc.business.phone)}` : ''}</p>

  <span class="tag ${fiscal ? 'fiscal' : 'prov'}">
    ${fiscal ? 'Tax invoice' : 'Provisional &middot; not a tax invoice'}</span>
  ${fiscal ? '' : `<p class="note">The tax invoice appears at this same link
    once it is issued. Reload to check.</p>`}

  <table>
    ${lines}
    <tr class="sep"><td colspan="2"></td></tr>
    ${doc.discountTotal > 0 ? `<tr class="sub"><td>Discount</td>
      <td class="n">-${formatKes(doc.discountTotal, false)}</td></tr>` : ''}
    <tr class="sub"><td>Subtotal</td>
      <td class="n">${formatKes(doc.subtotal, false)}</td></tr>
    ${bands}
    <tr class="tot"><td>Total</td>
      <td class="n">KES ${formatKes(doc.total, false)}</td></tr>
    <tr class="sep"><td colspan="2"></td></tr>
    ${payments}
    ${doc.changeGiven > 0 ? `<tr class="sub"><td>Change</td>
      <td class="n">${formatKes(doc.changeGiven, false)}</td></tr>` : ''}
  </table>

  <div class="meta">
    <span>Reference</span><b>${esc(doc.localRef)}</b>
    ${fiscal ? `<span>Invoice no</span><b>${doc.fiscal!.invcNo}</b>` : ''}
    <span>Date</span><b>${esc(doc.issuedAt.toLocaleString('en-KE', { hour12: false }))}</b>
    <span>Till</span><b>${esc(doc.deviceCode)}</b>
    <span>Served by</span><b>${esc(doc.cashierName)}</b>
  </div>

  ${fiscal ? `<div class="fis">
    <b>${esc(doc.fiscal!.rcptSign)}</b>
    Receipt ${doc.fiscal!.curRcptNo}/${doc.fiscal!.totRcptNo} &middot;
    ${esc(doc.fiscal!.intrlData)}<br>
    SDC ${esc(doc.fiscal!.sdcDateTime.toLocaleString('en-KE', { hour12: false }))}
  </div>` : ''}

  <footer>Thank you</footer>
</div></body></html>`;

    return {
      contentType: 'text/html; charset=utf-8',
      body,
      filename: `${fiscal ? 'invoice' : 'receipt'}-${doc.localRef}.html`,
    };
  }
}

/**
 * Placeholder for the future 80mm thermal provider. Not wired up — there is
 * no printer yet (§25). It exists so the shape of the extension is visible:
 * `renderText()` already produces the 32-column body, so this becomes an
 * ESC/POS byte-framing exercise over WebUSB, not a layout rewrite.
 */
export class EscPosReceiptProvider implements ReceiptProvider {
  readonly capability = 'PHYSICAL' as const;
  readonly name = 'escpos';
  async render(): Promise<ReceiptOutput> {
    throw new Error(
      'No thermal printer is configured. Digital receipts are the MVP; ' +
      'this provider is a placeholder for when hardware is purchased.',
    );
  }
}
