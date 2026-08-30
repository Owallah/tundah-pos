/**
 * pos/cart.ts — the cart engine.
 *
 * Pure functions over an immutable cart state. No React, no network, no
 * clock, no randomness (ids are injected). This is deliberate: the cart is
 * where money is decided, so it must be exhaustively testable without
 * mounting a component or standing up a database.
 *
 * The server re-computes everything in complete_sale(). This module exists to
 * show the cashier correct numbers instantly — it is a preview, not an
 * authority. If the two ever disagree, the server wins and that is a bug in
 * this file (they implement the same arithmetic; see money.ts).
 */

import {
  cents, bp, computeLine, allocateDiscount,
  type Cents, type BasisPoints, type TaxTypeCode,
} from '../money/money';

export interface CatalogueItem {
  productId: string;
  sku: string;
  name: string;
  shortName: string;
  categoryId: string | null;
  categoryName: string | null;
  uom: string;
  /** Effective price for the ACTIVE EVENT, resolved server-side. */
  priceCents: Cents;
  basePriceCents: Cents;
  isEventPrice: boolean;
  taxCode: TaxTypeCode | null;
  taxRateBp: BasisPoints;
  itemClsCd: string | null;
  itemCd: string | null;
  trackStock: boolean;
  qtyOnHand: number;
  imagePath: string | null;
  tileOrder: number;
  /** False when the accountant hasn't classified it. Cannot be sold. */
  sellable: boolean;
}

export interface CartLine {
  lineId: string;
  productId: string;
  lineNo: number;
  name: string;
  shortName: string;
  uom: string;
  qty: number;
  /** What we are actually charging. Equals listPrice unless overridden. */
  unitPrice: Cents;
  listPrice: Cents;
  discount: Cents;
  taxCode: TaxTypeCode;
  taxRateBp: BasisPoints;
  priceOverridden: boolean;
  overrideReason?: string;
  approvedByCashierId?: string;
  /** Recorded stock was insufficient. Flag, never block (ARCHITECTURE §D.2). */
  belowRecordedStock: boolean;
}

export type TenderMethod = 'CASH' | 'MPESA_C2B' | 'MPESA_STK' | 'MPESA_MANUAL' | 'CARD';

export interface Tender {
  paymentId: string;
  method: TenderMethod;
  amount: Cents;
  /** Cash only: what the customer handed over. */
  tendered?: Cents;
  /** M-Pesa: the matched transaction. */
  mpesaTxnId?: string;
  mpesaReceipt?: string;
  /** M-Pesa manual only: which paybill this code is claimed to belong to. */
  manualBank?: 'NCBA' | 'COOP';
  /** Card/PDQ only: the terminal's own reference number on the slip. */
  cardReference?: string;
  /**
   * Set only when a supervisor knowingly approved re-accepting a manual
   * M-Pesa code that was already attached to a different sale. Absence of
   * this on a reused code is what complete_sale() rejects the sale for.
   */
  approvedByCashierId?: string;
  overrideReason?: string;
}

export interface Cart {
  saleId: string;
  localRef: string;
  lines: CartLine[];
  /** Sale-level discount, spread across lines at totalling time. */
  saleDiscount: Cents;
  tenders: Tender[];
  customer?: { kraPin?: string; name?: string; phone?: string };
  openedAt: Date;
}

export interface CartTotals {
  itemCount: number;
  unitCount: number;
  subtotal: Cents;
  lineDiscount: Cents;
  saleDiscount: Cents;
  discountTotal: Cents;
  taxTotal: Cents;
  total: Cents;
  tendered: Cents;
  balanceDue: Cents;
  changeDue: Cents;
  taxBands: Array<{ code: TaxTypeCode; rateBp: BasisPoints; taxable: Cents; tax: Cents }>;
}

export const emptyCart = (saleId: string, localRef: string, openedAt: Date): Cart => ({
  saleId, localRef, lines: [], saleDiscount: cents(0), tenders: [], openedAt,
});

// ── Errors the UI must handle explicitly ───────────────────────────────────

