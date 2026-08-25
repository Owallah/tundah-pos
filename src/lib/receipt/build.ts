/**
 * receipt/build.ts — cart + server result → ReceiptDocument.
 *
 * Closes the loop: the till can show a receipt the instant complete_sale()
 * returns, without waiting for KRA. The same builder runs later on the server
 * with a fiscal block attached, which is why it takes the fiscal data as an
 * optional argument rather than fetching anything itself.
 */

import { computeTotals, type Cart } from '../pos/cart';
import { cents, type Cents } from '../money/money';
import type {
  ReceiptDocument, ReceiptBusiness, ReceiptLine, FiscalBlock,
} from './document';

export interface BuildReceiptContext {
  business: ReceiptBusiness;
  cashierName: string;
  deviceCode: string;
  eventName: string;
  issuedAt: Date;
  /** Present only once KRA has signed. Absent ⇒ provisional. */
  fiscal?: FiscalBlock;
  publicUrl?: string;
}

export function buildReceipt(cart: Cart, ctx: BuildReceiptContext): ReceiptDocument {
  const totals = computeTotals(cart);

  const lines: ReceiptLine[] = cart.lines.map((l) => ({
    lineNo: l.lineNo,
    name: l.name,
    qty: l.qty,
    uom: l.uom,
    unitPrice: l.unitPrice,
    discount: l.discount,
    lineTotal: cents(Math.round(l.qty * l.unitPrice) - l.discount),
    taxCode: l.taxCode,
  }));

  return {
    business: ctx.business,
    localRef: cart.localRef,
    issuedAt: ctx.issuedAt,
    cashierName: ctx.cashierName,
    deviceCode: ctx.deviceCode,
    eventName: ctx.eventName,
    customer: cart.customer,
    lines,
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    taxBands: totals.taxBands.map((b) => ({
      code: b.code, rateBp: b.rateBp, taxable: b.taxable, tax: b.tax,
    })),
    taxTotal: totals.taxTotal,
    total: totals.total,
    payments: cart.tenders.map((t) => ({
      method: t.method,
      amount: t.amount,
      reference: t.mpesaReceipt ?? null,
      // Manual codes are unverified until Daraja confirms them. This flag
      // drives the asterisk on the receipt and the split on the Z report.
      verified: t.method !== 'MPESA_MANUAL',
    })),
    changeGiven: cart.tenders.reduce(
      (sum, t) => sum + Math.max(0, (t.tendered ?? 0) - t.amount), 0,
    ) as Cents,
    fiscal: ctx.fiscal,
    publicUrl: ctx.publicUrl,
    isBackfilled: false,
  };
}
