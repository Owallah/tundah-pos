/**
 * mpesa-c2b-confirm — THE PRIMARY PAYMENT PATH.
 *
 * The customer pays the till number on their own phone. Safaricom posts here
 * within a second or two, and the payment appears on all three tills for a
 * cashier to attach.
 *
 * This URL is registered once via Daraja's Register URL API. It must be a
 * STABLE Supabase Function URL, never a Vercel deployment URL — those change
 * on every deploy and Safaricom whitelisting is slow to update.
 */

import {
  admin, accepted, isSafaricom, sourceIp, logRaw, businessId,
} from '../_shared/util.ts';
import { shillingsToCents } from '../_shared/money.ts';

interface C2BPayload {
  TransID?: string;
  TransTime?: string;
  TransAmount?: string;
  BillRefNumber?: string;
  MSISDN?: string;
  FirstName?: string;
  MiddleName?: string;
  LastName?: string;
}

function parseTransTime(s?: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  // Safaricom sends East Africa Time with no offset. Stamp it explicitly
  // rather than letting the server's timezone decide.
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+03:00`;
}

Deno.serve(async (req) => {
  const db = admin();
  const ip = sourceIp(req);
  let body: C2BPayload = {};

  try {
    body = await req.json();
  } catch {
    await logRaw(db, 'c2b_confirm_unparseable', { ip }, ip);
    return accepted();
  }

  // Raw first, always. If our parsing assumptions are wrong, the evidence
  // still exists.
  await logRaw(db, 'c2b_confirm', body, ip);

  // The origin check is advisory: we record it and continue rather than
  // reject. A stale IP allowlist would silently drop real money, which is a
  // worse failure than accepting a payment we later reconcile. Anomalies are
  // visible in webhook_log.
  const trusted = isSafaricom(req);

  try {
    if (!body.TransID || !body.TransAmount) {
      await logRaw(db, 'c2b_confirm_incomplete', body, ip);
      return accepted();
    }

    const { data, error } = await db.rpc('record_c2b_payment', {
      p_business_id: businessId(),
      p_receipt_number: body.TransID,
      p_amount_cents: shillingsToCents(body.TransAmount),
      p_phone: body.MSISDN ?? null,
      p_payer_name: [body.FirstName, body.MiddleName, body.LastName]
        .filter(Boolean).join(' ').trim() || null,
      p_bill_ref: body.BillRefNumber ?? '',
      p_occurred_at: parseTransTime(body.TransTime),
      p_raw: { ...body, _trusted_source: trusted, _source_ip: ip },
    });

    if (error) throw error;
    console.log('c2b', body.TransID, (data as { status: string })?.status);
  } catch (err) {
    // Never surface a 500. Safaricom retries non-200 responses, which would
    // pile duplicates on top of an already-failing handler. The raw payload
    // is logged, so nothing is lost and it can be replayed.
    console.error('c2b handler failed', err);
    await logRaw(db, 'c2b_confirm_error', { body, error: String(err) }, ip);
  }

  return accepted();
});