export type CartErrorCode =
  | 'NOT_SELLABLE'
  | 'DISCOUNT_EXCEEDS_LINE'
  | 'DISCOUNT_EXCEEDS_SALE'
  | 'NEEDS_APPROVAL'
  | 'LINE_NOT_FOUND'
  | 'INVALID_QTY'
  | 'OVERTENDERED_NON_CASH';

export class CartError extends Error {
  constructor(readonly code: CartErrorCode, message: string) {
    super(message);
    this.name = 'CartError';
  }
}

export interface Authority {
  cashierId: string;
  maxDiscountBp: BasisPoints;
  canOverridePrice: boolean;
  canVoid: boolean;
}

// ── Line operations ─────────────────────────────────────────────────────────

/**
 * Add an item. Adding the same product again increments the existing line
 * rather than creating a duplicate — a cashier tapping "Mango L" four times
 * should see `4 × Mango L`, not four rows. Overridden lines are kept separate,
 * because merging them would silently reprice.
 */
export function addItem(
  cart: Cart, item: CatalogueItem, lineId: string, qty = 1,
): Cart {
  if (!item.sellable || item.taxCode === null) {
    throw new CartError(
      'NOT_SELLABLE',
      `${item.name} has no KRA tax classification and cannot be sold.`,
    );
  }
  if (qty <= 0) throw new CartError('INVALID_QTY', 'Quantity must be positive.');

  const existing = cart.lines.find(
    (l) => l.productId === item.productId && !l.priceOverridden && l.discount === 0,
  );

  if (existing) {
    return replaceLine(cart, existing.lineId, {
      ...existing,
      qty: round3(existing.qty + qty),
      belowRecordedStock:
        item.trackStock && item.qtyOnHand < existing.qty + qty,
    });
  }

  const line: CartLine = {
    lineId,
    productId: item.productId,
    lineNo: cart.lines.length + 1,
    name: item.name,
    shortName: item.shortName,
    uom: item.uom,
    qty: round3(qty),
    unitPrice: item.priceCents,
    listPrice: item.priceCents,
    discount: cents(0),
    taxCode: item.taxCode,
    taxRateBp: item.taxRateBp,
    priceOverridden: false,
    belowRecordedStock: item.trackStock && item.qtyOnHand < qty,
  };

  return { ...cart, lines: [...cart.lines, line] };
}

export function setQty(cart: Cart, lineId: string, qty: number): Cart {
  if (qty <= 0) return removeLine(cart, lineId);
  const line = requireLine(cart, lineId);
  return replaceLine(cart, lineId, { ...line, qty: round3(qty) });
}

export function removeLine(cart: Cart, lineId: string): Cart {
  const lines = cart.lines
    .filter((l) => l.lineId !== lineId)
    .map((l, i) => ({ ...l, lineNo: i + 1 }));
  return { ...cart, lines };
}

/** Price override (SAL-02). Always requires an approver — the server agrees. */
export function overridePrice(
  cart: Cart, lineId: string, newPrice: Cents,
  approver: Authority, reason: string,
): Cart {
  const line = requireLine(cart, lineId);

  if (!approver.canOverridePrice) {
    throw new CartError(
      'NEEDS_APPROVAL',
      'That user is not permitted to change prices.',
    );
  }
  if (!reason.trim()) {
    throw new CartError('NEEDS_APPROVAL', 'A reason is required to change a price.');
  }

  return replaceLine(cart, lineId, {
    ...line,
    unitPrice: newPrice,
    priceOverridden: newPrice !== line.listPrice,
    overrideReason: reason,
    approvedByCashierId: approver.cashierId,
  });
}

/**
 * Line discount. Within the cashier's own authority no approver is needed;
 * beyond it, one is. The threshold is in basis points of the pre-discount
 * line total, matching complete_sale() exactly.
 */
