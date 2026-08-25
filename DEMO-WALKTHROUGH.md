# From `npm test` to a working demo

Roughly 40 minutes, most of it waiting for a database to provision.

Every command runs **inside WSL**, from the project folder:

```bash
cd ~/Development/nextjs/nyota-pos
```

---

## Step 1 — Create the Supabase project (5 min)

Go to <https://supabase.com/dashboard> and sign in with GitHub.

**New project**, then:

| Field | Value |
|---|---|
| Name | `nyota-pos` |
| Database password | Generate one and **save it now** — you need it in Step 3 and it is not shown again |
| Region | Closest available to Nairobi. Check the dropdown: usually **Frankfurt (eu-central-1)** or **Mumbai (ap-south-1)** |
| Plan | **Free** is correct for the demo |

Provisioning takes 2–3 minutes.

> For a real event you must move to **Pro**. Free pauses a project after 7
> days of inactivity, which for an event business means arriving at a stall to
> a dead database, and it has no daily backups. Free is fine for a demo today.

### Grab your project ref

From the dashboard URL:

```
https://supabase.com/dashboard/project/abcdefghijklmnop
                                        ^^^^^^^^^^^^^^^^ this is the ref
```

---

## Step 2 — Enable two extensions BEFORE pushing migrations

This is the step most likely to bite you. The migrations use `pg_cron` for
scheduled workers and `pg_net` to call Edge Functions. If they are not enabled
first, `db push` fails partway through and leaves a half-applied schema.

**Database → Extensions**, search and enable:

- [ ] **`pg_cron`**
- [ ] **`pg_net`**

Toggle each one on and wait for the green confirmation.

---

## Step 3 — Push the schema (5 min)

Install the CLI as a project dependency. **Do not install it globally** —
Supabase does not support global npm installs and it misbehaves.

```bash
npm i -D supabase
npx supabase --version
```

Log in (opens a browser, then paste the token back):

```bash
npx supabase login
```

Link and push:

```bash
npx supabase link --project-ref YOUR_PROJECT_REF
# prompts for the database password from Step 1

npx supabase db push
```

You should see all eleven migrations applied, `0001` through `0011`.

<details>
<summary><b>If db push fails on <code>cron.schedule</code></b></summary>

Means `pg_cron` was not enabled in Step 2. Enable it, then re-run
`npx supabase db push`.

If it still fails, the demo does not need the scheduled workers — nothing is
being submitted to KRA and there are no M-Pesa callbacks to chase. Comment out
the three `select cron.schedule(...)` blocks at the bottom of
`0007_auth_hook_and_workers.sql` and the one in `0011_webhook_log.sql`, push
again, and restore them before go-live.

</details>

### Confirm it worked

**SQL Editor → New query:**

```sql
select count(*) as tables
from information_schema.tables
where table_schema = 'public';
```

Expect around **30**.

---

## Step 4 — Create the auth users (5 min)

**Authentication → Users → Add user → Create new user.**

Create four. **Tick "Auto Confirm User"** on each, or they cannot sign in.

| Email | Password |
|---|---|
| `till01@nyota.local` | `demo-till-01` |
| `till02@nyota.local` | `demo-till-02` |
| `till03@nyota.local` | `demo-till-03` |
| `owner@nyota.local` | `demo-owner` |

> These are throwaway demo passwords. Real deployments get real ones.

---

## Step 5 — Seed the demo data (3 min)

Open `supabase/seed/demo.sql` from the repo, copy the **whole file**, paste it
into **SQL Editor → New query**, and run it.

That creates the business, three tills, four cashiers, an active event, a
stock location, thirteen products, event pricing overrides, stock load-out and
two event costs.

Now link the auth users to the records. **New query:**

```sql
select link_till('till01@tunda.tamu', 'TILL-01');
select link_till('till02@tunda.tamu', 'TILL-02');
select link_till('till03@tunda.tamu', 'TILL-03');
select link_staff('owner@tunda.tamu', 'Owner', 'OWNER');
select link_staff('mikesonowallah@gmail.com', 'Owner', 'OWNER');
```

Each should return `Linked …`. If you get *"No auth user"*, the email in
Step 4 does not match exactly.

### Verify

```sql
select code, auth_user_id from devices;
```

**All three `auth_user_id` values must be non-null.** If any is null, the
till will refuse to open a shift.

---

## Step 6 — Enable the JWT hook (2 min) — DO NOT SKIP

Every RLS policy reads `business_id` from the JWT. Until this hook is on,
every query returns zero rows and the app looks broken rather than
unconfigured. This is the single most common setup mistake.

**Authentication → Hooks** (may be labelled *Auth Hooks*):

1. Find **Customize Access Token (JWT) Claims**
2. Enable it
3. Type: **Postgres function**
4. Schema `public`, function **`custom_access_token_hook`**
5. Save

---

## Step 7 — Environment variables (3 min)

**Project Settings → API Keys.**

Depending on how recently your dashboard updated, you will see either the
legacy naming (`anon` / `service_role`) or the newer one
(`publishable` / `secret`). They map like this:

| Dashboard says | Goes into |
|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` |
| `anon` **or** `publishable` | `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `service_role` **or** `secret` | `SUPABASE_SERVICE_ROLE_KEY` |

Create `.env.local` in the project root:

```bash
cat > .env.local << 'EOF'
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
BUSINESS_ID=00000000-0000-4000-8000-000000000001
ETIMS_PROVIDER=null
EOF
```

