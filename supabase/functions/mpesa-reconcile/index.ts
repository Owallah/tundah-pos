/**
 * mpesa-reconcile — the safety net, run every 5 minutes by pg_cron.
 *
 * A missing STK callback is the single most common Daraja failure. Rather
 * than leave a cashier staring at a spinner, anything still PENDING after
 * two minutes is chased with the Transaction Status query.
 *
 * Chasing stops after an hour: Safaricom expires the request, and beyond
 * that it is a human task on the reconciliation screen rather than something
 * a retry loop can fix.
 */

import { admin } from '../_shared/util.ts';
import { DarajaClient, type DarajaConfig } from '../_shared/daraja.ts';

function config(): DarajaConfig {
  const env = (k: string) => Deno.env.get(k) ?? '';
  return {
    environment: env('MPESA_ENVIRONMENT') === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    consumerKey: env('MPESA_CONSUMER_KEY'),
    consumerSecret: env('MPESA_CONSUMER_SECRET'),
    shortCode: env('MPESA_SHORTCODE'),
    storeNumber: env('MPESA_STORE_NUMBER') || undefined,
    passkey: env('MPESA_PASSKEY'),
    transactionType: (env('MPESA_TRANSACTION_TYPE') || 'CustomerBuyGoodsOnline') as
      DarajaConfig['transactionType'],
    callbackUrl: env('MPESA_CALLBACK_URL'),
    confirmationUrl: env('MPESA_CONFIRMATION_URL'),
    validationUrl: env('MPESA_VALIDATION_URL'),
  };
}

Deno.serve(async () => {
  const db = admin();
  const daraja = new DarajaClient(config());

  const { data: pending, error } = await db.rpc('stk_awaiting_callback', {
    p_older_than_seconds: 120,
  });

  if (error) {
    console.error('could not list pending STK', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 200 });
  }

  const rows = (pending ?? []) as Array<{
    mpesa_txn_id: string; checkout_request_id: string;
  }>;

  let resolved = 0;
  for (const row of rows) {
    try {
      const result = await daraja.stkQuery(row.checkout_request_id);
      const code = Number(result.ResultCode);

      // ResultCode 1032 = cancelled by user; 1037 = timeout, no response.
      // Both are terminal. Anything else non-zero is a failure.
      await db.rpc('record_stk_result', {
        p_checkout_request_id: row.checkout_request_id,
        p_result_code: code,
        p_result_desc: result.ResultDesc ?? 'resolved by status query',
        p_receipt_number: null,
        p_amount_cents: null,
        p_phone: null,
        p_occurred_at: new Date().toISOString(),
        p_raw: result as unknown as Record<string, unknown>,
      });
      resolved++;
    } catch (err) {
      // A query failure is not a payment failure. Leave it PENDING and try
      // again in five minutes rather than marking it failed on our own guess.
      console.error('stk query failed', row.checkout_request_id, String(err));
    }
  }

  return new Response(
    JSON.stringify({ checked: rows.length, resolved }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});
