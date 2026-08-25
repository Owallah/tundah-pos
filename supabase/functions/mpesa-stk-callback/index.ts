/**
 * mpesa-stk-callback — the STK Push result.
 *
 * Worth noting a property of the cloud-only design: this callback lands here
 * regardless of whether the till that started the push is still connected.
 * If the till dropped mid-payment, the money still settles server-side and
 * the till discovers it on reconnect. The customer is never charged into a
 * void.
 */

import { admin, accepted, sourceIp, logRaw } from '../_shared/util.ts';
import { shillingsToCents } from '../_shared/money.ts';

interface StkCallback {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: { Item?: Array<{ Name: string; Value?: string | number }> };
    };
  };
}

function parseTxnDate(v?: string | number): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(v ?? ''));
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`;
}

Deno.serve(async (req) => {
  const db = admin();
  const ip = sourceIp(req);
  let body: StkCallback = {};

  try {
    body = await req.json();
  } catch {
    await logRaw(db, 'stk_callback_unparseable', { ip }, ip);
    return accepted();
  }

  await logRaw(db, 'stk_callback', body, ip);

  try {
    const cb = body.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) {
      await logRaw(db, 'stk_callback_no_checkout_id', body, ip);
      return accepted();
    }

    const items = new Map(
      (cb.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value]),
    );
    const amount = items.get('Amount');

    const { data, error } = await db.rpc('record_stk_result', {
      p_checkout_request_id: cb.CheckoutRequestID,
      p_result_code: cb.ResultCode ?? -1,
      p_result_desc: cb.ResultDesc ?? '',
      p_receipt_number: (items.get('MpesaReceiptNumber') as string) ?? null,
      p_amount_cents: amount !== undefined ? shillingsToCents(amount) : null,
      p_phone: items.get('PhoneNumber') ? String(items.get('PhoneNumber')) : null,
      p_occurred_at: parseTxnDate(items.get('TransactionDate')),
      p_raw: body as unknown as Record<string, unknown>,
    });

    if (error) throw error;
    console.log('stk', cb.CheckoutRequestID, (data as { status: string })?.status);
  } catch (err) {
    console.error('stk callback failed', err);
    await logRaw(db, 'stk_callback_error', { body, error: String(err) }, ip);
  }

  return accepted();
});
