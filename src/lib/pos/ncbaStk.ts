/**
 * pos/ncbaStk.ts — the NCBA STK flow, from the till's point of view.
 *
 * NCBA has no callback, so the till polls. It polls through an Edge Function
 * rather than NCBA directly, because the username and secret key must never
 * reach a browser.
 *
 * ═══ THE SHAPE OF THE PROBLEM ══════════════════════════════════════════════
 *
 * A cashier is standing in front of a customer waiting for a prompt to clear.
 * Three things must be true:
 *
 *   1. Feedback must be fast — poll every 2.5s, not every 30s.
 *   2. It must STOP. An STK prompt expires; polling forever burns requests
 *      and leaves the cashier staring at a spinner.
 *   3. Giving up must not lose money. If the customer paid a moment after the
 *      cashier switched to cash, the payment is still recorded — abandoning
 *      is refused server-side once NCBA has confirmed it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Cents } from '../money/money';

/** Poll cadence. Fast enough to feel live, slow enough not to hammer NCBA. */
export const POLL_INTERVAL_MS = 2_500;

// The very fist check happens much sooner than the normal cadence,
// a customer with their phone unlocked can pay in 1-2 seconds
// and waiting a full 2.5 seconds for the first poll is a poor experience.
export const FIRST_POLL_DELAY_MS = 1_200;

/** An STK prompt expires; past this it is a reconciliation task, not a wait. */
export const POLL_TIMEOUT_MS = 120_000;

export interface StkInitiated {
  mpesaTxnId: string;
  providerTxnId: string;
  providerReference: string | null;
  accountNo: string;
  customerMessage?: string;
}

export type StkOutcome =
  | { kind: 'PAID'; mpesaTxnId: string; providerTxnId: string }
  | { kind: 'FAILED'; reason: string }
  | { kind: 'TIMEOUT'; providerTxnId: string }
  | { kind: 'REJECTED'; reason: string }
  | { kind: 'ERROR'; reason: string };

interface FnResponse {
  status?: string;
  message?: string;
  hint?: string;
  mpesa_txn_id?: string;
  provider_txn_id?: string;
  provider_reference?: string | null;
  account_no?: string;
  customer_message?: string;
  description?: string;
  recorded?: { status?: string; resolved_as?: string };
}

