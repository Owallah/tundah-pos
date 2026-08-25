import { describe, it, expect } from 'vitest';
import {
  renderText, isFiscal, HtmlReceiptProvider, TextReceiptProvider,
  EscPosReceiptProvider, type ReceiptDocument,
} from './document';
import { cents, bp } from '../money/money';

const base: ReceiptDocument = {
  business: {
    legalName: 'Nyota Fresh Ltd',
    tradingName: 'Nyota Juice Bar',
    kraPin: 'P051234567M',
    address: 'Ngong Road, Nairobi',
    phone: '0712 345 678',
    vatRegistered: true,
  },
  localRef: 'TILL-01-000247',
  issuedAt: new Date('2026-08-15T14:32:00'),
  cashierName: 'Achieng',
  deviceCode: 'TILL-01',
  eventName: 'Nairobi Food Festival',
  lines: [
    { lineNo: 1, name: 'Mango Smoothie (Large)', qty: 2, uom: 'EA',
      unitPrice: cents(25_000), discount: cents(0),
      lineTotal: cents(50_000), taxCode: 'B' },
    { lineNo: 2, name: 'Whole Mango', qty: 3, uom: 'EA',
      unitPrice: cents(5_000), discount: cents(0),
      lineTotal: cents(15_000), taxCode: 'C' },
  ],
  subtotal: cents(58_103),
  discountTotal: cents(0),
  taxBands: [
    { code: 'B', rateBp: bp(1600), taxable: cents(50_000), tax: cents(6_897) },
    { code: 'C', rateBp: bp(0), taxable: cents(15_000), tax: cents(0) },
  ],
  taxTotal: cents(6_897),
  total: cents(65_000),
  payments: [
    { method: 'CASH', amount: cents(65_000), verified: true },
  ],
  changeGiven: cents(0),
  publicUrl: 'https://pos.nyota.co.ke/r/abc123',
  isBackfilled: false,
};

const fiscal: ReceiptDocument = {
  ...base,
  fiscal: {
    invcNo: 1042,
    curRcptNo: 87,
    totRcptNo: 87,
    intrlData: 'YWJjZGVmZ2hpamtsbW5vcHFy',
    rcptSign: 'A1B2C3D4E5F6G7H8',
    sdcDateTime: new Date('2026-08-15T14:32:03'),
  },
};

describe('receipt state', () => {
  it('distinguishes provisional from fiscal by the signature alone', () => {
    expect(isFiscal(base)).toBe(false);
    expect(isFiscal(fiscal)).toBe(true);
  });
});

describe('provisional receipt', () => {
  const out = renderText(base);

  it('says plainly that it is not a tax invoice', () => {
    expect(out).toMatch(/PROVISIONAL RECEIPT/);
    expect(out).toMatch(/NOT A TAX INVOICE/);
  });

  it('never fabricates a KRA signature', () => {
    expect(out).not.toMatch(/eTIMS/);
    expect(out).not.toMatch(/Signature/);
    expect(out).not.toMatch(/A1B2C3D4E5F6G7H8/);
  });

  it('still gives the customer a link that will resolve later', () => {
    expect(out).toMatch(/pos\.nyota\.co\.ke/);
  });
});

describe('fiscal invoice', () => {
  const out = renderText(fiscal);

  it('carries the five KRA fields', () => {
    expect(out).toMatch(/TAX INVOICE/);
    expect(out).toMatch(/A1B2C3D4E5F6G7H8/);
    expect(out).toMatch(/YWJjZGVmZ2hpamtsbW5vcHFy/);
    expect(out).toMatch(/87\/87/);
    expect(out).toMatch(/1042/);
  });

  it('does not carry the provisional warning', () => {
    expect(out).not.toMatch(/NOT A TAX INVOICE/);
  });
});

describe('layout', () => {
  it('fits 80mm thermal width so the printer provider is a transport swap', () => {
    for (const line of renderText(fiscal).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(32);
    }
  });

  it('shows mixed VAT bands separately, including the zero-rated one', () => {
    const out = renderText(base);
    expect(out).toMatch(/VAT B 16%/);
    expect(out).toMatch(/C \(no VAT\)/);
  });

  it('marks a zero-rated line so the customer can see why VAT differs', () => {
    expect(renderText(base)).toMatch(/Whole Mango \(C\)/);
  });

  it('flags unverified payments with an explained asterisk', () => {
    const manual: ReceiptDocument = {
      ...base,
      payments: [{
        method: 'MPESA_MANUAL', amount: cents(65_000),
        reference: 'SLK7XU9P2Q', verified: false,
      }],
    };
    const out = renderText(manual);
    expect(out).toMatch(/MPESA MANUAL \*/);
    expect(out).toMatch(/\* payment awaiting verification/);
  });

  it('marks a backfilled paper slip', () => {
    const out = renderText({ ...base, isBackfilled: true, backfillRef: 'A-0042' });
    expect(out).toMatch(/ENTERED FROM PAPER/);
    expect(out).toMatch(/Slip A-0042/);
  });

  it('shows change on cash overpayment', () => {
    const out = renderText({ ...base, changeGiven: cents(3_500) });
    expect(out).toMatch(/Change\s+35\.00/);
  });
});

