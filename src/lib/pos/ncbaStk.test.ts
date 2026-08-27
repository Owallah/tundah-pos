import { describe, it, expect, vi } from 'vitest';
import { initiateStk, pollStk, abandonStk, secondsRemaining } from './ncbaStk';
import { cents } from '../money/money';
import type { SupabaseClient } from '@supabase/supabase-js';

function fakeSupabase(responses: unknown[]): SupabaseClient {
  let i = 0;
  return {
    functions: {
      invoke: vi.fn(async () => ({ data: responses[Math.min(i++, responses.length - 1)], error: null })),
    },
  } as unknown as SupabaseClient;
}

const SENT = {
  status: 'SENT', mpesa_txn_id: 'M1', provider_txn_id: 'NCBA-1',
  provider_reference: 'REF-1', account_no: 'PAY100D-TT1-247',
};

describe('initiateStk', () => {
  it('returns the handle the poll loop needs', async () => {
    const r = await initiateStk(fakeSupabase([SENT]), {
      phone: '0712345678', amount: cents(25_000), saleRef: 'TT1-247',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.providerTxnId).toBe('NCBA-1');
      expect(r.data.accountNo).toBe('PAY100D-TT1-247');
    }
  });

  it('surfaces an NCBA rejection with its reason', async () => {
    const r = await initiateStk(
      fakeSupabase([{ status: 'REJECTED', message: 'Invalid till' }]),
      { phone: '0712345678', amount: cents(25_000), saleRef: 'X' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('Invalid till');
  });

  it('passes the part-shilling hint through to the cashier', async () => {
    const r = await initiateStk(
      fakeSupabase([{ status: 'REJECTED', message: 'whole shillings only', hint: 'take the rest in cash' }]),
      { phone: '0712345678', amount: cents(25_050), saleRef: 'X' },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.hint).toBe('take the rest in cash');
  });
});

describe('pollStk', () => {
  const initiated = {
    mpesaTxnId: 'M1', providerTxnId: 'NCBA-1',
    providerReference: 'R', accountNo: 'A',
  };

  it('resolves PAID when NCBA reports SUCCESS', async () => {
    vi.useFakeTimers();
    const h = pollStk(fakeSupabase([{ status: 'SUCCESS', recorded: { status: 'VERIFIED' } }]), initiated);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(h.result).resolves.toMatchObject({ kind: 'PAID' });
    vi.useRealTimers();
  });

  it('resolves FAILED when the customer declines', async () => {
    vi.useFakeTimers();
    const h = pollStk(fakeSupabase([{ status: 'FAILED', description: 'Cancelled by user' }]), initiated);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(h.result).resolves.toMatchObject({ kind: 'FAILED' });
    vi.useRealTimers();
  });

  it('keeps polling while the answer is still pending', async () => {
    vi.useFakeTimers();
    const sb = fakeSupabase([{ status: 'PENDING' }]);
    const h = pollStk(sb, initiated);
    await vi.advanceTimersByTimeAsync(13_000);   // ~3 intervals
    const invoke = (sb.functions.invoke as ReturnType<typeof vi.fn>);
    expect(invoke.mock.calls.length).toBeGreaterThanOrEqual(3);
    h.cancel();
    vi.useRealTimers();
  });

  it('gives up rather than polling forever', async () => {
    vi.useFakeTimers();
    const h = pollStk(fakeSupabase([{ status: 'PENDING' }]), initiated);
    await vi.advanceTimersByTimeAsync(130_000);
    await expect(h.result).resolves.toMatchObject({ kind: 'TIMEOUT' });
    vi.useRealTimers();
  });

  it('does NOT treat a poll error as a failed payment', async () => {
    // Deciding "failed" on our own guess is how money goes missing: the
    // customer may have paid while our request was timing out.
    vi.useFakeTimers();
    const sb = {
      functions: { invoke: vi.fn(async () => ({ data: null, error: { message: 'network' } })) },
    } as unknown as SupabaseClient;
    const h = pollStk(sb, initiated);
    await vi.advanceTimersByTimeAsync(20_000);
    let settled = false;
    void h.result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);   // still trying, not resolved as FAILED
    h.cancel();
    vi.useRealTimers();
  });
});

describe('abandonStk', () => {
  it('reports ALREADY_VERIFIED so the till keeps the payment', async () => {
    // The customer paid a moment after the cashier gave up. The money moved,
    // so the sale must still record it.
    const r = await abandonStk(fakeSupabase([{ status: 'ALREADY_VERIFIED' }]), 'NCBA-1');
    expect(r).toBe('ALREADY_VERIFIED');
  });

  it('cancels a prompt that was never answered', async () => {
    expect(await abandonStk(fakeSupabase([{ status: 'CANCELLED' }]), 'NCBA-1')).toBe('CANCELLED');
  });
});

describe('secondsRemaining', () => {
  it('counts down and never goes negative', () => {
    expect(secondsRemaining(0)).toBe(120);
    expect(secondsRemaining(60_000)).toBe(60);
    expect(secondsRemaining(999_000)).toBe(0);
  });
});
