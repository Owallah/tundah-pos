/**
 * ncba-stk — NCBA Till STK Push.
 *
 * One function, three actions, because the NCBA credentials must live in
 * exactly one secret store and splitting them across three deployments only
 * multiplies the places they can leak.
 *
 *   POST { action: "initiate", ... }  → push a prompt to the customer
 *   POST { action: "poll",     ... }  → ask NCBA whether it cleared
 *   POST { action: "abandon",  ... }  → cashier gave up, switch to cash
 *
 * ═══ WHY THE TILL POLLS ════════════════════════════════════════════════════
 *
 * NCBA's specification has no callback. The only way to learn an outcome is
 * to poll /stk-push/query. The till polls through here rather than directly,
 * so the username and secret key never reach a browser.
 *
 * The cashier is standing there watching, so the till polls every ~4s for up
 * to two minutes. Past that an STK prompt has expired and further polling
 * only burns requests — it becomes a reconciliation task instead.
 *
 * `mpesa-reconcile` sweeps anything the till abandoned by closing its tab, so
 * a payment is never left PENDING just because someone navigated away.
 */

import { admin } from "../_shared/util.ts";
import {
  NcbaClient,
  NcbaError,
  type NcbaConfig,
} from "../_shared/ncba-client.ts";
import { cents } from "../_shared/money.ts";
import { handlePreflight, corsJson } from "../_shared/cors.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

function config(): NcbaConfig {
  const env = (k: string) => Deno.env.get(k) ?? "";
  const cfg: NcbaConfig = {
    baseUrl: env("NCBA_API_BASE_URL") || undefined,
    username: env("NCBA_USERNAME"),
    password: env("NCBA_PASSWORD"),
    payBillNo: env("NCBA_PAYBILL_NO") || "880100",
    tillCode: env("NCBA_TILL_CODE"),
  };
  if (!cfg.username || !cfg.password || !cfg.tillCode) {
    throw new Error(
      "NCBA is not configured. Set NCBA_USERNAME, NCBA_PASSWORD and " +
        "NCBA_TILL_CODE as Supabase function secrets.",
    );
  }
  return cfg;
}

const json = corsJson;

/**
 * The caller's JWT is forwarded so register_ncba_stk() runs as the till, with
 * its RLS context. The service role is used only for recording poll results,
 * which the till must not be able to forge.
 */
function asCaller(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth) return null;
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false },
    },
  );
}

Deno.serve(async (req) => {
  // Browser preflight — must be answered before anything else, including
  // the POST-only check below, or the actual request never gets sent.
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const caller = asCaller(req);
  if (!caller) return json({ error: "unauthenticated" }, 401);

  let body: {
    action?: string;
    phone?: string;
    amount_cents?: number;
    sale_ref?: string;
    provider_txn_id?: string;
    reason?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid body" }, 400);
  }

  let client: NcbaClient;
  try {
    client = new NcbaClient(config());
  } catch (err) {
    return json({ status: "ERROR", message: String((err as Error).message) });
  }

  // ── initiate ─────────────────────────────────────────────────────────────
  if (body.action === "initiate") {
    if (!body.phone || !body.amount_cents) {
      return json({ error: "phone and amount_cents are required" }, 400);
    }

    // Refuse rather than round: a rounded-down push leaves the sale short and
    // the shortfall is discovered at cash-up, not at the till.
    if (body.amount_cents % 100 !== 0) {
      return json({
        status: "REJECTED",
        message: "M-Pesa accepts whole shillings only.",
        hint: "Take the shillings by prompt and the remainder in cash.",
      });
    }

    const accountNo = `${Deno.env.get("NCBA_TILL_CODE")}`;

    try {
      const res = await client.stkPush({
        phone: body.phone,
        amountCents: cents(body.amount_cents),
        accountNo,
      });

      // NCBA returns failures as HTTP 200 with TransactionID null.
      if (!res.TransactionID || res.StatusCode === "1") {
        return json({
          status: "REJECTED",
          message: res.StatusDescription || "NCBA rejected the request.",
        });
      }

      // Register BEFORE returning, so a poll that arrives immediately has a
      // row to land on.
      const { data: txnId, error } = await caller.rpc("register_ncba_stk", {
        p_provider_txn_id: res.TransactionID,
        p_provider_reference: res.ReferenceID,
        p_amount_cents: body.amount_cents,
        p_phone: body.phone,
        p_account_no: accountNo,
        p_sale_id: null,
      });
      if (error) throw new Error(error.message);

      return json({
        status: "SENT",
        mpesa_txn_id: txnId,
        provider_txn_id: res.TransactionID,
        provider_reference: res.ReferenceID,
        account_no: accountNo,
        customer_message: res.StatusDescription,
      });
    } catch (err) {
      console.error("ncba initiate failed", err);
      return json({
        status: "ERROR",
        message: err instanceof NcbaError ? err.message : String(err),
      });
    }
  }

  // ── poll ─────────────────────────────────────────────────────────────────
  if (body.action === "poll") {
    if (!body.provider_txn_id) {
      return json({ error: "provider_txn_id is required" }, 400);
    }

    try {
      const res = await client.stkQuery(body.provider_txn_id);
      const status = (res.status ?? "").trim().toUpperCase();

      // Logged unconditionally (not just on failure) so a "stuck" payment
      // can be diagnosed from `supabase functions logs ncba-stk` — this is
      // the only place the exact wording NCBA sends is visible before it
      // gets normalised.
      console.log(
        "ncba poll response",
        body.provider_txn_id,
        JSON.stringify(res),
      );

      // Recorded through the service role: a till must not be able to declare
      // its own payment verified.
      const { data, error } = await admin().rpc("record_ncba_result", {
        p_provider_txn_id: body.provider_txn_id,
        p_status: status,
        p_description: res.description ?? "",
        p_raw: res as unknown as Record<string, unknown>,
      });
      if (error) throw new Error(error.message);

      // TEMPORARY — remove once confirmed. This is the DB's actual decision,
      // separate from the raw NCBA response logged above. If this line never
      // appears, or still shows the old shape, this deployed function is not
      // the one with the status-mirroring fix.
      console.log(
        "ncba-stk v3 decision",
        body.provider_txn_id,
        JSON.stringify(data),
      );

      return json({
        // The DB's decision is authoritative — NOT the raw NCBA word. NCBA
        // can (and does) send status:"FAILED" while the description says
        // the payment is still in progress; record_ncba_result() already
        // resolved that contradiction. Returning the raw word here instead
        // would let the client see "FAILED" and stop polling before the
        // override ever had a chance to matter.
        status: data?.status ?? "PENDING",
        description: res.description,
        recorded: data,
      });
    } catch (err) {
      // A query failure is NOT a payment failure. Report it and leave the
      // row PENDING so the next poll, or the reconciler, can resolve it.
      console.error("ncba poll failed", body.provider_txn_id, String(err));
      return json({
        status: "UNKNOWN",
        message: err instanceof NcbaError ? err.message : String(err),
      });
    }
  }

  // ── abandon ──────────────────────────────────────────────────────────────
  if (body.action === "abandon") {
    if (!body.provider_txn_id) {
      return json({ error: "provider_txn_id is required" }, 400);
    }
    const { data, error } = await caller.rpc("ncba_abandon", {
      p_provider_txn_id: body.provider_txn_id,
      p_reason: body.reason ?? "abandoned at the till",
    });
    if (error) return json({ status: "ERROR", message: error.message });
    return json(data);
  }

  return json({ error: `unknown action: ${body.action}` }, 400);
});
