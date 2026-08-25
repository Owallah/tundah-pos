# System use cases — testing and training

Every function in the system, as a numbered scenario with an expected result.

Two audiences, one document:

- **Testing** — work through it in order, tick each box. Anything that fails
  is a bug to report before go-live.
- **Training** — sections 2 and 3 are the cashier's whole world. A new cashier
  should be able to do those unaided after one pass.

**Demo credentials.** Tills `till01@` / `till02@` / `till03@` with passwords
`demo-till-01` etc. Owner `owner@`. PINs: supervisor Mwangi `999111`, cashiers
Achieng `100100`, Brian `200200`, Fatuma `300300`.

---

# 1 · Setup — the supervisor, before an event

*Owner or supervisor account. Do these in order; each depends on the last.*

### UC-1.1 Create an event
`/admin/events` → **New event** → name, venue, county, dates → tick *Make this
the active event* → **Create**.

✅ Event appears with status **ACTIVE**. No "no stock location" warning — the
location is created automatically.

### UC-1.2 Confirm the catalogue is sellable
`/admin/products`

✅ The header says every active product has a tax type. If any are listed as
unclassified, **they cannot be sold** — that is the accountant's outstanding
work, not a bug.

### UC-1.3 Add a product
**New product** → SKU `TEST-01`, name `Test Item`, category `Other`, price
`100`, cost `40`, tax type **B — Standard 16%** → **Save**.

✅ Appears in the list. ✅ An `itemCd` was generated.

### UC-1.4 Try to sell an unclassified product *(negative test)*
Edit `TEST-01` → set tax type to **Not classified** → Save.

✅ It moves to the top of the list, flagged. Later, in UC-2.2, it must be
untappable on the till. Set it back to B afterwards.

### UC-1.5 Set event pricing
`/admin/pricing` → change one price → **Save**.

✅ Saved. ✅ Try **copy from a previous event** if one exists.

### UC-1.6 Add a cashier
`/admin/staff` → **Add cashier** → name, role Cashier, discount limit `10`,
PIN `456456` → **Save**.

✅ Appears in the list. ✅ The PIN is never displayed anywhere afterwards.

### UC-1.7 Receive stock into the base store
`/admin/receive` → **Add supplier** if none exists → enter quantities and unit
costs → **Confirm receipt**.

✅ "In base" increases by what you entered.
✅ If you entered a new cost, the product's cost price updates — future sales
compute margin against what you actually paid.
✅ Anything at or below its reorder point is listed at the top.

**This is the first step in the whole chain.** Nothing can be loaded out or
sold until stock has been received:

    supplier → BASE STORE → load out → EVENT STALL → sale

### UC-1.8 Load out stock
`/admin/loadout` → enter quantities against several products → **Confirm load
out**.

✅ Confirmation names the number of products and the cost.
✅ "Base" decreases and "At stall" increases — **both**. If only one moves,
that is the double-entry bug and must be reported.

### UC-1.9 Load out more than you have *(warning test)*
Enter a quantity larger than the base figure.

✅ An amber warning appears but the button still works. This is deliberate:
the crate in your hands beats the ledger.

### UC-1.10 Record an event cost
`/admin/pnl` → **Add expense** → Stall, `1500` → **Add expense**.

✅ Appears in the P&L under expenses and reduces profit.

---

# 2 · The sale — a cashier's day

*This is the training core. A cashier needs nothing outside this section.*

### UC-2.1 Open a shift
Sign in as `till01@` → pick **Achieng** → PIN `100100` → float `2000` →
**Open shift**.

✅ Lands on the sale screen. ✅ Header shows TILL-01, Achieng and the event.

### UC-2.2 Sell one item
Tap **Mango L**.

✅ One line in the cart, quantity 1, total updates.
✅ An unclassified product (from UC-1.4) cannot be tapped at all.

### UC-2.3 Repeat taps merge
Tap the same product three more times.

✅ **One line, quantity 4** — not four separate rows.

### UC-2.4 Mixed VAT in one basket
Add a whole mango alongside the smoothie.

✅ The totals show VAT for the smoothie only. Zero-rated fruit adds no VAT.
This is the normal basket and the most important number on the screen.

### UC-2.5 Change a quantity
Tap the **+** and **−** on a line. Take one to zero.

✅ Quantity changes; zero removes the line.

### UC-2.6 Cash payment with change
**Take payment** → **Cash** → **1000** → **Complete**.

