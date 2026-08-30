import { describe, it, expect } from 'vitest';
import {
  emptyCart, addItem, setQty, removeLine, overridePrice,
  applyLineDiscount, applySaleDiscount, addTender, removeTender,
  computeTotals, isPayable, toSalePayload, CartError,
  type CatalogueItem, type Authority, type Cart,
} from './cart';
import { cents, bp, type Cents } from '../money/money';

const at = new Date('2026-08-15T09:00:00Z');

// Real menu items: a standard-rated smoothie and a zero-rated whole fruit.
const smoothie: CatalogueItem = {
  productId: 'p-smo', sku: 'SMO-MAN-L', name: 'Mango Smoothie (Large)',
  shortName: 'Mango L', categoryId: 'c1', categoryName: 'Smoothies', uom: 'EA',
  priceCents: cents(25_000), basePriceCents: cents(22_000), isEventPrice: true,
  taxCode: 'B', taxRateBp: bp(1600), itemClsCd: '50202301', itemCd: 'KE2NTU0000001',
  trackStock: true, qtyOnHand: 40, imagePath: null, tileOrder: 10, sellable: true,
};

const mango: CatalogueItem = {
  productId: 'p-fru', sku: 'FRU-MAN-EA', name: 'Whole Mango',
  shortName: 'Mango', categoryId: 'c2', categoryName: 'Fresh Fruit', uom: 'EA',
  priceCents: cents(5_000), basePriceCents: cents(5_000), isEventPrice: false,
  taxCode: 'C', taxRateBp: bp(0), itemClsCd: '50131500', itemCd: 'KE2NTU0000002',
  trackStock: true, qtyOnHand: 100, imagePath: null, tileOrder: 30, sellable: true,
};

const unclassified: CatalogueItem = {
  ...mango, productId: 'p-unc', sku: 'FRU-CUP-M', name: 'Cut Fruit Cup',
  taxCode: null, sellable: false,
};

const cashier: Authority = {
  cashierId: 'cash-1', maxDiscountBp: bp(500), canOverridePrice: false, canVoid: false,
};
const supervisor: Authority = {
  cashierId: 'sup-1', maxDiscountBp: bp(5000), canOverridePrice: true, canVoid: true,
};

const fresh = (): Cart => emptyCart('sale-1', 'TILL-01-000247', at);

describe('adding items', () => {
  it('refuses an unclassified product — the accountant gate', () => {
    expect(() => addItem(fresh(), unclassified, 'l1')).toThrow(CartError);
    try { addItem(fresh(), unclassified, 'l1'); }
    catch (e) { expect((e as CartError).code).toBe('NOT_SELLABLE'); }
  });

  it('merges repeat taps into one line instead of stacking rows', () => {
    let c = fresh();
    c = addItem(c, smoothie, 'l1');
    c = addItem(c, smoothie, 'l2');
    c = addItem(c, smoothie, 'l3');
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0].qty).toBe(3);
  });

  it('keeps an overridden line separate so it cannot be silently repriced', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = overridePrice(c, 'l1', cents(20_000), supervisor, 'damaged cup');
    c = addItem(c, smoothie, 'l2');
    expect(c.lines).toHaveLength(2);
    expect(c.lines[0].unitPrice).toBe(20_000);
    expect(c.lines[1].unitPrice).toBe(25_000);
  });

  it('uses the EVENT price, not the base price', () => {
    const c = addItem(fresh(), smoothie, 'l1');
    expect(c.lines[0].unitPrice).toBe(25_000);
    expect(c.lines[0].listPrice).toBe(25_000);
  });

  it('flags a sale below recorded stock but still allows it', () => {
    const scarce = { ...smoothie, qtyOnHand: 1 };
    const c = addItem(fresh(), scarce, 'l1', 5);
    expect(c.lines[0].belowRecordedStock).toBe(true);
    expect(c.lines).toHaveLength(1);          // never blocked
  });

  it('renumbers lines after a removal', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = addItem(c, mango, 'l2');
    c = removeLine(c, 'l1');
    expect(c.lines[0].lineNo).toBe(1);
  });

  it('treats setQty(0) as a removal', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = setQty(c, 'l1', 0);
    expect(c.lines).toHaveLength(0);
  });
});