export function applyLineDiscount(
  cart: Cart, lineId: string, discount: Cents,
  cashier: Authority, approver?: Authority,
): Cart {
  const line = requireLine(cart, lineId);
  const lineTotal = cents(Math.round(line.qty * line.unitPrice));

  if (discount > lineTotal) {
    throw new CartError(
      'DISCOUNT_EXCEEDS_LINE',
      `Discount cannot exceed the line total.`,
    );
  }

  const discountBp = lineTotal === 0 ? 0 : Math.floor((discount * 10_000) / lineTotal);

  if (discountBp > cashier.maxDiscountBp) {
    if (!approver) {
      throw new CartError(
        'NEEDS_APPROVAL',
        `${(discountBp / 100).toFixed(1)}% is above this cashier's ` +
        `${(cashier.maxDiscountBp / 100).toFixed(1)}% limit. Supervisor approval needed.`,
      );
    }
    if (discountBp > approver.maxDiscountBp) {
      throw new CartError(
        'NEEDS_APPROVAL',
        `${(discountBp / 100).toFixed(1)}% is above the approver's limit too.`,
      );
    }
  }

  return replaceLine(cart, lineId, {
    ...line,
    discount,
    approvedByCashierId: approver?.cashierId ?? line.approvedByCashierId,
  });
}

export function applySaleDiscount(
  cart: Cart, discount: Cents, cashier: Authority, approver?: Authority,
): Cart {
  const gross = cart.lines.reduce(
    (sum, l) => sum + Math.round(l.qty * l.unitPrice) - l.discount, 0,
  );
  if (discount > gross) {
    throw new CartError('DISCOUNT_EXCEEDS_SALE', 'Discount cannot exceed the sale total.');
  }

  const discountBp = gross === 0 ? 0 : Math.floor((discount * 10_000) / gross);
  if (discountBp > cashier.maxDiscountBp && !approver) {
    throw new CartError(
      'NEEDS_APPROVAL',
      `${(discountBp / 100).toFixed(1)}% is above this cashier's limit.`,
    );
  }
  return { ...cart, saleDiscount: discount };
}

// ── Tenders ─────────────────────────────────────────────────────────────────

export function addTender(cart: Cart, tender: Tender): Cart {
  const { balanceDue } = computeTotals(cart);

  // Only cash can exceed the balance — change is given from the drawer.
  // Overpaying by M-Pesa would mean owing the customer money we cannot refund
  // at the stall, so it is refused at the point of entry.
  if (tender.method !== 'CASH' && tender.amount > balanceDue) {
    throw new CartError(
      'OVERTENDERED_NON_CASH',
      `M-Pesa payment exceeds the balance due. Enter ${formatDue(balanceDue)} or less.`,
    );
  }
  return { ...cart, tenders: [...cart.tenders, tender] };
}

export function removeTender(cart: Cart, paymentId: string): Cart {
  return { ...cart, tenders: cart.tenders.filter((t) => t.paymentId !== paymentId) };
}

// ── Totals ──────────────────────────────────────────────────────────────────

export function computeTotals(cart: Cart, pricesIncludeVat = true): CartTotals {
  // Spread the sale-level discount across lines before tax, using
  // largest-remainder allocation so no cent is lost.
  const lineGross = cart.lines.map((l) =>
    cents(Math.round(l.qty * l.unitPrice) - l.discount),
  );
  const spread = cart.saleDiscount > 0
    ? allocateDiscount(lineGross, cart.saleDiscount)
    : cart.lines.map(() => cents(0));

  const bandMap = new Map<TaxTypeCode, { rateBp: BasisPoints; taxable: number; tax: number }>();

  let subtotal = 0, taxTotal = 0, total = 0, lineDiscount = 0, unitCount = 0;

  cart.lines.forEach((l, i) => {
    const r = computeLine(
      {
        qty: l.qty,
        unitPrice: l.unitPrice,
        discount: cents(l.discount + spread[i]),
        taxRate: l.taxRateBp,
      },
      pricesIncludeVat,
    );

    const band = bandMap.get(l.taxCode) ?? { rateBp: l.taxRateBp, taxable: 0, tax: 0 };
    band.taxable += r.gross;
    band.tax += r.vat;
    bandMap.set(l.taxCode, band);

    subtotal += r.net;
    taxTotal += r.vat;
    total += r.total;
    lineDiscount += l.discount;
    unitCount += l.qty;
  });

  const tendered = cart.tenders.reduce((s, t) => s + t.amount, 0);
  const balanceDue = Math.max(0, total - tendered);
  const changeDue = Math.max(0, tendered - total);

  return {
    itemCount: cart.lines.length,
    unitCount: round3(unitCount),
    subtotal: cents(subtotal),
    lineDiscount: cents(lineDiscount),
    saleDiscount: cart.saleDiscount,
    discountTotal: cents(lineDiscount + cart.saleDiscount),
    taxTotal: cents(taxTotal),
    total: cents(total),
    tendered: cents(tendered),
    balanceDue: cents(balanceDue),
    changeDue: cents(changeDue),
    taxBands: [...bandMap.entries()].map(([code, b]) => ({
      code, rateBp: b.rateBp, taxable: cents(b.taxable), tax: cents(b.tax),
    })),
  };
}

