# NCBA Till STK Push & dynamic QR

Implemented against NCBA Bank PLC's *NCBA Till STK Push & Dynamic QR Code API*
specification (2024). Every endpoint and field name in the code comes from that
document — nothing is guessed.

---

## What NCBA requires from you

Per the specification, before integration works:

- [ ] An **NCBA account** where mobile funds are credited
- [ ] An **active NCBA Till short code via Paybill 880100**
- [ ] **A signed instruction letter to the bank**, which is where you supply
      the **username and secret key** you want issued

That last item is the long pole and is not a technical task. Send the letter
now; the code is ready to receive the credentials.

## Configuration

```
MPESA_PROVIDER=ncba
NCBA_USERNAME=<from the signed letter>
NCBA_PASSWORD=<from the signed letter>
NCBA_PAYBILL_NO=880100
NCBA_TILL_CODE=<your till short code, e.g. PAY100D>
```

Credentials live in Supabase Function secrets, never in `.env.local` with a
`NEXT_PUBLIC_` prefix.

---

## Three ways this differs from Daraja, and what each costs

### 1. There is no callback

The specification contains **no webhook**. The only way to learn an outcome is
to poll `/stk-push/query`.

Everything built for the Daraja C2B confirmation webhook — `mpesa-c2b-confirm`,
the Safaricom IP allowlist, the "payment appears on all three tills" behaviour
— does not apply on this path.

**What replaces it:** the till polls through a server function every ~4 seconds
for up to two minutes, then stops. An expired STK prompt will not resolve, and
further polling only burns requests.

### 2. There is no M-Pesa receipt number — this is the significant one

`/stk-push/query` returns exactly:

```json
{ "status": "SUCCESS", "description": "Success" }
```

No M-Pesa code. No amount. No payer number.

So NCBA can confirm a payment succeeded while we **still cannot record the
Safaricom code an accountant would match against a statement.**

Handled honestly rather than papered over:

- `mpesa_receipt_number` stays **null** for NCBA payments
- NCBA's `TransactionID` and `ReferenceID` are stored instead
- The payment is marked `verified_by = 'QUERY'`
- `ncba_statement_reconciliation()` lists these separately, because they are
  reconciled against the **NCBA account statement**, not against a code

Ask NCBA about their **Instant Payment Notification / IPN push service** —
their website advertises one. If it delivers the Safaricom receipt number, it
closes this gap and is worth having (question **N2**).

### 3. Failures arrive as HTTP 200

Both success and failure return 200. The verdict is in `StatusCode`
(`"1"` = failure on STK, `"2"` = failure on QR) and `TransactionID` is null.
Checking `res.ok` is not enough, and there is a test asserting this.

---

## What this fixes — the three-till problem

A Safaricom Buy Goods till returns no usable reference, which is why the
matcher had to score candidates on amount and timing and **refuse to guess**
when two were plausible.

NCBA gives us **`AccountNo`**. We send:

```
PAY100D-TT1-000247
```

The payment carries the till and the sale. Matching becomes **exact**. The
ambiguity picker stops being needed on this path.

## And QR is genuinely better than STK here

For a KES 250 smoothie with eight people waiting:

| | STK Push | Dynamic QR |
|---|---|---|
| Cashier types | The customer's phone number | Nothing |
| Customer waits for | A prompt to arrive | Nothing — scans immediately |
| Amount | Pre-filled | Pre-filled |
| Reference | `AccountNo` | `till#narration` |
| Round trip | 30–60s | As fast as the customer scans |

The QR endpoint returns a base64 PNG that renders straight onto the tender
screen. `till` accepts `PAY100D#narration`, so the sale reference travels with
the payment exactly as `AccountNo` does on the STK path.

**I would make QR the default and STK the fallback**, which inverts the
current design. STK still matters for a customer who cannot scan.

---

## Questions for NCBA

| id | Question | Why it matters |
|---|---|---|
| **N1** | Is the token endpoint **GET or POST**? The STK section documents GET, the QR section documents POST for the same URL | The client tries GET then falls back to POST, but one of them is wrong |
| **N2** | Do you offer **IPN / payment notification push** that includes the M-Pesa receipt number? | Would close the reconciliation gap in §2 |
| **N3** | Does `Amount` accept **decimals**, or whole shillings only? | We currently refuse part-shillings rather than round down |
| **N4** | What is the **success `StatusCode`** on STK initiate? The sample shows a placeholder; failure is `"1"` | We treat "not 1 and TransactionID present" as success |
| **N5** | Is there a **sandbox**, and how do we get access? | Testing against production with real money is a poor first run |
| **N6** | Are there **rate limits** on `/stk-push/query`? | We poll every ~4s per pending sale |
| **N7** | Maximum length and allowed characters for **`AccountNo`** and the QR **narration**? | Our reference is `TILLCODE-TT1-000247` |
| **N8** | Does `TransactionID` appear on the **account statement**? | Without it, statement reconciliation is manual |

**N2 is the valuable one.** Ask it first — it decides whether M-Pesa
reconciliation is automatic or a monthly statement exercise.

---

## Implementation status

| | |
|---|---|
| `src/lib/mpesa/ncba.ts` | ✅ Client + provider, full spec coverage |
| `src/lib/mpesa/ncba.test.ts` | ✅ 15 tests |
| `supabase/migrations/0020_ncba_payments.sql` | ✅ Applied and tested on Postgres 16 |
| Token caching (18000s, refresh at 90%) | ✅ |
| STK initiate / query | ✅ |
| Dynamic QR | ✅ |
| Polling worker | ⏳ Next — needs N5/N6 answered first |
| Tender panel QR display | ⏳ Next |