async function callFn(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<FnResponse> {
  const { data, error } = await supabase.functions.invoke('ncba-stk', {
    body: payload,
  });
  if (error) throw new Error(error.message);
  return data as FnResponse;
}

/** Push the prompt. Returns the handle the poll loop needs. */
export async function initiateStk(
  supabase: SupabaseClient,
  params: { phone: string; amount: Cents; saleRef: string },
): Promise<{ ok: true; data: StkInitiated } | { ok: false; reason: string; hint?: string }> {
  try {
    const res = await callFn(supabase, {
      action: 'initiate',
      phone: params.phone,
      amount_cents: params.amount,
      sale_ref: params.saleRef,
    });

    if (res.status !== 'SENT' || !res.provider_txn_id) {
      return {
        ok: false,
        reason: res.message ?? 'NCBA did not accept the request.',
        hint: res.hint,
      };
    }

    return {
      ok: true,
      data: {
        mpesaTxnId: res.mpesa_txn_id!,
        providerTxnId: res.provider_txn_id,
        providerReference: res.provider_reference ?? null,
        accountNo: res.account_no ?? '',
        customerMessage: res.customer_message,
      },
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export interface PollHandle {
  /** Resolves once the payment settles, times out, or is cancelled. */
  result: Promise<StkOutcome>;
  /** Stop polling. Does NOT abandon the payment server-side. */
  cancel: () => void;
}

/**
 * Poll until the payment settles or the prompt expires.
 *
 * `onTick` reports elapsed time so the till can show a countdown rather than
 * an indefinite spinner — a cashier needs to know how long to keep waiting.
 */
export function pollStk(
  supabase: SupabaseClient,
  initiated: StkInitiated,
  onTick?: (elapsedMs: number, attempt: number) => void,
): PollHandle {
  // TEMPORARY — remove once confirmed. If this line never appears in the
  // browser console when a payment starts, the deployed bundle is stale
  // and none of the polling fixes below are actually running yet.
  // console.log('[ncba-stk] pollStk v3 (visibility-resync) active');

  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onVisible: (() => void) | undefined;

  const removeVisibilityListener = () => {
    if (onVisible && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
    }
  };

  const result = new Promise<StkOutcome>((resolve) => {
    const started = Date.now();
    let attempt = 0;

    const finish = (outcome: StkOutcome) => {
      removeVisibilityListener();
      resolve(outcome);
    };

    const tick = async () => {
      if (cancelled) return;

      const elapsed = Date.now() - started;
      if (elapsed >= POLL_TIMEOUT_MS) {
        finish({ kind: 'TIMEOUT', providerTxnId: initiated.providerTxnId });
        return;
      }

      attempt += 1;
      onTick?.(elapsed, attempt);

      try {
        const res = await callFn(supabase, {
          action: 'poll',
          provider_txn_id: initiated.providerTxnId,
        });
        if (cancelled) return;

        const recorded = res.recorded?.status;
        const resolvedAs = res.recorded?.resolved_as;

        // ALREADY_RESOLVED means a terminal state was already recorded on an
        // earlier poll — but "already resolved" is not the same as "paid".
        // It could equally mean an earlier poll already marked this FAILED.
        // Reporting PAID unconditionally here would be a false confirmation.
        if (res.status === 'SUCCESS' || recorded === 'VERIFIED'
            || (recorded === 'ALREADY_RESOLVED' && resolvedAs === 'VERIFIED')) {
          finish({
            kind: 'PAID',
            mpesaTxnId: initiated.mpesaTxnId,
            providerTxnId: initiated.providerTxnId,
          });
          return;
        }

        if (res.status === 'FAILED' || recorded === 'FAILED'
            || (recorded === 'ALREADY_RESOLVED' && resolvedAs === 'FAILED')) {
          finish({
            kind: 'FAILED',
            reason: res.description ?? 'The customer did not complete the payment.',
          });
          return;
        }
      } catch {
        // A failed poll is not a failed payment. Keep trying until timeout —
        // deciding otherwise on our own guess is how money goes missing.
      }

      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    // A backgrounded tab — screen locked, cashier switched apps, the browser
    // deciding to save battery — can silently throttle or fully pause
    // setTimeout. This is standard behaviour on both Android Chrome and iOS
    // Safari, and it is the exact failure shape a live test surfaced: one
    // poll fires, then nothing, forever, with no error anywhere to catch.
    // Re-sync the instant the tab is foregrounded again rather than trusting
    // the timer to have kept running invisibly.
    onVisible = () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    // First poll after one interval: NCBA has nothing to report instantly.
    timer = setTimeout(() => void tick(), FIRST_POLL_DELAY_MS);
  });

  return {
    result,
    cancel: () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      removeVisibilityListener();
    },
  };
}

/**
 * Cashier gave up and is switching to cash.
 *
 * Refused server-side if NCBA has already confirmed the payment — in that
 * case the money moved, and it must be reconciled rather than discarded.
 */
export async function abandonStk(
  supabase: SupabaseClient,
  providerTxnId: string,
  reason = 'cashier switched to another payment method',
): Promise<'CANCELLED' | 'ALREADY_VERIFIED' | 'UNKNOWN'> {
  try {
    const res = await callFn(supabase, {
      action: 'abandon', provider_txn_id: providerTxnId, reason,
    });
    if (res.status === 'ALREADY_VERIFIED') return 'ALREADY_VERIFIED';
    if (res.status === 'CANCELLED') return 'CANCELLED';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

/** Seconds left before the prompt expires, for the countdown. */
export const secondsRemaining = (elapsedMs: number): number =>
  Math.max(0, Math.ceil((POLL_TIMEOUT_MS - elapsedMs) / 1000));