export function isPayable(cart: Cart): boolean {
  const t = computeTotals(cart);
  return cart.lines.length > 0 && t.total > 0 && t.balanceDue === 0;
}

// ── Server payload ──────────────────────────────────────────────────────────

/**
 * Build the complete_sale() payload.
 *
 * `unit_price_cents` is included so the server can DETECT an override, not so
 * it can trust the number. The server resolves the real price from
 * event_prices and rejects any mismatch that lacks approval.
 */
export function toSalePayload(
  cart: Cart,
  ctx: { shiftId: string; cashierId: string; idempotencyKey: string; occurredAt: Date },
) {
  const totals = computeTotals(cart);
  const lineGross = cart.lines.map((l) =>
    cents(Math.round(l.qty * l.unitPrice) - l.discount),
  );
  const spread = cart.saleDiscount > 0
    ? allocateDiscount(lineGross, cart.saleDiscount)
    : cart.lines.map(() => cents(0));

  return {
    sale_id: cart.saleId,
    local_ref: cart.localRef,
    shift_id: ctx.shiftId,
    cashier_id: ctx.cashierId,
    idempotency_key: ctx.idempotencyKey,
    occurred_at: ctx.occurredAt.toISOString(),
    customer: cart.customer ?? {},
    items: cart.lines.map((l, i) => ({
      line_id: l.lineId,
      product_id: l.productId,
      line_no: l.lineNo,
      qty: l.qty,
      unit_price_cents: l.unitPrice,
      discount_cents: l.discount + spread[i],
      price_overridden: l.priceOverridden,
      override_reason: l.overrideReason ?? null,
      approved_by_cashier_id: l.approvedByCashierId ?? null,
    })),
    payments: cart.tenders.map((t) => ({
      payment_id: t.paymentId,
      method: t.method,
      amount_cents: t.amount,
      tendered_cents: t.tendered ?? null,
      change_cents: t.method === 'CASH' && t.tendered
        ? Math.max(0, t.tendered - t.amount)
        : null,
      mpesa_txn_id: t.mpesaTxnId ?? null,
      // The code a cashier types for MPESA_MANUAL. Previously dropped here
      // and never reached the server at all — see 0024_manual_mpesa_ledger.
      manual_reference: t.mpesaReceipt ?? null,
      // Which paybill a manual code is claimed to belong to (NCBA or Co-op)
      // — see 0030_card_and_bank_tagged_manual.
      manual_bank: t.manualBank ?? null,
      // A card/PDQ terminal's own slip reference — a different rail
      // entirely from M-Pesa, so it lives on `payments` directly, not in
      // the mpesa_transactions ledger.
      card_reference: t.cardReference ?? null,
      // Present only when a supervisor approved re-accepting a code
      // already attached to a different sale — see 0033_reused_code_guard.
      approved_by_cashier_id: t.approvedByCashierId ?? null,
      override_reason: t.overrideReason ?? null,
    })),
    _preview_total_cents: totals.total,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function requireLine(cart: Cart, lineId: string): CartLine {
  const line = cart.lines.find((l) => l.lineId === lineId);
  if (!line) throw new CartError('LINE_NOT_FOUND', 'That line is no longer in the cart.');
  return line;
}

function replaceLine(cart: Cart, lineId: string, next: CartLine): Cart {
  return { ...cart, lines: cart.lines.map((l) => (l.lineId === lineId ? next : l)) };
}

/** Quantities are numeric(13,3) in Postgres. Keep the client in step. */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function formatDue(c: Cents): string {
  return `KES ${(c / 100).toFixed(2)}`;
}