⚠️ `SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy. It must never get a
`NEXT_PUBLIC_` prefix. `npm run check:secrets` scans the built bundle for
exactly this mistake.

---

## Step 8 — Run it

```bash
npm run dev
```

Open **<http://localhost:3000/till>**. You will be redirected to `/login`.

Sign in as `till01@nyota.local` / `demo-till-01`.

You should land on the **Start shift** screen showing `TILL-01`.

<details>
<summary><b>If you see "Setup incomplete"</b></summary>
The JWT hook (Step 6) is not enabled, or you signed in before enabling it.
Enable it, sign out, sign back in — claims are baked into the token at
sign-in, so an old token will not have them.
</details>

<details>
<summary><b>If you see "Not a till account"</b></summary>
The `link_till` calls in Step 5 did not run, or the emails do not match.
Re-check with <code>select code, auth_user_id from devices;</code>
</details>

<details>
<summary><b>If the product grid is empty</b></summary>
Either <code>demo.sql</code> did not run, or no event is ACTIVE. Check:
<code>select name, status from events;</code>
</details>

---

## Step 9 — The demo, in order

### Sell something (2 min)

1. Pick **Achieng**, PIN `100100`, opening float `2000`, **Open shift**.
2. Tap **Mango L** three times → one line, quantity 3. Repeat taps merge
   rather than stacking rows.
3. Tap **Mango** (whole fruit) twice.
4. Look at the totals: VAT shows only for the smoothie. Whole fruit is
   zero-rated, so the cart is handling mixed tax bands — the thing that makes
   your catalogue awkward, handled.
5. **Take payment → Cash → 1000 → Complete.**
6. Receipt appears with change due. **Download PDF** — it is generated in the
   browser, 80mm wide, and marked **PROVISIONAL** because KRA has not signed
   it. Nothing fabricates a tax signature.

### Watch three tills fight over stock (5 min)

1. Open two more browser profiles (Edge: profile switcher → Browse as Guest,
   or Chrome incognito windows).
2. Sign in as `till02@` and `till03@`, open shifts as Brian and Fatuma.
3. Sell **Mango L** from all three within a few seconds.
4. Back on TILL-01, the tile's stock count reflects all three. That is the
   row-lock decrement plus Realtime broadcast working.

### Supervisor approval (2 min)

1. Tap a cart line name → **Discount → 20%**.
2. Blocked: 20% is above Achieng's 10% limit.
3. The approval modal offers only **Mwangi**, because he is the only one with
   authority. PIN `999111`.
4. Try **Change price** instead — that always needs a supervisor *and* a
   reason, regardless of amount.

### M-Pesa, without Daraja (5 min)

In a second WSL terminal:

```bash
npx supabase functions serve
```

Third terminal:

```bash
./supabase/seed/simulate-payment.sh 250
```

On the till: add one **Mango L** (KES 280 at event price — use **Mango S**
at 180 or adjust the amount to match), open **Take payment**, and the payment
appears in the M-Pesa list within about three seconds. Tap to attach.

**Now the interesting one.** Run it twice with the same amount:

```bash
./supabase/seed/simulate-payment.sh 250
./supabase/seed/simulate-payment.sh 250 254733999888 PETER
```

The matcher **refuses to auto-match** and asks the cashier to choose, showing
payer name and masked phone. Type `888` into the hint field and it resolves
instantly. That is the three-tills-one-till-number problem, and it is the
M-Pesa behaviour most worth your review.

### The test that actually matters (3 min)

1. Add items. Tap **Take payment**, add cash.
2. **Turn off your Wi-Fi.**
3. Tap **Complete**.
4. After about 11 seconds of bounded retries: **"Sale status unknown"**,
   blocking, telling the cashier not to ring it again.
5. **Close the browser entirely. Reopen it.** The unresolved sale is still
   there — it lives in `localStorage`, so it survives a restart.
6. Turn Wi-Fi back on. It resolves to **exactly one sale**.

This is the path where money disappears in an online-only POS. Worth seeing
with your own eyes before an event rather than after.

### Close the shift (2 min)

**Close shift** in the header. Enter a counted amount — the expected figure
stays hidden until you have committed to a number. That is deliberate: showing
it first turns a count into a copy.

Enter something deliberately wrong and you must explain the variance before
closing.

### The admin screens (3 min)

Sign out, sign in as `owner@nyota.local`:

- **`/admin/pricing`** — event prices, copy-from-previous-event
- **`/admin/reconciliation`** — the six payment buckets
- **`/admin/backfill`** — entering the paper receipt book

---

## Step 10 — Optional: see a tax invoice

To watch a provisional receipt become a fiscal one without touching KRA:

```bash
npx supabase functions serve --env-file .env.local
# in .env.local temporarily: ETIMS_PROVIDER=mock

curl -X POST http://127.0.0.1:54321/functions/v1/etims-worker
```

Then reload a receipt — it now carries a signature, receipt number and
internal data. All fake, all deterministic, and it exercises the real
ordering, retry and halt logic.

**Do not set `ETIMS_PROVIDER=oscu` before certification.** Live traffic
against unresolved items K1–K9 produces rejected invoices and a corrupted
`invcNo` sequence that gets untangled with KRA by hand.

---

## What to look at critically

You are reviewing this to catch design mistakes while they are still cheap:

1. **Does the touch grid match your menu?** Category colours, tile order,
   short names. All data, all changeable in minutes.
2. **Is 10% the right cashier discount limit?** One supervisor covers three
   tills — too low and they become the bottleneck at peak trade.
3. **Does event pricing fit how you actually set prices at a venue?**
4. **Is the blind cash count acceptable to your cashiers?** It is a control,
   and controls are worth explaining rather than imposing.

Anything that feels wrong now is far cheaper to change than after the first
event.
