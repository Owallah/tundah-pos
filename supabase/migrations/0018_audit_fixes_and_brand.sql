-- ============================================================================
-- 0018_audit_fixes_and_brand.sql
--
-- Re-asserts the pgcrypto fixes lost when 0001/0005/0007 were reverted,
-- fixes two reporting bugs, and updates the business identity.
--
-- Idempotent: safe on the existing database, correct on a fresh one.
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- Guard — fail loudly rather than shipping a broken database
-- ═══════════════════════════════════════════════════════════════════════════
do $guard$
declare v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('uuid_generate_v7','verify_cashier_pin',
                       'set_cashier_pin','etims_write_invoice')
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
        where c like 'search_path=%extensions%');

  if v_bad is not null then
    raise exception
      'Missing an extensions search_path: %. Migrations 0013/0014 did not '
      'apply. See AUDIT-REVIEW.md section C2.', v_bad;
  end if;
end
$guard$;

-- ═══════════════════════════════════════════════════════════════════════════
-- O1 — COGS was double-counted per line
--
-- A price-overridden or separately discounted line is its own sale_items row,
-- so one sale can hold two rows for the same product. The old cost CTE
-- collapsed to one row per (sale, product); the join then attached that full
-- cost to BOTH rows and sum() counted it twice.
--
-- Fix: aggregate lines to one row per (sale, product) BEFORE joining cost.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function report_by_product(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns table (
  product_id uuid, sku text, name text, category text,
  qty numeric, revenue_cents bigint, vat_cents bigint,
  cogs_cents bigint, margin_cents bigint, margin_pct numeric,
  share_pct numeric
)
language sql stable security definer set search_path = public
as $fn$
  with scope as (
    select s.sale_id from sales s
     where s.business_id = auth_business_id()
       and s.status = 'COMPLETED'
       and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
       and (p_event_id is null or s.event_id = p_event_id)
  ),
  lines as (
    select si.sale_id, si.product_id,
           max(si.product_name) as product_name,
           sum(si.qty) as qty,
           sum(si.line_total_cents - si.tax_amount_cents)::bigint as revenue,
           sum(si.tax_amount_cents)::bigint as vat
      from sale_items si
      join scope sc on sc.sale_id = si.sale_id
     group by si.sale_id, si.product_id
  ),
  cost as (
    select m.sale_id, m.product_id,
           sum(abs(m.qty_delta) * m.unit_cost_cents)::bigint as cogs
      from stock_movements m
      join scope sc on sc.sale_id = m.sale_id
     where m.movement_type = 'SALE'
     group by m.sale_id, m.product_id
  ),
  agg as (
    select l.product_id,
           max(l.product_name) as name,
           sum(l.qty) as qty,
           sum(l.revenue)::bigint as revenue,
           sum(l.vat)::bigint as vat,
           coalesce(sum(c.cogs), 0)::bigint as cogs
      from lines l
      left join cost c
        on c.sale_id = l.sale_id and c.product_id = l.product_id
     group by l.product_id
  )
  select
    a.product_id, p.sku, a.name, cat.name,
    a.qty, a.revenue, a.vat, a.cogs,
    (a.revenue - a.cogs)::bigint,
    case when a.revenue = 0 then 0
         else round((a.revenue - a.cogs) * 100.0 / a.revenue, 1) end,
    case when (select sum(revenue) from agg) = 0 then 0
         else round(a.revenue * 100.0 / (select sum(revenue) from agg), 1) end
  from agg a
  left join products p     on p.product_id = a.product_id
  left join categories cat on cat.category_id = p.category_id
  order by a.revenue desc
$fn$;

create or replace function report_by_category(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns table (
  category text, qty numeric, revenue_cents bigint,
  cogs_cents bigint, margin_cents bigint, margin_pct numeric
)
language sql stable security definer set search_path = public
as $fn$
  with scope as (
    select s.sale_id from sales s
     where s.business_id = auth_business_id()
       and s.status = 'COMPLETED'
       and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
       and (p_event_id is null or s.event_id = p_event_id)
  ),
  lines as (
    select si.sale_id, si.product_id,
           sum(si.qty) as qty,
           sum(si.line_total_cents - si.tax_amount_cents)::bigint as revenue
      from sale_items si
      join scope sc on sc.sale_id = si.sale_id
     group by si.sale_id, si.product_id
  ),
  cost as (
    select m.sale_id, m.product_id,
           sum(abs(m.qty_delta) * m.unit_cost_cents)::bigint as cogs
      from stock_movements m
      join scope sc on sc.sale_id = m.sale_id
     where m.movement_type = 'SALE'
     group by m.sale_id, m.product_id
  )
  select
    coalesce(cat.name, 'Uncategorised'),
    sum(l.qty),
    sum(l.revenue)::bigint,
    coalesce(sum(c.cogs), 0)::bigint,
    (sum(l.revenue) - coalesce(sum(c.cogs), 0))::bigint,
    case when sum(l.revenue) = 0 then 0
         else round((sum(l.revenue) - coalesce(sum(c.cogs), 0))
                    * 100.0 / sum(l.revenue), 1) end
  from lines l
  left join cost c on c.sale_id = l.sale_id and c.product_id = l.product_id
  left join products p     on p.product_id = l.product_id
  left join categories cat on cat.category_id = p.category_id
  group by coalesce(cat.name, 'Uncategorised')
  order by 3 desc
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- O2 — report_by_hour re-scanned sales for every output row
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function report_by_hour(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns table (hour int, sales_count bigint, gross_cents bigint, items numeric)
language sql stable security definer set search_path = public
as $fn$
  with scope as (
    select s.sale_id, s.total_cents,
           extract(hour from coalesce(s.completed_at, s.occurred_at))::int as hr
      from sales s
     where s.business_id = auth_business_id()
       and s.status = 'COMPLETED'
       and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
       and (p_event_id is null or s.event_id = p_event_id)
  ),
  per_hour_items as (
    select sc.hr, sum(si.qty) as qty
      from sale_items si
      join scope sc on sc.sale_id = si.sale_id
     group by sc.hr
  )
  select sc.hr, count(*), coalesce(sum(sc.total_cents), 0)::bigint,
         coalesce(max(i.qty), 0)
    from scope sc
    left join per_hour_items i on i.hr = sc.hr
   group by sc.hr
   order by sc.hr
$fn$;

-- ═══════════════════════════════════════════════════════════════════════════
-- W3 — list_cashiers ran the same subquery twice per row
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function list_cashiers()
returns table (
  cashier_id uuid, full_name text, role text,
  max_discount_bp int, can_void boolean, can_override_price boolean,
  is_active boolean, recent_failures bigint, is_locked boolean,
  sales_today bigint
)
language sql stable security definer set search_path = public
as $fn$
  with fails as (
    select a.cashier_id, count(*) as n
      from pin_attempts a
     where not a.succeeded
       and a.attempted_at > now() - interval '5 minutes'
     group by a.cashier_id
  ),
  today as (
    select s.cashier_id, count(*) as n
      from sales s
     where s.status = 'COMPLETED' and s.completed_at > current_date
     group by s.cashier_id
  )
  select c.cashier_id, c.full_name, c.role::text,
         c.max_discount_bp, c.can_void, c.can_override_price, c.is_active,
         coalesce(f.n, 0), coalesce(f.n, 0) >= 5, coalesce(t.n, 0)
    from cashiers c
    left join fails f on f.cashier_id = c.cashier_id
    left join today t on t.cashier_id = c.cashier_id
   where c.business_id = auth_business_id() and auth_is_staff()
   order by c.is_active desc, c.role, c.full_name
$fn$;

grant execute on function list_cashiers() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- W2 — indexes on the reporting hot path
-- ═══════════════════════════════════════════════════════════════════════════
create index if not exists sale_items_sale_fk on sale_items (sale_id);
create index if not exists payments_sale_fk   on payments (sale_id);
create index if not exists shifts_event_fk    on shifts (event_id);
create index if not exists stock_moves_event_type
  on stock_movements (event_id, movement_type);

-- ═══════════════════════════════════════════════════════════════════════════
-- W1 — state the intent behind the deny-all tables
-- ═══════════════════════════════════════════════════════════════════════════
comment on table pin_attempts is
  'RLS enabled with NO policy, deliberately. Reached only through '
  'verify_cashier_pin() and unlock_cashier(), both SECURITY DEFINER. '
  'A client must never read or write PIN attempt history directly.';

comment on table etims_device_state is
  'RLS enabled with NO policy, deliberately. Holds the KRA cmcKey. '
  'Reached only by the eTIMS worker through the service role.';

-- ═══════════════════════════════════════════════════════════════════════════
-- Brand
-- ═══════════════════════════════════════════════════════════════════════════
-- KRA PIN and branch id are NOT touched here: they come from the eTIMS
-- registration and must match it exactly. Set them with the real values
-- before go-live.
update businesses
   set legal_name   = 'Tundah Taamu Delights',
       trading_name = 'Tundah Taamu Delights'
 where legal_name in ('Nyota Fresh Limited', 'Nyota Fresh Ltd');
