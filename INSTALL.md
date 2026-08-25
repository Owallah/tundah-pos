# Setup milestone — events, products, staff, load-out

17 files. Everything a supervisor needs to stand up an event without SQL.

## 1. Apply the migration

```bash
npx supabase db push
```

Or paste `supabase/migrations/0016_setup_operations.sql` into the SQL Editor.
It adds 11 RPCs and one sequence (`etims_item_cd_seq`).

## 2. Copy the files

```
supabase/migrations/0016_setup_operations.sql   → new
src/components/admin/EventManager.tsx           → new
src/components/admin/ProductManager.tsx         → new
src/components/admin/StaffManager.tsx           → new
src/components/admin/LoadOut.tsx                → new
src/components/admin/AdminShell.tsx             → REPLACES (nav grouping)
src/app/admin/page.tsx                          → REPLACES (new cards + counters)
src/app/admin/events/{page,client}.tsx          → new
src/app/admin/products/{page,client}.tsx        → new
src/app/admin/staff/{page,client}.tsx           → new
src/app/admin/loadout/{page,client}.tsx         → new
src/styles/till.css                             → REPLACES (adds .loadout__bar)
```

No hand edits needed this time.

## 3. Verify

```bash
npm run typecheck
npm test           # 106
npm run dev
```

Then walk it: `/admin/events` → create an event and activate it →
`/admin/products` → check nothing is unclassified → `/admin/staff` → set a
PIN → `/admin/loadout` → send stock to the stall → open a till and sell.

## One behaviour change worth knowing

**Load-out is now double-entry.** Stock leaves BASE and arrives at the EVENT
location in one transaction. The old `demo.sql` only ever wrote the arrival,
so base store stock was fictional and shrinkage could not be computed.

If you seeded with `demo.sql`, your base balances are currently overstated by
whatever was "loaded out". A stock take will correct it, or you can reset the
base location and re-load through this screen.
