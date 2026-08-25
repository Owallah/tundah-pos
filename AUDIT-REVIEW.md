# Supabase migration audit

Reviewed all 14 migration files (4,673 lines), cross-checked against the
running application and the RPCs it calls.

**Headline: the repo cannot build a working database.** Three migrations are
missing and three files have been reverted to their pre-fix state. Your live
database works because the fixes were applied by hand in the SQL Editor — but
the repo and the database have diverged, and a fresh `db push` produces a
system that fails at login.

---

## 🔴 Critical

### C1. Migrations 0012, 0013 and 0014 are absent

```
0011_webhook_log.sql
        ← 0012, 0013, 0014 missing
0015_operations.sql
```

| Missing | What it fixed |
|---|---|
| `0012_fix_auth_hook.sql` | JWT hook `search_path` + `security definer` |
| `0013_fix_pgcrypto_search_path.sql` | `crypt()` / `gen_salt()` resolution |
| `0014_pgcrypto_sweep.sql` | `uuid_generate_v7()` and all remaining pgcrypto calls |

### C2. The in-place fixes were reverted too

Worse than the missing files — the originals are back to their broken form:

```sql
-- 0001_foundation.sql:23
uuid_bytes := unix_ts_ms || gen_random_bytes(10);        -- unqualified

-- 0005_functions.sql:101
if not found or v.pin_hash <> crypt(p_pin, v.pin_hash)   -- unqualified

-- 0005_functions.sql:132
set pin_hash = crypt(p_pin, gen_salt('bf', 10))          -- unqualified

-- 0007_auth_hook_and_workers.sql:189
v_token := encode(gen_random_bytes(32), 'base64');       -- unqualified
```

And the auth hook has neither guard:

```sql
create or replace function custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable            -- no security definer, no search_path
as $$
```

On Supabase, pgcrypto lives in the `extensions` schema. Every one of these
raises `function ... does not exist` at runtime.

**Effect on a fresh deploy:** login fails at the hook; if you work past that,
PIN entry fails; if you work past that, `uuid_generate_v7()` fails and the
entire write path is dead.

**Fix:** the three missing files are restored in this patch, and the four
in-place reversions are re-applied by `0018`, which is idempotent — safe on
your existing database, and correct on a fresh one.

**Root cause is process, not code.** You have been patching the database
directly. Do that once more for `0018`, then adopt one rule: **every schema
change goes in a migration file, and the database is only ever changed by
running migrations.** Otherwise this recurs, and the next time it may be
mid-event.

---

## 🟠 Correctness

### O1. COGS is double-counted in two reports

`report_by_product` and `report_by_category` (both in `0017`) join line items
to cost like this:

```sql
cost as (
  select m.sale_id, m.product_id, sum(...) as cogs
    from stock_movements m ...
   group by m.sale_id, m.product_id      -- one row per (sale, product)
),
...
from lines l                              -- MANY rows per (sale, product)
left join cost c on c.sale_id = l.sale_id and c.product_id = l.product_id
```

The cart engine deliberately keeps a price-overridden or separately
discounted line as its **own row**, so one sale can hold two `sale_items` rows
for the same product. `cost` collapses to one row; the join then attaches the
full cost to **both** lines and `sum(c.cogs)` counts it twice.

**Effect:** overstated COGS and understated margin, on exactly the sales a
supervisor is most likely to scrutinise. `report_summary` and `event_pnl` are
unaffected — they sum movements directly without the join.

**Fixed in `0018`** by aggregating lines to one row per (sale, product) before
joining.

### O2. `report_by_hour` is quadratic

The `items` column runs a correlated subquery that re-scans `sales` for every
output row, filtered by the same hour expression. At a few hundred sales it is
invisible; across a season it will crawl.

**Fixed in `0018`** with a single grouped join.

---

## 🟡 Worth fixing

### W1. Two tables have RLS enabled and no policy

`pin_attempts` and `etims_device_state` deny all access to `authenticated`.

This is **correct** — both are reached only through `SECURITY DEFINER`
functions, and `etims_device_state` holds the KRA `cmcKey`. But an
unexplained deny-all reads like an oversight to the next person. `0018` adds
comments stating the intent.

