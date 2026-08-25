import { describe, it, expect, vi } from 'vitest';
import {
  submitSale, resolveDoubtfulSale, createMemoryDoubtStorage,
  RETRY_DELAYS_MS, type SubmitDeps,
} from './submit';

const payload = {
  sale_id: 'sale-1',
  local_ref: 'TILL-01-000247',
  idempotency_key: 'idem-abc',
  _preview_total_cents: 200_000,
  items: [], payments: [],
};

function deps(rpc: SubmitDeps['rpc']): SubmitDeps & { storage: ReturnType<typeof createMemoryDoubtStorage> } {
  const storage = createMemoryDoubtStorage();
  return { rpc, storage, sleep: async () => {}, now: () => new Date('2026-08-15T09:00:00Z') };
}

const ok = {
  status: 'COMPLETED', sale_id: 'sale-1', local_ref: 'TILL-01-000247',
  total_cents: 200_000, change_cents: 0, fiscal_status: 'PENDING',
};

describe('happy path', () => {
  it('completes and clears the doubt record', async () => {
    const d = deps(async () => ok);
    const r = await submitSale(payload, d);
    expect(r.kind).toBe('COMPLETED');
    expect(d.storage.list()).toHaveLength(0);
  });
});

describe('terminal rejections do not retry', () => {
  it.each([
    ['23514', 'no_open_shift'],
    ['42501', 'discount_exceeds_authority: 10.00% > 5.00%'],
    ['23505', 'mpesa_already_matched'],
    ['23503', 'unknown_product: abc'],
  ])('sqlstate %s is returned immediately', async (code, message) => {
    const rpc = vi.fn(async () => { throw { code, message }; });
    const d = deps(rpc);
    const r = await submitSale(payload, d);

    expect(r.kind).toBe('REJECTED');
    expect(rpc).toHaveBeenCalledTimes(1);        // no retry
    expect(d.storage.list()).toHaveLength(0);    // nothing in doubt
  });

  it('translates database errors into cashier-actionable wording', async () => {
    const d = deps(async () => {
      throw { code: '23514', message: 'product_not_tax_classified: Whole Mango (FRU-MAN-EA)' };
    });
    const r = await submitSale(payload, d);
    expect(r.kind).toBe('REJECTED');
    if (r.kind === 'REJECTED') {
      expect(r.message).toMatch(/Not yet classified for KRA: Whole Mango/);
      expect(r.message).not.toMatch(/product_not_tax_classified/);
    }
  });
});

describe('ambiguous failures', () => {
  it('retries network errors and succeeds on a later attempt', async () => {
    let calls = 0;
    const d = deps(async () => {
      calls++;
      if (calls < 3) throw new Error('network timeout');
      return ok;
    });

    const r = await submitSale(payload, d);
    expect(r.kind).toBe('COMPLETED');
    expect(calls).toBe(3);
    expect(d.storage.list()).toHaveLength(0);
  });

  it('reuses the SAME idempotency key on every retry', async () => {
    const seen: string[] = [];
    let calls = 0;
    const d = deps(async (_fn, args) => {
      const p = (args as { p_payload: Record<string, unknown> }).p_payload;
      seen.push(String(p.idempotency_key));
      calls++;
      if (calls < 3) throw new Error('timeout');
      return ok;
    });

    await submitSale(payload, d);
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toBe('idem-abc');
  });

  it('treats a server-side ALREADY_COMPLETED as success, not a duplicate', async () => {
    const d = deps(async () => ({
      status: 'ALREADY_COMPLETED', sale_id: 'sale-1',
      local_ref: 'TILL-01-000247', total_cents: 200_000,
    }));
    const r = await submitSale(payload, d);
    expect(r.kind).toBe('ALREADY_COMPLETED');
  });
});

describe('the money-losing case: total connection loss', () => {
  it('escalates to IN_DOUBT rather than re-ringing or dropping', async () => {
    const rpc = vi.fn(async () => { throw new Error('Failed to fetch'); });
    const d = deps(rpc);

    const r = await submitSale(payload, d);

    expect(r.kind).toBe('IN_DOUBT');
    expect(rpc).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    if (r.kind === 'IN_DOUBT') expect(r.amountCents).toBe(200_000);
  });

  it('leaves a durable record that survives a crash', async () => {
    const d = deps(async () => { throw new Error('Failed to fetch'); });
    await submitSale(payload, d);

    const held = d.storage.list();
    expect(held).toHaveLength(1);
    expect(held[0].amountCents).toBe(200_000);
    expect(held[0].idempotencyKey).toBe('idem-abc');
    // The full payload is retained so the sale can be replayed verbatim.
    expect(held[0].payload).toEqual(payload);
  });

  it('stashes the record BEFORE the first attempt, not after', async () => {
    const storage = createMemoryDoubtStorage();
    let stashedAtCallTime = 0;
    const d: SubmitDeps = {
      storage,
      sleep: async () => {},
      rpc: async () => {
        stashedAtCallTime = storage.list().length;
        throw new Error('boom');
      },
    };
    await submitSale(payload, d);
    // If this is 0, a browser crash mid-call loses the sale entirely.
    expect(stashedAtCallTime).toBe(1);
  });
});

