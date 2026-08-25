# Nyota POS

Cloud-only, 3-till mobile POS for a Kenyan event-based fruit, juice and
smoothie retailer.

**Stack:** Next.js · TypeScript · Supabase (Postgres, Auth, Storage, Realtime,
Edge Functions) · Safaricom Daraja · KRA eTIMS OSCU

**Status:** M1 complete, M2 substantially complete. The app builds and runs:
sign in as a till → open a shift → sell → take payment → receipt.

---

## What's in this milestone

| Area | Delivered |
|---|---|
| **Schema** | 7 migrations: 30+ tables, append-only ledger, immutable fiscal layer |
| **Write path** | `complete_sale()` — one idempotent transaction for an entire sale |
| **Security** | RLS on every table, privilege revokes, column-limited grants, JWT claims hook |
| **Money** | Integer cents throughout, VAT extraction, discount allocation, 23 tests |
| **eTIMS** | Provider interface + `Null`, `Mock`, `OscuHttp` implementations |
| **M-Pesa** | Daraja client (C2B primary, STK fallback) + ambiguity-safe matcher, 16 tests |
| **Workers** | `pg_cron` + `pg_net` — no queue service, no container, no Redis |
| **Seeding** | Idempotent CSV importer that gates on tax classification |
| **Event pricing** | Per-event prices set by supervisor, resolved server-side |
| **Cart engine** | Pure, testable: lines, discounts, split tender, authority |
| **Submission** | Bounded retry, deterministic idempotency, sale-in-doubt recovery |
| **Till screen** | Touch grid, colour-coded categories, blocking network states |
| **Tender** | C2B-first matching, cash denominations, split, manual code |
| **Shifts** | open/close, X and Z reports, void, paper-slip backfill |
| **Receipts** | Provisional/fiscal states, text + HTML + PDF, printer stub |
| **App** | Next.js 15 App Router, Supabase SSR, shift boot, public receipt route |
| **Approvals** | PIN-gated supervisor elevation for discounts, price changes, voids |
| **Shift close** | Blind cash count, Z report, variance explanation |
| **Admin** | Event pricing, paper-slip backfill, payment reconciliation |
| **Edge Functions** | C2B confirm/validate, STK callback/initiate, reconciler, eTIMS worker |
| **Webhook log** | Every callback stored verbatim before parsing |

99 tests passing. Typecheck clean. Production build passes.

### Routes

| Route | Who | What |
|---|---|---|
| `/login` | Anyone | Email + password. A till signs in once and stays in |
| `/till` | Device account | Shift boot → sell → tender → receipt |
| `/admin/pricing` | Supervisor, Owner | Event prices, copy from a previous event |
| `/admin/backfill` | Supervisor, Owner | Enter the paper receipt book after an outage |
| `/admin/reconciliation` | Supervisor, Owner | The six payment buckets (PAY-05) |
| `/r/{token}` | Public | A single receipt. No auth, strict field allowlist |

### Edge Functions

| Function | Trigger | Notes |
|---|---|---|
| `mpesa-c2b-confirm` | Safaricom | **Primary payment path.** Public, no JWT |
| `mpesa-c2b-validate` | Safaricom | Accepts everything by design — see MPESA.md |
| `mpesa-stk-callback` | Safaricom | Lands even if the till dropped mid-payment |
| `mpesa-stk-initiate` | Till | Fallback path. Whole shillings only |
| `mpesa-reconcile` | pg_cron, 5 min | Chases missing STK callbacks |
| `etims-worker` | pg_cron, 1 min | Strictly ordered, single worker, halts on 921/922 |

---

## Quick start

**New here? Follow `DEMO-WALKTHROUGH.md`** — it takes you from `npm test` to
a working till in about 40 minutes, including full Supabase setup.

```bash
npm install
npm run verify              # typecheck + 102 tests + build + secret scan

cp .env.example .env.local  # ETIMS_PROVIDER=null works out of the box

supabase db reset           # applies migrations 0001-0009
npm run seed:catalogue -- --file supabase/seed/catalogue.csv --dry-run
npm run dev                 # http://localhost:3000/till
```

`npm run verify` is the gate to run before every deploy. It includes
`check:secrets`, which greps the built client chunks for the service role key,
Daraja secrets and the eTIMS `cmcKey` — turning a catastrophic leak into a
red build instead of a production incident.

Then in the Supabase dashboard:
**Authentication → Hooks → Customize Access Token (JWT) Claims** →
select `custom_access_token_hook`. **Nothing works without this** — RLS reads
`business_id` from the JWT, and every policy denies access until claims exist.

---

## The five invariants

Everything else is negotiable. These are not.

**1. Stock is a ledger, never a number.**
`stock_movements` is append-only, enforced by `REVOKE UPDATE, DELETE` *and* a
trigger. `stock_balances` is a cache; `rebuild_stock_balances()` recomputes it
from the ledger and must always produce an identical result. A nightly
`pg_cron` job checks for drift.

**2. Money is integer cents.**
`cents()` throws on non-integers, so float drift cannot enter the money path
at all. Conversion to eTIMS' `NUMBER(18,2)` happens at the provider boundary
and nowhere else.

