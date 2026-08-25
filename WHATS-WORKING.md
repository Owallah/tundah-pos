# What works today

You are waiting on two external things: the accountant's tax classifications
(Q7) and Safaricom's Go Live approval. Neither blocks you from running the
system end to end.

Here is what you can actually do, in order of setup effort.

---

## Right now, no setup (2 minutes)

```bash
npm install
npm test          # 99 tests
```

That proves the money arithmetic, the cart rules, the retry and recovery
logic, the C2B matcher and the receipt renderers. Two tests in there are worth
opening yourself:

- `money.test.ts` → *"documents that the two conventions genuinely disagree"*.
  It reproduces both of KRA's own contradictory VAT samples and shows the gap
  is KES 2.88 per KES 105 of sale. This is open item K3.
- `submit.test.ts` → *"stashes the record BEFORE the first attempt"*. This is
  the test standing between you and losing a sale when the hotspot flickers.

```bash
npm run seed:catalogue -- --file supabase/seed/catalogue.csv --dry-run
```

Prints the accountant's worklist: 8 of 13 products unclassified. Send them
that output.

---

## After ~30 minutes of Supabase setup — the whole POS

```bash
supabase db push                                   # 11 migrations
psql "$DATABASE_URL" -f supabase/seed/demo.sql     # business, staff, stock
```

Then in the dashboard:

1. **Authentication → Users → Add user** (tick *Auto Confirm*):
   `till01@nyota.local`, `till02@nyota.local`, `till03@nyota.local`,
   `owner@nyota.local`
2. Run the `link_till` / `link_staff` calls at the bottom of `demo.sql`.
3. **Authentication → Hooks → Customize Access Token (JWT) Claims →
   `custom_access_token_hook`.** Do not skip this. Every RLS policy reads
   `business_id` from the JWT; until the hook is on, every query returns zero
   rows and the app looks broken rather than unconfigured.

```bash
npm run dev     # http://localhost:3000/till
```

Sign in as `till01@nyota.local`. Demo PINs: supervisor `999111`, cashiers
`100100` / `200200` / `300300`.

### What you can now do

| | |
|---|---|
| Open a shift | Pick a cashier, enter a PIN, count the opening float |
| Sell | Touch grid, colour-coded by category. Tap to add, tap again to increase |
| Take cash | Kenyan note buttons, split tender, change calculation |
| Get a receipt | On-screen, 80mm layout, PDF download |
| Discount | Within 10% goes straight through; above it summons a supervisor |
| Change a price | Always summons a supervisor, always needs a reason |
| Close a shift | Blind cash count, then the Z report |
| Set event prices | `/admin/pricing` — including copy-from-previous-event |
| Enter paper slips | `/admin/backfill` |
| Reconcile payments | `/admin/reconciliation` |

**Run three browser profiles as three tills** and sell the same product from
all of them. Stock decrements under a row lock and Realtime updates the
others — that is the multi-till behaviour from the architecture doc, working.

### The one test worth doing properly

Add items, tap **Take payment**, then kill your network (turn off Wi-Fi) and
tap **Complete**.

You should see *"Sale status unknown"*, blocking, telling the cashier not to
ring it again. Reconnect and it resolves to exactly one sale. That is the path
where money actually goes missing in an online-only POS, and it is worth
seeing with your own eyes before an event.

---

## Simulating what you are waiting for

### M-Pesa, without Daraja credentials

```bash
supabase functions serve
./supabase/seed/simulate-payment.sh 250
```

This posts the exact payload shape Safaricom sends. Open a till, add a KES 250
item, open the tender panel — the payment appears in the M-Pesa list within a
few seconds. Tap to attach it.

**Run it twice with the same amount.** The matcher refuses to auto-match two
plausible payments and asks the cashier to pick, showing payer name and masked
phone. That is the three-tills-one-till-number problem, and it is the part of
the M-Pesa design most worth reviewing before go-live.

**Run it twice with the same code** (edit `CODE` in the script) and the second
is rejected as a duplicate. Safaricom does retry confirmations.

### eTIMS, without KRA

Set `ETIMS_PROVIDER=mock` on the `etims-worker` function. It produces
deterministic fake signatures, so you can watch a provisional receipt become a
tax invoice, and see the queue enforce KRA's ordering, retry and halt rules —
all without touching KRA.

**Do not set it to `oscu` before certification.** Live traffic against
unresolved open items K1–K9 produces rejected invoices and a corrupted
`invcNo` sequence, and that gets untangled with KRA by hand rather than with
a code fix.

---

## What genuinely does not work yet

| | Why | Unblocked by |
|---|---|---|
| Real M-Pesa money | No Daraja credentials | Safaricom Go Live |
| Real tax invoices | Only KRA can sign; receipts stay provisional | KRA certification (K1–K9) |
| Selling fresh fruit and juice | No tax classification, so `complete_sale` refuses | Accountant (Q7) |
| Selling while offline | Deferred to v2 by agreement | v2 |
| Reports and event P&L | Not built | M5 |

Note the third row. The demo seed gives every product a **placeholder**
classification so you can try the whole system. The real `catalogue.csv` leaves
fresh and cut fruit deliberately blank, and `complete_sale()` rejects any
unclassified product at the database — so an unclassified item cannot quietly
end up on a tax invoice. That gate is doing its job when it refuses.

---

## What I would look at first

1. **Sell something and download the PDF.** The whole loop in 30 seconds.
2. **The offline-mid-sale test above.** The most important behaviour in the
   system.
3. **Two identical simulated payments.** The M-Pesa decision most worth
   your review.
4. **`/admin/pricing`.** Event-specific pricing was your requirement; check
   the shape fits how you actually set prices at a venue.

If anything there feels wrong, it is much cheaper to change now than after
the first event.