describe('providers', () => {
  it('html renders both states with different banners', async () => {
    const p = new HtmlReceiptProvider();
    const prov = await p.render(base);
    const fis = await p.render(fiscal);

    expect(String(prov.body)).toMatch(/not a tax invoice/i);
    expect(String(fis.body)).toMatch(/Tax invoice/);
    expect(String(fis.body)).toMatch(/A1B2C3D4E5F6G7H8/);
    expect(prov.contentType).toMatch(/text\/html/);
  });

  it('html escapes injected content', async () => {
    const nasty: ReceiptDocument = {
      ...base,
      cashierName: '<script>alert(1)</script>',
    };
    const out = String((await new HtmlReceiptProvider().render(nasty)).body);
    expect(out).not.toMatch(/<script>alert/);
    expect(out).toMatch(/&lt;script&gt;/);
  });

  it('text provider returns plain text', async () => {
    const out = await new TextReceiptProvider().render(fiscal);
    expect(out.contentType).toMatch(/text\/plain/);
  });

  it('the printer provider refuses honestly rather than silently no-oping', async () => {
    await expect(new EscPosReceiptProvider().render()).rejects.toThrow(/No thermal printer/);
  });
});

// ── Builder: cart → receipt ────────────────────────────────────────────────

import { buildReceipt } from './build';
import { emptyCart, addItem, addTender, type CatalogueItem } from '../pos/cart';

const smoothie: CatalogueItem = {
  productId: 'p1', sku: 'SMO-MAN-L', name: 'Mango Smoothie (Large)',
  shortName: 'Mango L', categoryId: 'c1', categoryName: 'Smoothies', uom: 'EA',
  priceCents: cents(25_000), basePriceCents: cents(25_000), isEventPrice: false,
  taxCode: 'B', taxRateBp: bp(1600), itemClsCd: null, itemCd: null,
  trackStock: true, qtyOnHand: 20, imagePath: null, tileOrder: 1, sellable: true,
};

const ctx = {
  business: base.business,
  cashierName: 'Achieng', deviceCode: 'TILL-01',
  eventName: 'Nairobi Food Festival',
  issuedAt: new Date('2026-08-15T14:32:00'),
  publicUrl: 'https://pos.nyota.co.ke/r/abc123',
};

describe('buildReceipt', () => {
  it('produces a provisional receipt immediately after payment', () => {
    let c = emptyCart('s1', 'TILL-01-000248', new Date());
    c = addItem(c, smoothie, 'l1', 2);
    c = addTender(c, {
      paymentId: 'pay1', method: 'CASH',
      amount: cents(50_000), tendered: cents(100_000),
    });

    const doc = buildReceipt(c, ctx);

    expect(isFiscal(doc)).toBe(false);
    expect(doc.total).toBe(50_000);
    expect(doc.changeGiven).toBe(50_000);
    expect(renderText(doc)).toMatch(/NOT A TAX INVOICE/);
  });

  it('becomes a tax invoice once the fiscal block is attached', () => {
    let c = emptyCart('s1', 'TILL-01-000248', new Date());
    c = addItem(c, smoothie, 'l1');
    c = addTender(c, { paymentId: 'pay1', method: 'CASH', amount: cents(25_000) });

    const doc = buildReceipt(c, { ...ctx, fiscal: fiscal.fiscal });

    expect(isFiscal(doc)).toBe(true);
    expect(renderText(doc)).toMatch(/TAX INVOICE/);
    expect(renderText(doc)).toMatch(/A1B2C3D4E5F6G7H8/);
  });

  it('marks a manual M-Pesa code unverified', () => {
    let c = emptyCart('s1', 'TILL-01-000248', new Date());
    c = addItem(c, smoothie, 'l1');
    c = addTender(c, {
      paymentId: 'pay1', method: 'MPESA_MANUAL',
      amount: cents(25_000), mpesaReceipt: 'SLK7XU9P2Q',
    });

    const doc = buildReceipt(c, ctx);
    expect(doc.payments[0].verified).toBe(false);
    expect(renderText(doc)).toMatch(/\* payment awaiting verification/);
  });

  it('carries a C2B receipt number through to the printed reference', () => {
    let c = emptyCart('s1', 'TILL-01-000248', new Date());
    c = addItem(c, smoothie, 'l1');
    c = addTender(c, {
      paymentId: 'pay1', method: 'MPESA_C2B',
      amount: cents(25_000), mpesaTxnId: 't1', mpesaReceipt: 'SLK7XU9P2Q',
    });

    const doc = buildReceipt(c, ctx);
    expect(doc.payments[0].verified).toBe(true);
    expect(renderText(doc)).toMatch(/SLK7XU9P2Q/);
  });
});