✅ Receipt appears. ✅ **Change to give** is shown clearly.
✅ Receipt says **PROVISIONAL — NOT A TAX INVOICE** (correct until eTIMS is
live).

### UC-2.7 Download a receipt
On the receipt → **Download PDF**.

✅ A PDF downloads and opens. ✅ Roughly receipt-width, readable.

### UC-2.8 Exact cash
New sale → **Take payment** → **Exact** → **Complete**.

✅ No change shown.

### UC-2.9 Split payment
Sale of about KES 1,000 → Cash **400** → then M-Pesa or cash **600**.

✅ Balance due drops after the first tender. ✅ **Complete** only enables when
the balance reaches zero.

### UC-2.10 M-Pesa, matched
With `simulate-payment.sh` (or a real payment) → open the tender panel.

✅ The payment appears within a few seconds. ✅ Tapping it attaches it.

### UC-2.11 Two identical payments *(the important one)*
Simulate two payments of the same amount.

✅ The till **refuses to auto-match** and shows both with payer name and
masked phone.
✅ Typing the last 3 digits of the customer's number resolves it instantly.

**Train this explicitly.** A wrong match charges one customer for another's
order.

### UC-2.12 Manual M-Pesa code
**Enter code** → type a 10-character code → **Add**.

✅ Accepted only at 10 characters. ✅ The receipt marks it with `*` and
"payment awaiting verification".

### UC-2.13 Park and recall
Build a cart → **Park sale**. Serve someone else. Then **Parked sales** →
**Recall**.

✅ Parking succeeds with no error. ✅ The cart comes back intact.
✅ Oldest parked sale is at the top.

### UC-2.14 Discount within authority
Tap a line name → **Discount** → **5%**.

✅ Applied immediately, no supervisor needed (limit is 10%).

### UC-2.15 Discount above authority
Tap a line → **Discount** → **20%**.

✅ Blocked, explaining the limit. ✅ The approval screen offers **only**
Mwangi. ✅ PIN `999111` approves it.

### UC-2.16 Change a price
Tap a line → **Change price** → enter a new price.

✅ **Always** needs a supervisor, whatever the amount.
✅ A reason is mandatory.

### UC-2.17 Switch cashier mid-shift
**Switch cashier** → Brian → PIN `200200`.

✅ The header changes to Brian. ✅ The shift and float stay with the till.
✅ Subsequent sales are attributed to Brian.

### UC-2.18 Wrong PIN
Enter a wrong PIN.

✅ Says the PIN is wrong. ✅ After five attempts the cashier is locked, and a
supervisor must unlock at `/admin/staff`.

---

# 3 · When things go wrong

*Train these. They are rare, and that is exactly why nobody improvises well.*

### UC-3.1 Connection lost while browsing
Turn off Wi-Fi and wait ~30 seconds.

✅ The chip turns red. ✅ A blocking panel explains what to do.
✅ Selling is disabled — the till does not pretend.

### UC-3.2 Connection lost mid-sale — **the critical test**
Build a cart → **Take payment** → add cash → **turn off Wi-Fi** →
**Complete**.

✅ After about 11 seconds: **"Sale status unknown"**, blocking, saying **do
not ring this sale again**.

Now **close the browser completely and reopen it**.

✅ The unresolved sale is still there.

Turn Wi-Fi back on.

✅ It resolves to **exactly one sale** — not zero, not two.

**Train this hard.** Re-ringing double-charges; walking away leaves cash with
no record. Both are worse than waiting.

### UC-3.3 Paper fallback
With the connection down for more than five minutes, write sales in the
duplicate book: item, quantity, price, total, **time**, cashier initials.

### UC-3.4 Enter paper slips afterwards
`/admin/backfill` → slip number, **the time written on the slip**, items,
payment → **Save slip**.

✅ Saved. ✅ Entering the same slip number twice does **not** create two sales.
✅ The sale carries the slip reference.

### UC-3.5 Void a sale
`/admin/sales` → **Void** on a recent sale → supervisor + reason.

✅ Marked VOIDED. ✅ Stock returns. ✅ Refused once a tax invoice exists —
then it must be a credit note.

### UC-3.6 Reprint a receipt
`/admin/sales` → **Receipt** on any sale.

✅ Renders. ✅ **Link** opens the public receipt page.

---

# 4 · Closing down

### UC-4.1 Record wastage
`/admin/stock` → **Wastage** → product, quantity, reason → **Record**.

