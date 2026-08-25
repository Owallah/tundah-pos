/**
 * pos/submit.ts — the sale submission path.
 *
 * ARCHITECTURE §C.4 / §C.5. This is the code that decides whether a cashier
 * loses money when the hotspot flickers, so it is deliberately explicit about
 * every outcome rather than collapsing them into try/catch.
 *
 * The critical case:
 *   Cashier takes KES 2,000 cash. Taps Complete. Connection drops. Request
 *   times out. Did it commit? The customer has already walked away.
 *
 * Re-ringing double-charges. Abandoning leaves cash in the drawer with no
 * record — indistinguishable from theft at shift close. So neither happens:
 * the payload is stashed BEFORE the call, and an unknown outcome becomes an
 * explicit SALE_IN_DOUBT that a supervisor must resolve.
 */

export type SubmitOutcome =
  | { kind: 'COMPLETED'; saleId: string; localRef: string; totalCents: number;
      changeCents: number; fiscalStatus: string }
  | { kind: 'ALREADY_COMPLETED'; saleId: string; localRef: string; totalCents: number }
  | { kind: 'REJECTED'; code: string; message: string; hint?: string }
  | { kind: 'IN_DOUBT'; saleId: string; amountCents: number; attempts: number };

export interface SubmitDeps {
  /** Calls the complete_sale RPC. */
  rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Durable across refresh, crash, tab close AND machine restart. */
  storage: DoubtStorage;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface DoubtStorage {
  put(saleId: string, record: DoubtRecord): void;
  get(saleId: string): DoubtRecord | null;
  remove(saleId: string): void;
  list(): DoubtRecord[];
}

export interface DoubtRecord {
  saleId: string;
  localRef: string;
  amountCents: number;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  raisedAt: string;
  attempts: number;
}

/**
 * Bounded and short. A cashier with a customer in front of them cannot wait
 * through exponential backoff — after ~11s we stop guessing and escalate to
 * a human. Jittered so three tills reconnecting together don't stampede.
 */
export const RETRY_DELAYS_MS = [1_000, 3_000, 7_000];

/** Errors that mean "the server said no" — retrying will not help. */
const TERMINAL_SQLSTATES = new Set([
  '23514', // check_violation: no open shift, unclassified product, underpaid
  '23503', // foreign_key_violation: unknown product/cashier/event
  '23505', // unique_violation: M-Pesa already matched
  '42501', // insufficient_privilege: needs approval
  '28000', // invalid_authorization: bad device context
]);

interface PgError { code?: string; message?: string; hint?: string; details?: string }

export async function submitSale(
  payload: Record<string, unknown>,
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());

  const saleId = String(payload.sale_id);
  const localRef = String(payload.local_ref);
  const idempotencyKey = String(payload.idempotency_key);
  const amountCents = Number(payload._preview_total_cents ?? 0);

  // 1. Stash BEFORE the first attempt. If the browser dies mid-call, this is
  //    the only evidence the sale ever existed.
  deps.storage.put(saleId, {
    saleId, localRef, amountCents, payload, idempotencyKey,
    raisedAt: now().toISOString(), attempts: 0,
  });

  let attempts = 0;

  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    attempts++;
    try {
      const result = (await deps.rpc('complete_sale', { p_payload: payload })) as {
        status: string; sale_id: string; local_ref: string;
        total_cents: number; change_cents?: number; fiscal_status?: string;
      };

      deps.storage.remove(saleId);

      if (result.status === 'ALREADY_COMPLETED') {
        return {
          kind: 'ALREADY_COMPLETED',
          saleId: result.sale_id,
          localRef: result.local_ref,
          totalCents: result.total_cents,
        };
      }

      return {
        kind: 'COMPLETED',
        saleId: result.sale_id,
        localRef: result.local_ref,
        totalCents: result.total_cents,
        changeCents: result.change_cents ?? 0,
        fiscalStatus: result.fiscal_status ?? 'PENDING',
      };
    } catch (err) {
      const pg = err as PgError;

      // 2. A definite rejection. The sale did NOT commit; nothing is in doubt.
      if (pg.code && TERMINAL_SQLSTATES.has(pg.code)) {
        deps.storage.remove(saleId);
        return {
          kind: 'REJECTED',
          code: pg.code,
          message: humanise(pg),
          hint: pg.hint,
        };
      }

      // 3. Ambiguous. Retry with the SAME idempotency key.
      deps.storage.put(saleId, {
        saleId, localRef, amountCents, payload, idempotencyKey,
        raisedAt: now().toISOString(), attempts,
      });

      if (i < RETRY_DELAYS_MS.length) {
        const base = RETRY_DELAYS_MS[i];
        await sleep(base + Math.floor(Math.random() * base * 0.2));
      }
    }
  }

  // 4. Still unknown after every attempt. Escalate — never re-ring, never drop.
  return { kind: 'IN_DOUBT', saleId, amountCents, attempts };
}

