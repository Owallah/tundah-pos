import { describe, it, expect } from 'vitest';
import {
  normalisePhone, parseDarajaTimestamp, normaliseC2BConfirmation,
  normaliseStkCallback, isSafaricomSource,
  type C2BConfirmation, type StkCallback,
} from './daraja';
import { matchC2BPayment, maskPhone, type CandidatePayment } from './matcher';
import { cents, type Cents } from '../money/money';

describe('normalisePhone', () => {
  it('normalises every Kenyan format to 2547XXXXXXXX', () => {
    for (const input of ['0712345678', '+254712345678', '254712345678', '712345678']) {
      expect(normalisePhone(input)).toBe('254712345678');
    }
  });
});

describe('parseDarajaTimestamp', () => {
  it('parses yyyyMMddHHmmss', () => {
    const d = parseDarajaTimestamp('20260814143005')!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);      // August
    expect(d.getDate()).toBe(14);
    expect(d.getHours()).toBe(14);
  });

  it('returns null on junk rather than an Invalid Date', () => {
    expect(parseDarajaTimestamp('not-a-date')).toBeNull();
  });
});

describe('C2B confirmation normalisation', () => {
  const payload: C2BConfirmation = {
    TransactionType: 'Buy Goods Online',
    TransID: 'SLK7XU9P2Q',
    TransTime: '20260814143005',
    TransAmount: '250.00',
    BusinessShortCode: '123456',
    BillRefNumber: '',
    InvoiceNumber: '',
    OrgAccountBalance: '15000.00',
    ThirdPartyTransID: '',
    MSISDN: '254712345678',
    FirstName: 'JANE',
    MiddleName: '',
    LastName: 'WANJIKU',
  };

  it('converts shillings to cents without float drift', () => {
    const p = normaliseC2BConfirmation(payload);
    expect(p.amount).toBe(25_000);
    expect(p.receiptNumber).toBe('SLK7XU9P2Q');
    expect(p.payerName).toBe('JANE WANJIKU');
    expect(p.channel).toBe('C2B');
  });

  it('handles amounts with awkward decimals', () => {
    const p = normaliseC2BConfirmation({ ...payload, TransAmount: '0.10' });
    expect(p.amount).toBe(10);
  });
});

describe('STK callback normalisation', () => {
  it('extracts the receipt on success', () => {
    const cb: StkCallback = {
      Body: {
        stkCallback: {
          MerchantRequestID: 'm-1', CheckoutRequestID: 'ws_CO_1',
          ResultCode: 0, ResultDesc: 'Success',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 250 },
              { Name: 'MpesaReceiptNumber', Value: 'SLK7XU9P2Q' },
              { Name: 'TransactionDate', Value: 20260814143005 },
              { Name: 'PhoneNumber', Value: 254712345678 },
            ],
          },
        },
      },
    };
    const r = normaliseStkCallback(cb);
    expect(r.success).toBe(true);
    expect(r.payment?.amount).toBe(25_000);
    expect(r.payment?.receiptNumber).toBe('SLK7XU9P2Q');
  });

  it('yields no payment when the customer cancels', () => {
    const r = normaliseStkCallback({
      Body: {
        stkCallback: {
          MerchantRequestID: 'm-2', CheckoutRequestID: 'ws_CO_2',
          ResultCode: 1032, ResultDesc: 'Request cancelled by user',
        },
      },
    });
    expect(r.success).toBe(false);
    expect(r.payment).toBeUndefined();
  });
});

describe('Safaricom IP allowlist', () => {
  it('accepts a known source and rejects others', () => {
    expect(isSafaricomSource('196.201.214.200')).toBe(true);
    expect(isSafaricomSource('196.201.214.200, 10.0.0.1')).toBe(true);  // XFF chain
    expect(isSafaricomSource('8.8.8.8')).toBe(false);
    expect(isSafaricomSource(null)).toBe(false);
  });
});

// ── The matcher: the three-tills-one-till-number problem ───────────────────

const tenderOpenedAt = new Date('2026-08-14T14:30:00Z');
const now = new Date('2026-08-14T14:30:20Z');

function candidate(over: Partial<CandidatePayment> = {}): CandidatePayment {
  return {
    mpesaTxnId: crypto.randomUUID(),
    receiptNumber: 'SLK' + Math.random().toString(36).slice(2, 9).toUpperCase(),
    amount: cents(25_000),
    phoneNumber: '254712345678',
    payerName: 'JANE WANJIKU',
    confirmedAt: new Date('2026-08-14T14:30:10Z'),
    matched: false,
    ...over,
  };
}

describe('matchC2BPayment', () => {
  it('confidently matches a single exact payment', () => {
    const r = matchC2BPayment([candidate()], {
      amountDue: cents(25_000), tenderOpenedAt, now,
    });
    expect(r.confident).not.toBeNull();
    expect(r.ambiguous).toBe(false);
    expect(r.confident!.reasons).toContain('exact amount');
  });

  it('REFUSES to auto-match two identical amounts — the dangerous case', () => {
    const r = matchC2BPayment(
      [
        candidate({ payerName: 'JANE W', phoneNumber: '254712345678' }),
        candidate({ payerName: 'PETER K', phoneNumber: '254733999888' }),
      ],
      { amountDue: cents(25_000), tenderOpenedAt, now },
    );
    expect(r.confident).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.candidates).toHaveLength(2);
  });

  it('resolves that ambiguity when the customer reads out their number', () => {
    const r = matchC2BPayment(
      [
        candidate({ phoneNumber: '254712345678' }),
        candidate({ phoneNumber: '254733999888' }),
      ],
      { amountDue: cents(25_000), tenderOpenedAt, now, phoneHint: '888' },
    );
    expect(r.confident).not.toBeNull();
    expect(r.confident!.candidate.phoneNumber).toBe('254733999888');
  });

  it('never offers an already-matched payment', () => {
    const r = matchC2BPayment([candidate({ matched: true })], {
      amountDue: cents(25_000), tenderOpenedAt, now,
    });
    expect(r.candidates).toHaveLength(0);
    expect(r.confident).toBeNull();
  });

  it('ignores stale payments outside the window', () => {
    const r = matchC2BPayment(
      [candidate({ confirmedAt: new Date('2026-08-14T13:00:00Z') })],
      { amountDue: cents(25_000), tenderOpenedAt, now },
    );
    expect(r.candidates).toHaveLength(0);
  });

  it('offers a small overpayment but not a wild one', () => {
    const ok = matchC2BPayment([candidate({ amount: cents(30_000) })], {
      amountDue: cents(25_000), tenderOpenedAt, now,
    });
    expect(ok.candidates).toHaveLength(1);

    const tooFar = matchC2BPayment([candidate({ amount: cents(500_000) })], {
      amountDue: cents(25_000), tenderOpenedAt, now,
    });
    expect(tooFar.candidates).toHaveLength(0);
  });

  it('surfaces partial payments for split tender without over-trusting them', () => {
    const r = matchC2BPayment([candidate({ amount: cents(10_000) })], {
      amountDue: cents(25_000), tenderOpenedAt, now,
    });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].reasons).toContain('partial payment');
    expect(r.confident).toBeNull();   // never auto-match a partial
  });
});

describe('maskPhone', () => {
  it('masks for on-screen display', () => {
    expect(maskPhone('254712345678')).toBe('0712***678');
    expect(maskPhone(null)).toBe('unknown');
  });
});
