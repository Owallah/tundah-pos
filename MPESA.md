# M-Pesa setup

Sequencing matters here. Registering the C2B URLs is a one-time, hard-to-undo
action, so everything below it depends on getting the URLs right first.

---

## Why C2B, not STK Push

STK Push is the obvious choice and the wrong default for this business.

| | STK Push | C2B |
|---|---|---|
| Cashier does | Types the phone number | Nothing |
| Customer does | Waits, enters PIN | Pays the till as they normally would |
| Time | 30–60 seconds | 1–2 seconds |
| Attribution | Unambiguous (`CheckoutRequestID`) | Ambiguous across three tills |
| Verified | Yes | Yes |

A KES 250 smoothie with eight people waiting cannot absorb a minute. So C2B
is the primary path, STK is the fallback for customers who ask to be
prompted, and a typed code is the last resort.

The cost of C2B is ambiguity: the confirmation tells us money arrived but not
which till the customer is standing at. `matchC2BPayment()` scores candidates
on amount, timing and an optional phone hint, and **refuses to auto-match**
when two are plausible — the cashier picks from a list showing payer name and
masked phone. The customer is right there and can confirm in a second.

---

## 1. Daraja app

- [ ] Create an app at <https://developer.safaricom.co.ke>.
- [ ] Note the Consumer Key and Consumer Secret.
- [ ] Apply for **Go Live** with your Buy Goods Till. This takes days, not
      hours — start it before you need it.
- [ ] Get the Lipa na M-Pesa **passkey** for the shortcode.
- [ ] Confirm whether your Till has a separate **store number**. For Buy
      Goods these often differ, and STK fails confusingly if it is wrong.

## 2. Deploy the functions first

The URLs must exist before you register them. Registration is one-time and
changing it later means going back to Safaricom.

```bash
supabase functions deploy mpesa-c2b-confirm
supabase functions deploy mpesa-c2b-validate
supabase functions deploy mpesa-stk-callback
supabase functions deploy mpesa-stk-initiate
supabase functions deploy mpesa-reconcile
supabase functions deploy etims-worker
```

Set the secrets (these never reach a browser):

```bash
supabase secrets set \
  MPESA_ENVIRONMENT=SANDBOX \
  MPESA_CONSUMER_KEY=... \
  MPESA_CONSUMER_SECRET=... \
  MPESA_SHORTCODE=... \
  MPESA_STORE_NUMBER=... \
  MPESA_PASSKEY=... \
  MPESA_TRANSACTION_TYPE=CustomerBuyGoodsOnline \
  BUSINESS_ID=<uuid> \
  ETIMS_PROVIDER=null
```

**The C2B confirmation function must be public** — Safaricom does not send a
JWT:

```bash
supabase functions deploy mpesa-c2b-confirm --no-verify-jwt
supabase functions deploy mpesa-c2b-validate --no-verify-jwt
supabase functions deploy mpesa-stk-callback --no-verify-jwt
```

This is safe because the handlers only ever *insert* payment records through
a `security definer` RPC, and every payload is logged verbatim first. They
cannot read or modify anything else.

## 3. Register the C2B URLs

One time per environment. Use the **stable Supabase Function URL**, never a
Vercel deployment URL — those change on every deploy and Safaricom
whitelisting is slow to update.

```
Confirmation: https://<ref>.supabase.co/functions/v1/mpesa-c2b-confirm
Validation:   https://<ref>.supabase.co/functions/v1/mpesa-c2b-validate
```

Register with `ResponseType: Completed`. That tells Safaricom to accept the
payment even if our endpoint is unreachable. The alternative rejects the
customer's payment while they are standing at the stall — a worse failure
than a payment we reconcile afterwards.

## 4. Sandbox test

```bash
# Simulate a customer paying the till
curl -X POST https://<ref>.supabase.co/functions/v1/mpesa-c2b-confirm \
  -H 'Content-Type: application/json' \
  -d '{"TransID":"TEST12345X","TransTime":"20260815143005",
       "TransAmount":"250.00","MSISDN":"254712345678",
       "FirstName":"JANE","LastName":"WANJIKU","BillRefNumber":""}'
```

Then check:

- [ ] `select * from webhook_log order by received_at desc limit 1;` — raw
      payload stored.
- [ ] `select * from mpesa_transactions;` — one VERIFIED row, unmatched.
- [ ] Open a till, add an item to a cart, open the tender panel — the payment
      appears in the M-Pesa list.
- [ ] **Send the same payload twice.** The second must be recorded as
      `DUPLICATE` and must not create a second row. Safaricom does retry.

## 5. Go live

- [ ] `MPESA_ENVIRONMENT=PRODUCTION` and swap in production credentials.
- [ ] Re-register the C2B URLs against the production shortcode.
- [ ] Take one real KES 1 payment end to end before the event.
- [ ] Confirm `pg_cron` is running `mpesa-reconcile` every five minutes.

---

## Operating notes

**"The payment didn't come through."** First question: did Safaricom send it?

```sql
select * from find_webhook('SLK7XU9P2Q');
```

If there is no row, the problem is upstream of us. If there is a row but no
`mpesa_transactions` entry, the handler failed and the error is in
`webhook_log` under `c2b_confirm_error` — the payment can be replayed from
the stored payload.

**Webhooks always return HTTP 200**, even when they fail internally. A
non-200 makes Safaricom retry, and retries against an already-broken handler
produce a duplicate storm on top of an outage. Failures are logged and
surface on the reconciliation screen instead.

**STK amounts must be whole shillings.** `mpesa-stk-initiate` rejects
anything with a cents remainder rather than rounding, because a rounded-down
push leaves the sale permanently short. Take the shillings by STK and the
remainder in cash.

**Manual codes are a trust control, not a technical one.** A cashier can type
a plausible code and complete a sale. Detection is after the fact on the
reconciliation screen, which is why anything unverified past 24 hours is
flagged in red against the named cashier. Brief the staff that this is
checked — the deterrent matters more than the detection.

---

## Not yet wired

`etims-worker` runs with `ETIMS_PROVIDER=null` (skips) or `mock` (exercises
the ordering, retry and halt paths with fake signatures). **It is deliberately
not connected to live KRA endpoints.** Until open items K1–K9 are settled at
certification, live traffic would produce rejected invoices and a corrupted
`invcNo` sequence that has to be untangled with KRA by hand.

Use `mock` to prove the queue behaves, then switch to `oscu` after
certification.
