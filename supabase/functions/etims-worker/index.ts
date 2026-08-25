/**
 * etims-worker — drains the KRA submission queue.
 *
 * ⚠️ SINGLE WORKER, STRICT ORDER. KRA requires sale → stockIO → stockMaster
 * per branch and returns 921/922 if that order is broken. `etims_claim_next`
 * claims exactly ONE submission at a time, in `seq` order.
 *
 * DO NOT parallelise this to drain a backlog faster. A broken submission
 * sequence has to be reconciled with KRA by hand.
 *
 * Invoked every minute by pg_cron (migration 0007). Each invocation drains a
 * bounded batch so it finishes well inside the function timeout; the next
 * tick picks up where it left off.
 */

import { admin } from '../_shared/util.ts';

const MAX_PER_INVOCATION = 20;

interface Submission {
  submission_id: string;
  seq: number;
  kind: 'SALE' | 'CREDIT_NOTE' | 'STOCK_IO' | 'STOCK_MASTER' | 'ITEM' | 'PURCHASE';
  sale_id: string | null;
  movement_id: string | null;
  product_id: string | null;
  attempts: number;
}

Deno.serve(async () => {
  const provider = Deno.env.get('ETIMS_PROVIDER') ?? 'null';
  const businessId = Deno.env.get('BUSINESS_ID');

  if (!businessId) {
    return json({ error: 'BUSINESS_ID not configured' });
  }

  // Not onboarded yet. Sales continue, receipts stay provisional, and the
  // queue is left untouched so nothing is lost when eTIMS is switched on.
  if (provider === 'null') {
    return json({ skipped: true, reason: 'ETIMS_PROVIDER=null' });
  }

  const db = admin();
  let processed = 0;
  let halted = false;

  for (let i = 0; i < MAX_PER_INVOCATION; i++) {
    const { data, error } = await db.rpc('etims_claim_next', {
      p_business_id: businessId,
    });

    if (error) {
      console.error('claim failed', error);
      break;
    }

    const rows = (data ?? []) as Submission[];
    if (rows.length === 0) break;      // queue empty, or halted upstream

    const job = rows[0];

    try {
      const result = await submit(db, job, provider);

      await db.rpc('etims_record_result', {
        p_submission_id: job.submission_id,
        p_result_cd: result.resultCd,
        p_response: result.response,
        p_error: null,
      });

      // An ordering violation means our sequence assumptions are wrong.
      // Stop immediately: pushing more requests makes reconciliation worse.
      if (result.resultCd === '921' || result.resultCd === '922') {
        console.error('ORDERING VIOLATION — queue halted', job.submission_id);
        halted = true;
        break;
      }

      processed++;
    } catch (err) {
      await db.rpc('etims_record_result', {
        p_submission_id: job.submission_id,
        p_result_cd: '894',                  // comms error → retry with backoff
        p_response: null,
        p_error: String(err),
      });
      console.error('submission failed', job.submission_id, String(err));
      break;                                  // back off; next tick retries
    }
  }

  return json({ processed, halted });
});

/**
 * Performs one submission.
 *
 * The real KRA calls live in src/lib/etims/providers/oscu-http.ts. Wiring
 * them here is deliberately gated behind certification: until the open
 * questions K1–K9 are answered, sending live traffic would produce rejected
 * invoices and a corrupted `invcNo` sequence that must be untangled with KRA.
 *
 * `mock` exists so the ordering, retry, halt and idempotency paths can be
 * exercised end to end without touching KRA.
 */
async function submit(
  db: ReturnType<typeof admin>,
  job: Submission,
  provider: string,
): Promise<{ resultCd: string; response: Record<string, unknown> }> {
  if (provider === 'mock') {
    const signature = await mockSignature(job.submission_id);

    if (job.kind === 'SALE' && job.sale_id) {
      const { error } = await db.rpc('etims_write_invoice', {
        p_sale_id: job.sale_id,
        p_cur_rcpt_no: job.seq,
        p_tot_rcpt_no: job.seq,
        p_intrl_data: signature.intrlData,
        p_rcpt_sign: signature.rcptSign,
        p_sdc_date_time: new Date().toISOString(),
        p_pmt_ty_cd: '07',
        p_qr_payload: null,
        p_receipt_payload: await receiptPayload(db, job.sale_id),
      });
      if (error) throw error;
    }

    return { resultCd: '000', response: { mock: true, ...signature } };
  }

  throw new Error(
    `ETIMS_PROVIDER=${provider} is not wired to live KRA endpoints yet. ` +
    `Complete sandbox certification (open items K1-K9), then enable it here. ` +
    `Use ETIMS_PROVIDER=mock to exercise the queue.`,
  );
}

/** Deterministic fake signature so mock runs are reproducible. */
async function mockSignature(seed: string) {
  const bytes = new TextEncoder().encode(seed);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { intrlData: hex.slice(0, 26), rcptSign: hex.slice(26, 42) };
}

/** Immutable snapshot stored on the invoice and served at /r/{token}. */
async function receiptPayload(db: ReturnType<typeof admin>, saleId: string) {
  const { data: sale } = await db
    .from('sales')
    .select('local_ref, subtotal_cents, discount_total_cents, tax_total_cents, total_cents')
    .eq('sale_id', saleId).single();

  const { data: items } = await db
    .from('sale_items')
    .select('line_no, product_name, qty, unit_price_cents, discount_cents, ' +
            'line_total_cents, tax_ty_cd, tax_rate_bp, tax_amount_cents')
    .eq('sale_id', saleId).order('line_no');

  return { sale, items } as unknown as Record<string, unknown>;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
