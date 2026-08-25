/**
 * mpesa-stk-initiate — the FALLBACK payment path.
 *
 * STK Push is not the default for this business. A KES 250 smoothie with
 * eight people waiting cannot absorb a 30-60 second round trip, so C2B is
 * the primary path (see mpesa-c2b-confirm). This exists for the cases where
 * a customer specifically asks to be prompted.
 *
 * Runs as an Edge Function rather than a Next.js route so the Daraja
 * credentials live in exactly one secret store alongside the callbacks.
 */

import { admin } from '../_shared/util.ts';
import { DarajaClient, normalisePhone, type DarajaConfig } from '../_shared/daraja.ts';
import { cents } from '../_shared/money.ts';

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

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  // The caller's JWT is forwarded so register_stk_request() runs with the
  // till's identity and RLS context, not as the service role.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'unauthenticated' }, 401);

  let body: { phone?: string; amount_cents?: number; sale_id?: string; reference?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid body' }, 400);
  }

  if (!body.phone || !body.amount_cents) {
    return json({ error: 'phone and amount_cents are required' }, 400);
  }

  // Daraja accepts whole shillings only. Reject rather than silently round —
  // a rounded-down push would leave the sale permanently short.
  if (body.amount_cents % 100 !== 0) {
    return json({
      error: 'M-Pesa accepts whole shillings only',
      hint: 'Take the shillings portion by STK and the remainder in cash.',
    }, 400);
  }

  const db = admin();

  try {
    const daraja = new DarajaClient(config());
    const result = await daraja.stkPush({
      phone: normalisePhone(body.phone),
      amount: cents(body.amount_cents),
      accountReference: (body.reference ?? 'SALE').slice(0, 12),
      description: 'Purchase',
    });

    if (result.ResponseCode !== '0') {
      return json({
        status: 'REJECTED',
        message: result.ResponseDescription ?? 'Safaricom rejected the request',
      });
    }

    // Register BEFORE returning, so a callback that arrives immediately has
    // a row to land on.
    const { data: txnId, error } = await db.rpc('register_stk_request', {
      p_checkout_request_id: result.CheckoutRequestID,
      p_merchant_request_id: result.MerchantRequestID,
      p_amount_cents: body.amount_cents,
      p_phone: normalisePhone(body.phone),
      p_sale_id: body.sale_id ?? null,
    });
    if (error) throw error;

    return json({
      status: 'SENT',
      mpesa_txn_id: txnId,
      checkout_request_id: result.CheckoutRequestID,
      customer_message: result.CustomerMessage,
    });
  } catch (err) {
    console.error('stk initiate failed', err);
    return json({ status: 'ERROR', message: String(err) }, 200);
  }
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
