-- 0028_realtime_publication.sql
--
-- Fixes: "the till does not auto-decrement stock when another till has
-- sold; only a page reload shows it."
--
-- ROOT CAUSE: no migration in this project has ever added ANY table to the
-- `supabase_realtime` publication. `supabase.channel(...).on('postgres_changes',
-- {table: 'x'}, ...)` on the client is necessary but not sufficient — Realtime
-- only streams changes for tables explicitly added to that publication. A
-- table not in it can be subscribed to all day with no error and no events
-- will ever arrive; the subscription looks successful and simply never fires.
--
-- This also means the EXISTING `mpesa-inbox` channel in TillContainer.tsx
-- (subscribed to `mpesa_transactions`, used while the tender panel is open)
-- has had the same latent problem. If it has appeared to work at all, that
-- is because someone flipped the per-table Realtime toggle by hand in the
-- Supabase dashboard on this one project — a change that is invisible to
-- migrations, does not travel with `db push`, and will not exist on a fresh
-- project or after a database reset.
--
-- FIX: enable replication for both tables here, in a migration, so it is
-- reproducible and does not depend on anyone remembering a dashboard step.
--
-- stock_balances' primary key is (product_id, location_id) — both columns
-- are always present on the NEW row of an insert or update regardless of
-- REPLICA IDENTITY, so the default identity is sufficient; FULL is not
-- required here.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'stock_balances'
  ) then
    alter publication supabase_realtime add table stock_balances;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'mpesa_transactions'
  ) then
    alter publication supabase_realtime add table mpesa_transactions;
  end if;
end
$$;