describe('totals with mixed VAT bands', () => {
  it('separates a 16% smoothie from zero-rated fruit', () => {
    let c = addItem(fresh(), smoothie, 'l1', 2);   // 500.00 incl VAT
    c = addItem(c, mango, 'l2', 3);                // 150.00 zero-rated
    const t = computeTotals(c);

    expect(t.total).toBe(65_000);
    expect(t.taxTotal).toBe(6_897);                // 50000*1600/11600
    expect(t.subtotal + t.taxTotal).toBe(t.total);

    const bandB = t.taxBands.find((b) => b.code === 'B')!;
    const bandC = t.taxBands.find((b) => b.code === 'C')!;
    expect(bandB.tax).toBe(6_897);
    expect(bandC.tax).toBe(0);
  });

  it('counts units, including fractional weights', () => {
    const watermelon = { ...mango, productId: 'p-wat', uom: 'KG' };
    let c = addItem(fresh(), watermelon, 'l1', 1.5);
    const t = computeTotals(c);
    expect(t.unitCount).toBe(1.5);
    expect(t.total).toBe(7_500);
  });
});

describe('discount authority', () => {
  it('allows a discount inside the cashier limit without a supervisor', () => {
    let c = addItem(fresh(), smoothie, 'l1');       // 250.00
    c = applyLineDiscount(c, 'l1', cents(1_000), cashier);   // 4%
    expect(computeTotals(c).total).toBe(24_000);
  });

  it('blocks a discount above the limit and names the shortfall', () => {
    const c = addItem(fresh(), smoothie, 'l1');
    expect(() => applyLineDiscount(c, 'l1', cents(5_000), cashier))
      .toThrow(/Supervisor approval needed/);
  });

  it('permits it once the supervisor approves', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = applyLineDiscount(c, 'l1', cents(5_000), cashier, supervisor);
    expect(c.lines[0].approvedByCashierId).toBe('sup-1');
    expect(computeTotals(c).total).toBe(20_000);
  });

  it('refuses a discount larger than the line', () => {
    const c = addItem(fresh(), smoothie, 'l1');
    expect(() => applyLineDiscount(c, 'l1', cents(99_000), cashier, supervisor))
      .toThrow(/exceed the line total/);
  });

  it('spreads a sale discount without losing a cent', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = addItem(c, mango, 'l2', 3);
    c = applySaleDiscount(c, cents(1_000), supervisor);
    const t = computeTotals(c);
    expect(t.discountTotal).toBe(1_000);
    expect(t.subtotal + t.taxTotal).toBe(t.total);
  });
});

describe('price override', () => {
  it('requires the override permission, not just a PIN', () => {
    const c = addItem(fresh(), smoothie, 'l1');
    expect(() => overridePrice(c, 'l1', cents(10_000), cashier, 'goodwill'))
      .toThrow(/not permitted to change prices/);
  });

  it('requires a reason', () => {
    const c = addItem(fresh(), smoothie, 'l1');
    expect(() => overridePrice(c, 'l1', cents(10_000), supervisor, '   '))
      .toThrow(/reason is required/);
  });

  it('records the approver and the original list price', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = overridePrice(c, 'l1', cents(10_000), supervisor, 'melted');
    expect(c.lines[0].priceOverridden).toBe(true);
    expect(c.lines[0].listPrice).toBe(25_000);
    expect(c.lines[0].approvedByCashierId).toBe('sup-1');
  });
});

