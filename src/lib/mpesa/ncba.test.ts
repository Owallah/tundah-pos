import { describe, it, expect, vi, afterEach } from 'vitest';
import { NcbaClient, NcbaProvider, NcbaError, normaliseNcbaPhone } from './ncba';
import { cents } from '../money/money';

const config = {
  username: 'u', password: 'p',
  payBillNo: '880100', tillCode: 'PAY100D',
};

function mockFetch(...responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body,
    });
  }
  vi.stubGlobal('fetch', fn);
  return fn;
}

const TOKEN = { body: { access_token: 'jwt', token_type: 'Bearer', expires_in: 18000, status: 200 } };

afterEach(() => vi.unstubAllGlobals());

describe('normaliseNcbaPhone', () => {
  it('produces the 254XXXXXXXXX form the spec shows', () => {
    for (const v of ['0712345678', '+254712345678', '254712345678', '712345678']) {
      expect(normaliseNcbaPhone(v)).toBe('254712345678');
    }
  });
});

describe('token', () => {
  it('caches and does not re-request on the next call', async () => {
    const f = mockFetch(TOKEN,
      { body: { TransactionID: 'T1', StatusCode: '0', StatusDescription: 'ok', ReferenceID: 'R1' } },
      { body: { TransactionID: 'T2', StatusCode: '0', StatusDescription: 'ok', ReferenceID: 'R2' } });

    const c = new NcbaClient(config);
    await c.stkPush({ phone: '254712345678', amountCents: cents(25_000), accountNo: 'A' });
    await c.stkPush({ phone: '254712345678', amountCents: cents(25_000), accountNo: 'A' });

    // 1 token + 2 pushes, not 2 tokens.
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('names bad credentials rather than reporting a generic failure', async () => {
    mockFetch({ ok: false, status: 401, body: { message: 'Invalid API credentials' } });
    const c = new NcbaClient(config);
    await expect(c.stkQuery('T1')).rejects.toThrow(/credentials/i);
  });
});

describe('stkPush', () => {
  it('sends the exact field names from the specification', async () => {
    const f = mockFetch(TOKEN,
      { body: { TransactionID: 'T1', StatusCode: '0', StatusDescription: 'ok', ReferenceID: 'R1' } });

    const c = new NcbaClient(config);
    await c.stkPush({ phone: '0712345678', amountCents: cents(25_000), accountNo: 'PAY100D-TT1-247' });

    const body = JSON.parse(f.mock.calls[1][1].body);
    expect(body).toEqual({
      TelephoneNo: '254712345678',
      Amount: '250',                       // shillings, not cents
      PayBillNo: '880100',
      AccountNo: 'PAY100D-TT1-247',
      Network: 'Safaricom',
      TransactionType: 'CustomerPayBillOnline',
    });
  });

  it('refuses a part-shilling amount instead of silently rounding', async () => {
    mockFetch(TOKEN);
    const c = new NcbaClient(config);
    // Rounding down would leave the sale permanently short.
    await expect(c.stkPush({
      phone: '254712345678', amountCents: cents(25_050), accountNo: 'A',
    })).rejects.toThrow(/whole shillings/i);
  });

  it('treats an HTTP 200 failure as REJECTED, not success', async () => {
    // The spec returns failures as 200 with TransactionID null and StatusCode 1.
    mockFetch(TOKEN,
      { body: { TransactionID: null, StatusCode: '1', StatusDescription: 'Insufficient funds', ReferenceID: null } });

    const p = new NcbaProvider(config);
    const r = await p.stkPush({
      phone: '254712345678', amount: cents(25_000),
      accountReference: 'TT1-247', description: 'Sale',
    });

    expect(r.status).toBe('REJECTED');
    expect(r.message).toMatch(/Insufficient funds/);
  });

  it('returns the TransactionID as the correlation handle', async () => {
    mockFetch(TOKEN,
      { body: { TransactionID: 'NCBA-99', StatusCode: '0', StatusDescription: 'Sent', ReferenceID: 'REF-99' } });

    const p = new NcbaProvider(config);
    const r = await p.stkPush({
      phone: '254712345678', amount: cents(25_000),
      accountReference: 'TT1-247', description: 'Sale',
    });

    expect(r.status).toBe('SENT');
    expect(r.checkoutRequestId).toBe('NCBA-99');
    expect(r.merchantRequestId).toBe('REF-99');
  });
});

describe('stkQuery', () => {
  it.each([
    ['SUCCESS', 0],
    ['FAILED', 1],
    ['PROCESSING', -1],   // anything else stays pending
  ])('maps %s onto result code %i', async (status, code) => {
    mockFetch(TOKEN, { body: { status, description: 'd' } });
    const p = new NcbaProvider(config);
    expect((await p.stkQuery('T1')).resultCode).toBe(code);
  });
});

describe('QR', () => {
  it('puts the sale reference in the narration', async () => {
    const f = mockFetch(TOKEN,
      { body: { StatusCode: '0', StatusDescription: 'Success', Base64QrCode: 'data:image/png;base64,AAA' } });

    const p = new NcbaProvider(config);
    const r = await p.generateQr(cents(25_000), 'TT1-247');

    const body = JSON.parse(f.mock.calls[1][1].body);
    expect(body.till).toBe('PAY100D#TT1-247');
    expect(body.amount).toBe(250);
    expect(r.dataUri).toMatch(/^data:image\/png;base64,/);
  });

  it('omits amount when none is given, per the spec', async () => {
    const f = mockFetch(TOKEN,
      { body: { StatusCode: '0', StatusDescription: 'Success', Base64QrCode: 'data:image/png;base64,AAA' } });

    await new NcbaClient(config).generateQr({});
    const body = JSON.parse(f.mock.calls[1][1].body);
    expect(body).toEqual({ till: 'PAY100D' });
  });

  it('treats StatusCode 2 as failure even though HTTP is 200', async () => {
    mockFetch(TOKEN,
      { body: { StatusCode: '2', StatusDescription: 'Invalid till', Base64QrCode: '' } });

    await expect(new NcbaClient(config).generateQr({ amountCents: cents(100) }))
      .rejects.toThrow(NcbaError);
  });
});

describe('provider capabilities', () => {
  const p = new NcbaProvider(config);

  it('declares that it needs polling and returns no receipt number', () => {
    // Both are true of NCBA and false of Daraja. The reconciliation screen
    // depends on knowing the difference.
    expect(p.requiresPolling).toBe(true);
    expect(p.returnsReceiptNumber).toBe(false);
  });

  it('supports exact matching, unlike a Buy Goods till', () => {
    expect(p.supportsExactMatching()).toBe(true);
    expect(p.accountNumberFor('TT1-247')).toBe('PAY100D-TT1-247');
  });
});
