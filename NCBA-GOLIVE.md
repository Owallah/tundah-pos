# NCBA STK Push — go live

Credentials are issued and the bank side is set up. This is the deployment
sequence.

## 1 · Secrets

```bash
supabase secrets set \
  MPESA_PROVIDER=ncba \
  NCBA_USERNAME='<from the signed letter>' \
  NCBA_PASSWORD='<from the signed letter>' \
  NCBA_PAYBILL_NO=880100 \
  NCBA_TILL_CODE='<your till short code, e.g. PAY100D>'
```

Also add `MPESA_PROVIDER=ncba` to Netlify so `/setup` reports it correctly.
Nothing NCBA-related ever gets a `NEXT_PUBLIC_` prefix.

## 2 · Migrations

```bash
npx supabase db push        # 0020 and 0021
```

## 3 · Deploy the function

```bash
supabase functions deploy ncba-stk
supabase functions deploy mpesa-reconcile     # now sweeps NCBA too
```

**`ncba-stk` keeps JWT verification on** — unlike the Daraja webhooks, it is
called by the till, not by a bank. It should reject anonymous callers.

**CORS is handled in the function itself** (`_shared/cors.ts`), not by a
platform setting. If a redeploy ever drops it, the symptom is the till
throwing "Failed to send a request to the Edge Function" the moment a
cashier taps Send prompt — that's a blocked browser preflight, not a broken
NCBA connection. See "Debugging a failed request" below.

## 4 · First real payment

Do this **before** an event, with a real phone and a real KES 1.

- [ ] Open a till, add an item, **Take payment**
- [ ] The panel opens on **Send prompt** — this is now the default
- [ ] Enter a number, send, and watch the countdown
- [ ] Approve on the phone. Within ~4s it should read **Payment received**
- [ ] **Complete** the sale, and check the receipt shows MPESA STK
- [ ] In SQL: `select provider, status, verified_by, account_no, provider_txn_id
      from mpesa_transactions order by initiated_at desc limit 1;`
      Expect `NCBA / VERIFIED / QUERY`, and an `account_no` ending in the
      sale reference

Then the failure paths, which matter more:

- [ ] **Decline the prompt.** Should report FAILED with NCBA's reason, and
      offer Try again / Pay another way
- [ ] **Ignore the prompt for two minutes.** Should time out, not spin forever
- [ ] **Cancel mid-prompt, then approve on the phone anyway.** The till must
      still record the payment — `ncba_abandon` refuses to discard a payment
      NCBA has confirmed. This is the money-losing case; test it deliberately
- [ ] **Close the tab mid-prompt.** Wait five minutes, then check the row is
      resolved — `mpesa-reconcile` sweeps it

## What changed in the till

The tender panel now opens on **Send prompt**. The cashier types the
customer's number and pushes; there is nothing to match afterwards, because
`AccountNo` carries `TILLCODE-TT1-000247`.

Modes, in order:

| Mode | When |
|---|---|
| **Send prompt** | Default. Cashier drives it |
| **Cash** | Notes and coins |
| **Already paid** | Customer paid unprompted — the old C2B match list |
| **Enter code** | Last resort, recorded unverified |

## Two things to brief staff on

**Whole shillings only.** A prompt for KES 250.50 is refused rather than
rounded down, because a rounded prompt leaves the sale short and the shortfall
surfaces at cash-up. Take the shillings by prompt and the rest in cash.

**Cancelling is safe.** If a customer approves a moment after the cashier gave
up, the payment is still recorded. Nobody should panic and re-charge.

## The open gap

NCBA's query returns `{status, description}` — **no M-Pesa receipt number**.
These payments are marked `verified_by = 'QUERY'` and listed by
`ncba_statement_reconciliation()`, because they reconcile against the **NCBA
account statement**, not against a Safaricom code.

Ask NCBA about their **IPN / payment notification push** (question N2 in
NCBA-MPESA.md). If it carries the receipt number, this closes.

## Not wired yet

**Dynamic QR.** The client method is implemented and tested
(`NcbaProvider.generateQr`), but it is not on the tender panel. For a KES 250
smoothie with a queue it is faster than STK — the cashier types nothing and
the customer just scans. Worth adding once STK is proven in the field.

## Debugging a failed request

If the till shows **"Failed to send a request to the Edge Function"** (not a
message from NCBA, not a REJECTED/ERROR status — the request never arrived),
work through these in order:

1. **CORS preflight blocked.** This is the usual cause. The browser sends an
   `OPTIONS` request before the real `POST` because the call carries an
   `Authorization` header and a JSON body. If the function doesn't answer
   `OPTIONS` with `Access-Control-Allow-*` headers, the browser blocks the
   whole exchange and this exact message is what supabase-js shows. Confirm
   `supabase/functions/_shared/cors.ts` exists and `ncba-stk/index.ts`
   calls `handlePreflight()` as the first line inside `Deno.serve`.
2. **Not deployed, or deployed under a different name.**
   `supabase functions list` should show `ncba-stk`. Redeploy with
   `supabase functions deploy ncba-stk` if it's missing or stale.
3. **No internet / DNS.** Check the device is actually online — the same
   message appears for a genuinely offline till.
4. **Wrong project.** Confirm `NEXT_PUBLIC_SUPABASE_URL` on the deployed app
   points at the same project the function was deployed to.

Open the browser console on the till device — a CORS block logs a distinct
`has been blocked by CORS policy` message there even though the app only
shows the generic "failed to send" text.