describe('split tender (SAL-04)', () => {
  it('handles the brief example: 1000 = 400 cash + 600 M-Pesa', () => {
    let c = addItem(fresh(), smoothie, 'l1', 4);   // 1000.00
    expect(computeTotals(c).total).toBe(100_000);

    c = addTender(c, { paymentId: 'pay-1', method: 'CASH', amount: cents(40_000) });
    expect(computeTotals(c).balanceDue).toBe(60_000);
    expect(isPayable(c)).toBe(false);

    c = addTender(c, {
      paymentId: 'pay-2', method: 'MPESA_C2B', amount: cents(60_000),
      mpesaTxnId: 'txn-1', mpesaReceipt: 'SLK7XU9P2Q',
    });
    expect(computeTotals(c).balanceDue).toBe(0);
    expect(isPayable(c)).toBe(true);
  });

  it('gives change on cash overpayment', () => {
    let c = addItem(fresh(), smoothie, 'l1');      // 250.00
    c = addTender(c, {
      paymentId: 'pay-1', method: 'CASH',
      amount: cents(25_000), tendered: cents(50_000),
    });
    const t = computeTotals(c);
    expect(t.balanceDue).toBe(0);
    expect(isPayable(c)).toBe(true);
  });

  it('refuses M-Pesa overpayment — we cannot refund at a stall', () => {
    const c = addItem(fresh(), smoothie, 'l1');
    expect(() => addTender(c, {
      paymentId: 'pay-1', method: 'MPESA_C2B', amount: cents(99_000),
    })).toThrow(/exceeds the balance due/);
  });

  it('reopens the balance when a tender is removed', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = addTender(c, { paymentId: 'pay-1', method: 'CASH', amount: cents(25_000) });
    expect(isPayable(c)).toBe(true);
    c = removeTender(c, 'pay-1');
    expect(isPayable(c)).toBe(false);
  });

  it('never marks an empty cart payable', () => {
    expect(isPayable(fresh())).toBe(false);
  });
});

describe('server payload', () => {
  it('sends the charged price so the server can DETECT an override', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = overridePrice(c, 'l1', cents(20_000), supervisor, 'melted');
    c = addTender(c, { paymentId: 'pay-1', method: 'CASH', amount: cents(20_000) });

    const p = toSalePayload(c, {
      shiftId: 'sh-1', cashierId: 'cash-1',
      idempotencyKey: 'idem-1', occurredAt: at,
    });

    expect(p.items[0].unit_price_cents).toBe(20_000);
    expect(p.items[0].price_overridden).toBe(true);
    expect(p.items[0].approved_by_cashier_id).toBe('sup-1');
    expect(p.items[0].override_reason).toBe('melted');
  });

  it('folds the spread sale discount into line discounts exactly', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = addItem(c, mango, 'l2', 3);
    c = applySaleDiscount(c, cents(1_000), supervisor);

    const p = toSalePayload(c, {
      shiftId: 'sh-1', cashierId: 'cash-1',
      idempotencyKey: 'idem-1', occurredAt: at,
    });

    const totalDiscount = p.items.reduce((s, i) => s + i.discount_cents, 0);
    expect(totalDiscount).toBe(1_000);
  });

  it('carries the matched M-Pesa transaction id', () => {
    let c = addItem(fresh(), smoothie, 'l1');
    c = addTender(c, {
      paymentId: 'pay-1', method: 'MPESA_C2B',
      amount: cents(25_000), mpesaTxnId: 'txn-9',
    });
    const p = toSalePayload(c, {
      shiftId: 'sh-1', cashierId: 'cash-1',
      idempotencyKey: 'idem-1', occurredAt: at,
    });
    expect(p.payments[0].mpesa_txn_id).toBe('txn-9');
  });

  it('carries a supervisor override for a reused manual M-Pesa code', () => {
    // complete_sale() rejects the whole sale if a manual code is already
    // attached to a different payment, unless these two fields are present
    // — this is the wire that connects the till's supervisor-approval
    // dialog to that server-side guard. If this breaks silently, a
    // legitimate re-entry (a voided-and-redone sale) would be unable to
    // ever complete, with no obvious reason why.
    let c = addItem(fresh(), smoothie, 'l1');
    c = addTender(c, {
      paymentId: 'pay-1', method: 'MPESA_MANUAL',
      amount: cents(25_000), mpesaReceipt: 'SLK7XU9P2Q', manualBank: 'NCBA',
      approvedByCashierId: 'supervisor-1', overrideReason: 'voided and redone',
    });
    const p = toSalePayload(c, {
      shiftId: 'sh-1', cashierId: 'cash-1',
      idempotencyKey: 'idem-1', occurredAt: at,
    });
    expect(p.payments[0].manual_reference).toBe('SLK7XU9P2Q');
    expect(p.payments[0].manual_bank).toBe('NCBA');
    expect(p.payments[0].approved_by_cashier_id).toBe('supervisor-1');
    expect(p.payments[0].override_reason).toBe('voided and redone');
  });
});