**3. One transaction per sale.**
`complete_sale()` writes header, lines, ledger movements, payments and the
eTIMS enqueue atomically. Either all of it lands or none does. A partial sale
— items with no payment, stock moved for a sale that doesn't exist — is the
worst possible corruption because it looks like real data.

**4. Idempotency keys are deterministic.**
`hash(device_id, op_type, entity_id)`, never random. A retry after an
ambiguous timeout must produce the *same* key or it double-writes. This is
also the primitive the v2 offline engine is built on.

**5. eTIMS never blocks a sale.**
Fiscalisation is queued. A KRA outage — there was a four-day one in July 2026
— delays tax invoices. It must never stop the business taking money.

---

## The two things most likely to bite

### The eTIMS queue is strictly ordered and single-worker

KRA requires `saveTrnsSalesOsdc` → `insertStockIO` → `saveStockMaster`, and
returns error `922` if you break it. `etims_claim_next()` claims exactly **one**
submission in `seq` order.

**Do not raise that limit to drain a backlog faster.** It will corrupt the
submission sequence, and recovering means reconciling with KRA by hand. An
ordering violation sets the queue to `REJECTED` and halts it deliberately —
that state needs a human, not a retry.

### Three tills share one M-Pesa Till number

A C2B confirmation contains no indication of which till the customer is
standing at. Two customers paying KES 250 seconds apart is genuinely
ambiguous, and `matchC2BPayment()` **refuses to guess** — it returns
`ambiguous: true` and the cashier picks from a list showing payer name and
masked phone. The customer is standing right there.

A wrong auto-match charges one customer for another's order. The test
`REFUSES to auto-match two identical amounts` guards this; don't relax it.

---

## Swapping the integrations

Both are plug-and-play by environment variable. Application code never imports
a concrete provider.

```
ETIMS_PROVIDER=null    # ships today. Sales work, receipts are PROVISIONAL
ETIMS_PROVIDER=mock    # deterministic fixtures for CI
ETIMS_PROVIDER=oscu    # live KRA, after certification
```

`NullEtimsProvider` is what makes the schedule work: the POS can run at real
events, taking real money, months before KRA certification completes.

---

## Open questions blocking later milestones

Nothing here blocks M2. All of it blocks eTIMS go-live.

| id | Question | Owner |
|---|---|---|
| **Q7** | Tax classification per menu item | **Accountant — in progress** |
| Q1 | VAT-registered? | Owner |
| Q3 | Buy Goods Till or Paybill? Can we register a C2B Confirmation URL? | Owner + Safaricom |
| **K3** | Is `taxblAmt` gross or net? KRA's own samples disagree | KRA certification |
| K4 | Which `pmtTyCd` for split tender? | KRA certification |
| K5 | Auth in body or headers? | KRA certification |
| K6 | Exact QR payload format — **not documented in spec v2.0** | KRA certification |
| K7 | Must `saveStockMaster` fire per sale or periodically? | KRA certification |

Every one of these is marked in code with its id. `grep -rn "K3\|K4\|K5" src/`
finds them all. None is guessed — where the spec is ambiguous, the behaviour
is configurable and defaults to the most defensible reading.

**K3 is the expensive one.** Getting VAT direction wrong means either every
invoice rejected or systematic misdeclaration. The two conventions differ by
KES 2.88 per KES 105 of sale — small enough to miss, large enough to matter
across an audit period. `money.test.ts` reproduces both KRA samples so the
difference is visible rather than theoretical.

---

## Layout

```
supabase/migrations/
  0001_foundation.sql              extensions, enums, uuidv7, JWT helpers
  0002_identity_and_operations.sql businesses, users, devices, cashiers, events, shifts
  0003_catalogue_and_stock.sql     products, locations, THE LEDGER, balances
  0004_sales_and_fiscal.sql        sales, payments, M-Pesa, invoices, eTIMS queue
  0005_functions.sql               complete_sale, resolve_sale, close_shift, VAT
  0006_rls.sql                     every policy + privilege revokes
  0007_auth_hook_and_workers.sql   JWT claims, queue claim, pg_cron

src/lib/
  money/       integer cents, VAT, discount allocation  (mirrors 0005 SQL exactly)
  etims/       provider interface + null | mock | oscu-http
  mpesa/       Daraja client + C2B matcher

scripts/seed-catalogue.ts          idempotent CSV importer
supabase/seed/catalogue.csv        template; fruit rows deliberately unclassified
```

`money.ts` and the SQL helpers in `0005_functions.sql` implement the same
arithmetic in two places by necessity — the client previews totals, the server
is authoritative. **If you change one, change both.** The test suite asserts
parity against shared fixtures.

---

## Next: M2 — Online POS

Touch-grid till UI (not barcode-first — smoothies have no barcodes), cart,
discounts, cash and split tender, shifts, X/Z reports, digital receipts, the
sale-in-doubt recovery flow, and the supervisor paper-slip backfill screen.

**Gate:** run one real event, cash only, `ETIMS_PROVIDER=null`.