/**
 * Resolve a doubtful sale on reconnect. Because the payload is idempotent,
 * exactly one of two things is true: it committed, or it did not. Either way
 * the outcome is exactly one sale.
 */
export async function resolveDoubtfulSale(
  record: DoubtRecord,
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  try {
    const found = (await deps.rpc('resolve_sale', {
      p_sale_id: record.saleId,
      p_idempotency_key: record.idempotencyKey,
    })) as {
      status: string; sale_id?: string; sale_status?: string;
      local_ref?: string; total_cents?: number; fiscal_status?: string;
    };

    if (found.status === 'FOUND' && found.sale_status === 'COMPLETED') {
      deps.storage.remove(record.saleId);
      return {
        kind: 'ALREADY_COMPLETED',
        saleId: found.sale_id!,
        localRef: found.local_ref!,
        totalCents: found.total_cents!,
      };
    }
  } catch {
    // Still unreachable. Leave the record in place and try again later.
    return {
      kind: 'IN_DOUBT',
      saleId: record.saleId,
      amountCents: record.amountCents,
      attempts: record.attempts,
    };
  }

  // Not found: it never committed. Replay it.
  return submitSale(record.payload, deps);
}

// ── localStorage-backed durable store ──────────────────────────────────────
//
// localStorage, NOT sessionStorage. sessionStorage is scoped to the tab and
// is destroyed when the tab or window closes -- which includes a Windows
// Update reboot mid-shift. A doubtful sale that disappears on restart is
// exactly the cash-with-no-record case this whole mechanism exists to
// prevent, so the record must outlive the browser session.
//
// The trade-off is that these records persist until explicitly cleared.
// That is the correct direction to fail: a stale record prompts a supervisor
// to check, whereas a missing one prompts nothing at all.

const DOUBT_PREFIX = 'nyota:doubt:';

export function createBrowserDoubtStorage(): DoubtStorage {
  const store = (): Storage | null =>
    typeof window === 'undefined' ? null : window.localStorage;

  return {
    put(saleId, record) {
      store()?.setItem(DOUBT_PREFIX + saleId, JSON.stringify(record));
    },
    get(saleId) {
      const raw = store()?.getItem(DOUBT_PREFIX + saleId);
      return raw ? (JSON.parse(raw) as DoubtRecord) : null;
    },
    remove(saleId) {
      store()?.removeItem(DOUBT_PREFIX + saleId);
    },
    list() {
      const s = store();
      if (!s) return [];
      const out: DoubtRecord[] = [];
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i);
        if (key?.startsWith(DOUBT_PREFIX)) {
          const raw = s.getItem(key);
          if (raw) out.push(JSON.parse(raw) as DoubtRecord);
        }
      }
      return out.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
    },
  };
}

/** In-memory store for tests and server-side rendering. */
export function createMemoryDoubtStorage(): DoubtStorage {
  const map = new Map<string, DoubtRecord>();
  return {
    put: (id, r) => void map.set(id, r),
    get: (id) => map.get(id) ?? null,
    remove: (id) => void map.delete(id),
    list: () => [...map.values()].sort((a, b) => a.raisedAt.localeCompare(b.raisedAt)),
  };
}

/**
 * Turn a Postgres exception into something a cashier can act on.
 * Errors explain what happened and what to do — they don't apologise.
 */
function humanise(pg: PgError): string {
  const raw = pg.message ?? 'The sale could not be completed.';

  const map: Array<[RegExp, string]> = [
    [/no_open_shift/, 'No shift is open on this till. Open a shift first.'],
    [/product_not_tax_classified: (.+?) \(/,
      'Not yet classified for KRA: $1. It cannot be sold until the accountant sets its tax type.'],
    [/price_override_requires_approval: (.+?) \(/,
      'Changing the price of $1 needs supervisor approval.'],
    [/discount_exceeds_authority/, 'That discount is above this cashier\'s limit. Ask the supervisor.'],
    [/approver_cannot_override_price/, 'That supervisor is not permitted to change prices.'],
    [/mpesa_already_matched/, 'That M-Pesa payment is already attached to another sale.'],
    [/underpaid: expected (\d+), got (\d+)/, 'The payment does not cover the total.'],
    [/insufficient_stock: (.+)/, '$1 is out of stock and set to block sales.'],
    [/unknown_product/, 'One of the items is no longer in the catalogue. Remove it and retry.'],
    [/no_event_location/, 'This event has no stock location. A supervisor must set one up.'],
    [/empty_or_zero_sale/, 'The cart is empty or totals zero.'],
  ];

  for (const [pattern, replacement] of map) {
    if (pattern.test(raw)) return raw.replace(pattern, replacement);
  }
  return raw;
}