describe('recovery on reconnect', () => {
  it('finds a sale that actually committed and clears the doubt', async () => {
    const d = deps(async () => ({
      status: 'FOUND', sale_id: 'sale-1', sale_status: 'COMPLETED',
      local_ref: 'TILL-01-000247', total_cents: 200_000, fiscal_status: 'PENDING',
    }));

    const record = {
      saleId: 'sale-1', localRef: 'TILL-01-000247', amountCents: 200_000,
      payload, idempotencyKey: 'idem-abc',
      raisedAt: '2026-08-15T09:00:00Z', attempts: 4,
    };
    d.storage.put('sale-1', record);

    const r = await resolveDoubtfulSale(record, d);
    expect(r.kind).toBe('ALREADY_COMPLETED');
    expect(d.storage.list()).toHaveLength(0);
  });

  it('replays a sale that never committed', async () => {
    let call = 0;
    const d = deps(async (fn) => {
      call++;
      if (fn === 'resolve_sale') return { status: 'NOT_FOUND' };
      return ok;
    });

    const record = {
      saleId: 'sale-1', localRef: 'TILL-01-000247', amountCents: 200_000,
      payload, idempotencyKey: 'idem-abc',
      raisedAt: '2026-08-15T09:00:00Z', attempts: 4,
    };

    const r = await resolveDoubtfulSale(record, d);
    expect(r.kind).toBe('COMPLETED');
    expect(call).toBe(2);                     // resolve, then replay
  });

  it('stays IN_DOUBT while still offline — never guesses', async () => {
    const d = deps(async () => { throw new Error('still offline'); });
    const record = {
      saleId: 'sale-1', localRef: 'TILL-01-000247', amountCents: 200_000,
      payload, idempotencyKey: 'idem-abc',
      raisedAt: '2026-08-15T09:00:00Z', attempts: 4,
    };
    d.storage.put('sale-1', record);

    const r = await resolveDoubtfulSale(record, d);
    expect(r.kind).toBe('IN_DOUBT');
    expect(d.storage.list()).toHaveLength(1);  // record survives
  });
});

// ── Storage durability ──────────────────────────────────────────────────────
// A doubtful sale must outlive the browser session. Windows Update reboots
// laptops without asking; if the record is tab-scoped it disappears and the
// cash in the drawer has no matching sale.

import { createBrowserDoubtStorage } from './submit';

describe('browser doubt storage', () => {
  function fakeStorage(): Storage {
    const map = new Map<string, string>();
    return {
      get length() { return map.size; },
      key: (i: number) => [...map.keys()][i] ?? null,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
    } as Storage;
  }

  const record = {
    saleId: 'sale-1', localRef: 'TILL-01-000247', amountCents: 200_000,
    payload: { sale_id: 'sale-1' }, idempotencyKey: 'idem-abc',
    raisedAt: '2026-08-15T09:00:00Z', attempts: 4,
  };

  it('uses localStorage, not sessionStorage', () => {
    const local = fakeStorage();
    const session = fakeStorage();
    vi.stubGlobal('window', { localStorage: local, sessionStorage: session });

    createBrowserDoubtStorage().put('sale-1', record);

    // The whole point: this survives a tab close and a machine restart.
    expect(local.length).toBe(1);
    expect(session.length).toBe(0);

    vi.unstubAllGlobals();
  });

  it('round-trips and lists records', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() });
    const store = createBrowserDoubtStorage();

    store.put('sale-1', record);
    store.put('sale-2', { ...record, saleId: 'sale-2', raisedAt: '2026-08-15T09:05:00Z' });

    expect(store.get('sale-1')?.amountCents).toBe(200_000);
    expect(store.list()).toHaveLength(2);
    expect(store.list()[0].saleId).toBe('sale-1');   // oldest first

    store.remove('sale-1');
    expect(store.list()).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('ignores unrelated keys left by other apps', () => {
    const local = fakeStorage();
    local.setItem('some-other-app', 'not ours');
    vi.stubGlobal('window', { localStorage: local });

    const store = createBrowserDoubtStorage();
    store.put('sale-1', record);

    expect(store.list()).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