### W2. Foreign keys without covering indexes

67 FK columns have no index. Most are harmless (`business_id` on small
tables). Four are on the reporting hot path and will degrade as history
accumulates:

- `sale_items.sale_id` — used by every report
- `payments.sale_id`
- `stock_movements.event_id` + `movement_type`
- `shifts.event_id`

`0018` adds these four. The rest can wait for evidence.

### W3. `list_cashiers` computes the same subquery twice

`recent_failures` and `is_locked` each run the same count. Minor, but it is a
per-row cost on a screen that will be opened daily.

---

## ✅ What is sound

Worth saying, because the fundamentals are the expensive part to get right
and they are right:

- **Append-only enforcement is real.** `REVOKE UPDATE, DELETE` *plus* a
  trigger on `stock_movements`, `invoices` and `audit_logs`. Belt and braces.
- **RLS is on all 33 tables** with tenant isolation via a JWT claim.
- **No `SECURITY DEFINER` function is missing `search_path`** — the class of
  bug that caused C2 has been closed everywhere it was introduced
  deliberately. The reverted files are the exception, and that is a
  version-control problem rather than a design one.
- **Money is `BIGINT` cents throughout.** No `NUMERIC`, no `FLOAT`, anywhere
  in the money path.
- **`complete_sale` resolves prices server-side.** A tampered client cannot
  set its own price.
- **The eTIMS queue enforces KRA's ordering** and halts on 921/922 rather
  than retrying into a corrupted sequence.
- **Idempotency keys are deterministic**, so retries after an ambiguous
  timeout cannot double-write.

---

## Apply in this order

```bash
# 1. restore the missing files (in this patch)
# 2. then:
npx supabase db push
```

`0012`–`0014` are `create or replace` throughout, so they are safe on your
existing database — they will simply re-assert what you already applied by
hand. `0018` is new and fixes O1, O2, W1 and W2.

Then verify:

```sql
select * from test_crypto();     -- 4 rows, all ok = true
select * from test_auth_hook('till01@nyota.local');
```

---

# Addendum — verified against a real PostgreSQL 16 instance

After the first `db push` failed, I installed PostgreSQL locally and ran all
18 migrations end to end, then executed **every RPC against real seeded data**
rather than only creating them. That is how the remaining errors were found in
one pass instead of one deploy at a time.

## Two further bugs, both mine, both fixed

### A1. `event_pnl` referenced a column that had been aliased away

```sql
costs as (
  select coalesce(sum(amount_cents), 0)   -- ← no such column here
  from (select category, sum(amount_cents) as amount   -- it is `amount`
          from event_costs ...) c
)
```

This is the `ERROR: column "amount_cents" does not exist` you hit. Fixed in
`0017`.

### A2. `demo.sql` had unqualified `crypt()` / `gen_salt()`

The seed would fail on a fresh Supabase project for the same
`extensions`-schema reason as everything else. All four calls are now
qualified.

## What now passes

| | |
|---|---|
| Migrations 0001–0018 | 18/18 apply clean on an empty database |
| Objects created | 34 tables, 71 functions |
| Read RPCs executed | 22/22 |
| Mutating RPCs executed | 9/9 |
| `complete_sale` | Real sale committed: KES 710.00, VAT 77.24 |

**The VAT figure is worth noting.** Two smoothies at 280 and three mangoes at
50 gives 710.00, with VAT of 77.24 — charged on the smoothies only, because
the mangoes are zero-rated. That is the mixed-band arithmetic working on the
exact basket the business sells.

## The double-entry fix, proved

```
LOAD_OUT movements by location kind:
  BASE   -5.000        ← new record_load_out()
  EVENT  +1025.000     ← 1020 from the old single-sided seed, +5 from the new
```

The 1020 with no matching BASE decrement is the original bug, visible in the
data. Anything loaded out before this fix left base stock overstated. A stock
take corrects it.

## Caveat on local validation

`pg_cron` and `pg_net` are not installable outside Supabase, so their
`create extension` lines were stubbed for the local run. Everything else is
the unmodified migration. The scheduled jobs in `0007` and `0011` are
therefore syntax-checked but not executed — verify them in the dashboard after
pushing.