✅ Shows the revenue impact. ✅ Stock decreases.

**Do this daily.** Unrecorded spoilage silently becomes shrinkage, and the
ledger drifts from the shelf within one event.

### UC-4.2 Record samples
Same screen → **Sample / staff**.

✅ Stock decreases without a sale.

### UC-4.3 Close a shift
**Close shift** → count the drawer → enter the total.

✅ The expected figure is **hidden** until you enter a count. This is
deliberate: seeing it first turns a count into a copy.
✅ **Compare** reveals expected, counted and variance.
✅ A non-zero variance requires a written explanation.

### UC-4.4 Load back
`/admin/loadout` → **Load back** → quantities → **Confirm**.

✅ Stall decreases, base increases.

### UC-4.5 Close the event
`/admin/events` → **Close event**.

✅ Refused while any till still has an open shift.
✅ Warns if stock is still recorded at the stall.
✅ Reports takings.

---

# 5 · The owner's view

### UC-5.1 Reports
`/admin/reports` — work every tab: product, category, cashier, hour, payments,
date, VAT, stock value.

✅ Each loads. ✅ Headline figures make sense.
✅ **Revenue is lower than takings** — VAT is excluded, correctly.

### UC-5.2 Export CSV
**Export CSV** on any tab.

✅ Downloads. ✅ Opens cleanly in Excel.
✅ Money reads as `250.00`, **not** `25000`.

### UC-5.3 Print to PDF
**Print / PDF** → Save as PDF.

✅ Navigation is stripped, black on white, rows unbroken across pages.

### UC-5.4 Event P&L
`/admin/pnl`

✅ Reads top to bottom: takings → less VAT → revenue → less COGS → gross
profit → less wastage → less expenses → **profit**.
✅ Stock left at the stall is shown **separately**, below the profit line —
it is inventory, not a loss.

### UC-5.5 Compare events
Same screen, lower table.

✅ Revenue per day is shown — the fair comparison between a two-day and a
five-day event.

### UC-5.6 Payment reconciliation
`/admin/reconciliation`

✅ Six buckets. ✅ Unverified manual codes older than 24 hours are flagged red
against the named cashier.

### UC-5.7 Remote access
Open the admin screens from a phone away from the venue.

✅ Everything loads. ✅ Live shift and takings figures are current.

---

# 6 · Multi-till

### UC-6.1 Three tills at once
Open all three in separate browser profiles, all with shifts open.

✅ Each shows its own till code and cashier.

### UC-6.2 Concurrent sale of one product
Sell the same product from all three within a few seconds.

✅ Stock decrements by the total, not by one. ✅ No till oversells silently.

### UC-6.3 Cross-till visibility
Watch a tile's stock count on till 1 while till 2 sells that product.

✅ Updates within a second or two.

### UC-6.4 One supervisor, three tills
Trigger an over-limit discount on two tills at once.

✅ The same supervisor PIN approves both.

**Note for training:** every approval means the supervisor physically walking
over. If they are approving constantly, the cashier discount limit is set too
low — that is a settings problem, not a discipline problem.

---

# 7 · Security

*Test these once. They should all fail closed.*

### UC-7.1 Cashier cannot reach admin
Sign in as a till account, go to `/admin`.

✅ "Supervisors only".

### UC-7.2 Receipt link exposes nothing sensitive
Open `/r/{token}` in a private window.

✅ Loads without login. ✅ Shows items, prices, VAT, totals.
✅ Shows **no** cost prices, margins, cashier IDs or customer phone numbers.

### UC-7.3 Wrong receipt token
Change a character in the URL.

✅ "Not found". No leak.

### UC-7.4 PIN lockout
Five wrong PINs.

✅ Locked. ✅ Only a supervisor can unlock.

---

## Sign-off

| Section | Cases | Tester | Date | Pass |
|---|---|---|---|---|
| 1 Setup | 10 | | | |
| 2 Sale | 18 | | | |
| 3 Failures | 6 | | | |
| 4 Closing | 5 | | | |
| 5 Owner | 7 | | | |
| 6 Multi-till | 4 | | | |
| 7 Security | 4 | | | |

**54 cases.** If pushed for time, the ones that must not be skipped are
**UC-2.11** (payment ambiguity), **UC-3.2** (sale in doubt), **UC-4.3** (blind
cash count) and **UC-6.2** (concurrent stock). Those are where money goes
missing.
