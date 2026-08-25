# NCBA M-Pesa integration

## What I could and could not verify

NCBA publishes that you can <b>collect M-Pesa into an NCBA account via Paybill
880100</b>, with your own short code as the account number, unlimited short
codes, instant credit and transaction alerts. That is confirmed from NCBA's
own site.

**NCBA's API specification is not public.** It is issued under a corporate
agreement. I have therefore not written an implementation of it — a
plausible-looking guess would compile, pass review, and fail against the real
gateway, which is the worst outcome because it looks finished.

## First, establish which model you actually have

### Model A — NCBA collection account *(most likely)*

NCBA gives you a short code under paybill **880100**. Customers pay
`880100` / `<your code>`. Money lands in your NCBA account in real time.

**The API is still Safaricom Daraja.** NCBA is where the money settles, not
who you call. You still need Daraja credentials from Safaricom. The only
changes are configuration:

```
MPESA_PROVIDER=ncba-paybill
NCBA_COLLECTION_SHORTCODE=880100
NCBA_ACCOUNT_CODE=<the code NCBA issues you>
NCBA_ALLOW_ACCOUNT_SUFFIX=false     # until NCBA confirms — see Q3
```

Implemented and ready: `NcbaPaybillProvider` in `src/lib/mpesa/provider.ts`.

### Model B — NCBA hosted payment API

NCBA fronts the STK Push with their own gateway. `NcbaHostedProvider` is a
scaffold that throws with a clear message rather than pretending. Fill it in
from their integration pack.

## Why this change is an upgrade, not just a swap

A **Buy Goods till returns no usable reference** in the C2B callback. That is
the root of the hardest problem in the current build: three tills sharing one
number, with no way to tell which till a payment belongs to. The matcher has
to score candidates on amount and timing, and refuse to guess when two are
plausible.

A **paybill returns `BillRefNumber`.** If NCBA permits a suffix on the account
number, a cashier can say *"pay 880100, account TT1-247"* and the match becomes
**exact**. The ambiguity picker disappears for C2B payments entirely.

That single field is worth more than the rest of this change combined.

## Questions to send NCBA

Send these to your relationship manager. Q3 is the valuable one — ask it first.

| id | Question |
|---|---|
| **Q1** | Do we collect via paybill 880100 with an assigned account code, or do you provide a hosted payment API? |
| **Q2** | If paybill: what is our account code, and is it fixed? |
| **Q3** | **Can the account number carry a free-form suffix**, e.g. `ABC123-TT1-247`? Will a payment with a suffix still credit our account, and will the full string appear in the callback? |
| **Q4** | If hosted: base URLs for sandbox and production |
| **Q5** | If hosted: authentication scheme — OAuth2, API key, mTLS? |
| **Q6** | Do you deliver payment notifications to a webhook, or must we poll? |
| **Q7** | If webhook: what does the payload look like, and how do we verify it is genuinely from NCBA? |
| **Q8** | Do you issue the Safaricom Daraja credentials, or do we obtain them ourselves? |
| **Q9** | Is there a sandbox, and how do we get access? |
| **Q10** | Settlement timing and transaction charges |
| **Q11** | Is the account number validated before the customer's payment completes? (Decides whether a bad suffix fails at the stall) |

## Once you have the answers

**Model A:**
1. Set the environment variables above
2. If Q3 is yes → `NCBA_ALLOW_ACCOUNT_SUFFIX=true`
3. Re-register the C2B URLs against 880100 with Safaricom
4. Test one KES 1 payment end to end before an event

**Model B:**
1. Implement `NcbaHostedProvider` from their pack
2. Keep the same `PaymentProvider` interface — nothing above it changes
3. `MPESA_PROVIDER=ncba-hosted`

## One thing to confirm regardless

**Who issues the Daraja credentials?** If NCBA does, you may not need a
Safaricom developer account at all. If they do not, you need both: Safaricom
for the API and NCBA for the settlement account. Q8 answers it, and it changes
your go-live sequence.
