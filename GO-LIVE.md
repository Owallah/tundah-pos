# Go-live checklist

Work through this before the first real event. Order matters — each section
depends on the one above it.

---

## 1. Supabase project

- [ ] Create the project. Choose the region closest to Nairobi.
- [ ] **Supabase Pro, not Free.** Free pauses after 7 days idle, which for an
      event business means arriving at a stall to a dead database. Free also
      has no daily backups, and these are tax records.
- [ ] `supabase db push` — applies migrations 0001–0009.
- [ ] **Authentication → Hooks → Customize Access Token (JWT) Claims →
      `custom_access_token_hook`.** Nothing works without this. Every RLS
      policy reads `business_id` from the JWT, so before you enable it every
      query silently returns zero rows.
- [ ] Confirm `pg_cron` and `pg_net` are enabled (Database → Extensions).
- [ ] Set the worker settings used by the cron jobs in 0007:
      `alter database postgres set app.edge_base_url = 'https://<ref>.supabase.co/functions/v1';`

## 2. Business and staff records

- [ ] Insert the `businesses` row: legal name, KRA PIN, `etims_bhf_id`,
      and **`vat_registered`** (open question Q1).
- [ ] Confirm `prices_include_vat`. Kenyan retail is normally `true`.
      Changing this after go-live changes every price on the menu.
- [ ] Create three Supabase Auth users for the tills, e.g. `till01@…`.
- [ ] Insert `devices` rows (`TILL-01/02/03`) and link each `auth_user_id`.
- [ ] Insert `cashiers`, then set PINs via `set_cashier_pin()` — never by
      writing `pin_hash` directly.
- [ ] Set `max_discount_bp` per cashier. **Suggest 1000 (10%), not 500.**
      One supervisor covers three tills; if routine goodwill needs approval
      they become the bottleneck at the busiest moment.
- [ ] Give the supervisor `can_void` and `can_override_price`.

## 3. Catalogue

- [ ] Accountant completes the tax classification (Q7).
- [ ] `npm run seed:catalogue -- --file supabase/seed/catalogue.csv --dry-run`
- [ ] **Zero products reported as unclassified.** Anything unclassified is
      refused by `complete_sale()` at the database, and discovering that
      mid-queue is the worst possible moment.
- [ ] Re-run without `--dry-run`.

## 4. Event

- [ ] Create the event and set `status = 'ACTIVE'`. Only one may be active.
- [ ] Create a `stock_locations` row with `kind = 'EVENT'` for it. Tills
      cannot sell without one.
- [ ] Record `LOAD_OUT` movements for everything going in the van.
- [ ] `/admin/pricing` — set event prices, or copy from a previous event.

## 5. Deploy

- [ ] `npm run verify` — typecheck, 99 tests, build, secret scan. All green.
- [ ] Deploy to Vercel. **Pro, not Hobby** — Hobby prohibits commercial use
      as a licence term.
- [ ] Set every variable from `.env.example`. Confirm nothing secret carries
      a `NEXT_PUBLIC_` prefix.
- [ ] Keep `ETIMS_PROVIDER=null` for the first event. Sales work, receipts
      print as provisional, nothing queues against KRA.
- [ ] Add a custom domain and confirm HTTPS.

## 6. Dry run — do this before the venue, not at it

- [ ] Sign in each till, open a shift, take a cash sale, view the receipt.
- [ ] Download a PDF receipt. Open it.
- [ ] Sell the same product from all three tills at once. Confirm
      `stock_balances` decrements correctly and Realtime updates the others.
- [ ] Trigger an over-limit discount. Confirm the supervisor modal appears
      and that the approval lands in `audit_logs`.
- [ ] Change a price. Confirm it needs a supervisor **and** a reason.
- [ ] **Pull the network cable mid-sale.** Confirm the sale-in-doubt modal
      appears, then reconnect and confirm it resolves to exactly one sale.
      This is the single most important test in this document.
- [ ] Repeat it, but **restart the machine entirely** before reconnecting.
      The unresolved sale must still be there. If it is not, the browser is
      clearing site data on close — see `WINDOWS-TILL.md`.
- [ ] Close a shift with a deliberate KES 100 variance. Confirm the count is
      blind and that an explanation is required.
- [ ] Enter a paper slip at `/admin/backfill`. Confirm it appears with the
      time written on the slip, not the time entered.

## 7. Hardware and connectivity

- [ ] Three laptops, Chrome or Edge, charged.
- [ ] **Two hotspot phones on different networks** (Safaricom + Airtel).
      Not optional: with no offline mode, a dead hotspot stops all trading.
- [ ] A power bank for each phone. Battery is the likeliest failure.
- [ ] Test failover to the backup hotspot **before** the event, so nobody is
      learning it under pressure.
- [ ] Duplicate receipt book and a pen in the cash box.
- [ ] Install the till as a PWA on each laptop so a cashier cannot navigate
      away by accident.
- [ ] **Work through `WINDOWS-TILL.md` on every machine.** Four Windows
      defaults will break a till mid-event: Wi-Fi adapter power saving, sleep
      on lid close, automatic update restarts, and unmetered hotspot data.

## 8. Staff briefing

- [ ] Where the connection status chip is, and what red means.
- [ ] Red means **stop selling** and tell the supervisor. It does not mean
      keep tapping.
- [ ] "Sale status unknown" means **do not ring it again**. Hand over the
      slip; the supervisor resolves it.
- [ ] After five minutes down, start the paper book. Cash only — an M-Pesa
      code cannot be verified while offline.
- [ ] Write the time on every paper slip.
- [ ] M-Pesa: ask the customer to pay the till number themselves. It appears
      on screen in a second or two. Only type a code manually if it does not.

## 9. After the event

- [ ] Every till closes its shift. No unresolved sales left open.
- [ ] Enter any paper slips at `/admin/backfill`.
- [ ] Reconcile unverified M-Pesa payments.
- [ ] Record `LOAD_BACK` movements for returning stock.
- [ ] Record `WASTAGE` for spoilage — for fresh produce this is normal and
      recurring, not an exception. Untracked, it silently becomes shrinkage.
- [ ] Enter event costs (stall, transport, staff) for the P&L.
- [ ] Export a CSV backup to the owner's Drive. Cheap independent copy.

---

## Not yet live

These are deliberately switched off for the first event, and each one is a
milestone rather than a checkbox.

| | Status |
|---|---|
| **KRA eTIMS** | `ETIMS_PROVIDER=null`. Receipts are provisional. Certification pending — open items K1–K9 |
| **M-Pesa Daraja** | The client library is built; the C2B and STK Edge Functions are M3 |
| **Offline selling** | Deferred to v2 by agreement. The hotspot is a hard dependency until then |

Running the first event on cash only, with provisional receipts, is the
intended path. It exercises the whole transaction engine with real money and
real queue pressure while the integrations are still being certified.
