-- ============================================================================
-- 0017_reports.sql  —  §17 reports and §15 event P&L.
--
-- All aggregation happens here, not in the browser: a report over a season of
-- events is thousands of rows, and shipping them to a laptop on a hotspot to
-- sum them would be slow and expensive.
--
-- Money stays in integer cents throughout. Formatting is the client's job.
--
-- COGS uses `stock_movements.unit_cost_cents`, captured at the moment of
-- sale — NOT the product's current cost price. If a supplier raises prices
-- next month, last month's margin must not move.
-- ============================================================================

-- ── Headline figures ────────────────────────────────────────────────────────
create or replace function report_summary(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns jsonb
language sql stable security definer set search_path = public
as $$
  with scope as (
    select s.* from sales s
     where s.business_id = auth_business_id()
       and s.status = 'COMPLETED'
       and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
       and (p_event_id is null or s.event_id = p_event_id)
  ),
  cogs as (
    select coalesce(sum(abs(m.qty_delta) * m.unit_cost_cents), 0)::bigint as amount
      from stock_movements m
      join scope s on s.sale_id = m.sale_id
     where m.movement_type = 'SALE'
  )
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'sales_count',   (select count(*) from scope),
    -- Gross takings is what went in the drawer; revenue excludes VAT, which
    -- is collected on KRA's behalf and is not income.
    'gross_cents',   (select coalesce(sum(total_cents), 0) from scope),
    'revenue_cents', (select coalesce(sum(subtotal_cents), 0) from scope),
    'vat_cents',     (select coalesce(sum(tax_total_cents), 0) from scope),
    'discount_cents',(select coalesce(sum(discount_total_cents), 0) from scope),
    'cogs_cents',    (select amount from cogs),
    'gross_profit_cents',
      (select coalesce(sum(subtotal_cents), 0) from scope) - (select amount from cogs),
    'margin_pct', case
      when (select coalesce(sum(subtotal_cents), 0) from scope) = 0 then 0
      else round(
        ((select coalesce(sum(subtotal_cents), 0) from scope) - (select amount from cogs))
        * 100.0 / (select sum(subtotal_cents) from scope), 1) end,
    'average_basket_cents', case
      when (select count(*) from scope) = 0 then 0
      else round((select sum(total_cents) from scope)::numeric
                 / (select count(*) from scope)) end,
    'items_sold', (select coalesce(sum(si.qty), 0) from sale_items si
                    join scope s on s.sale_id = si.sale_id),
    'voided_count', (select count(*) from sales
                      where business_id = auth_business_id() and status = 'VOIDED'
                        and coalesce(completed_at, occurred_at) between p_from and p_to
                        and (p_event_id is null or event_id = p_event_id))
  )
$$;

-- ── Sales by product (with margin) ──────────────────────────────────────────
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
as $$
  with lines as (
    select si.product_id, si.product_name, si.qty,
           si.line_total_cents, si.tax_amount_cents, si.sale_id
      from sale_items si
      join sales s on s.sale_id = si.sale_id
     where s.business_id = auth_business_id()
       and s.status = 'COMPLETED'
       and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
       and (p_event_id is null or s.event_id = p_event_id)
  ),
  cost as (
    select m.sale_id, m.product_id,
           sum(abs(m.qty_delta) * m.unit_cost_cents)::bigint as cogs
      from stock_movements m
      join lines l on l.sale_id = m.sale_id and l.product_id = m.product_id
     where m.movement_type = 'SALE'
     group by m.sale_id, m.product_id
  ),
  agg as (
    select
      l.product_id,
      max(l.product_name) as name,
      sum(l.qty) as qty,
      sum(l.line_total_cents - l.tax_amount_cents)::bigint as revenue,
      sum(l.tax_amount_cents)::bigint as vat,
      coalesce(sum(c.cogs), 0)::bigint as cogs
    from lines l
    left join cost c on c.sale_id = l.sale_id and c.product_id = l.product_id
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
  left join products p   on p.product_id = a.product_id
  left join categories cat on cat.category_id = p.category_id
  order by a.revenue desc
$$;

-- ── Sales by category ───────────────────────────────────────────────────────
create or replace function report_by_category(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns table (
  category text, qty numeric, revenue_cents bigint,
  cogs_cents bigint, margin_cents bigint, margin_pct numeric
)
language sql stable security definer set search_path = public
as $$
  with lines as (
    select coalesce(c.name, 'Uncategorised') as category,
           si.qty, si.line_total_cents, si.tax_amount_cents,
           si.sale_id, si.product_id
      from sale_items si
      join sales s      on s.sale_id = si.sale_id
      left join products p  on p.product_id = si.product_id
      left join categories c on c.category_id = p.category_id
     where s.business_id = auth_business_id()
       and s.status = 'COMPLETED'
       and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
       and (p_event_id is null or s.event_id = p_event_id)
  ),
  cost as (
    select m.sale_id, m.product_id,
           sum(abs(m.qty_delta) * m.unit_cost_cents)::bigint as cogs
      from stock_movements m
     where m.movement_type = 'SALE'
     group by m.sale_id, m.product_id
  )
  select
    l.category,
    sum(l.qty),
    sum(l.line_total_cents - l.tax_amount_cents)::bigint,
    coalesce(sum(c.cogs), 0)::bigint,
    (sum(l.line_total_cents - l.tax_amount_cents) - coalesce(sum(c.cogs), 0))::bigint,
    case when sum(l.line_total_cents - l.tax_amount_cents) = 0 then 0
         else round((sum(l.line_total_cents - l.tax_amount_cents)
                     - coalesce(sum(c.cogs), 0)) * 100.0
                    / sum(l.line_total_cents - l.tax_amount_cents), 1) end
  from lines l
  left join cost c on c.sale_id = l.sale_id and c.product_id = l.product_id
  group by l.category
  order by 3 desc
$$;

-- ── Sales by cashier ────────────────────────────────────────────────────────
create or replace function report_by_cashier(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns table (
  cashier text, device text, sales_count bigint,
  gross_cents bigint, average_basket_cents bigint,
  discount_cents bigint, voided_count bigint,
  price_overrides bigint
)
language sql stable security definer set search_path = public
as $$
  select
    c.full_name, d.code,
    count(*) filter (where s.status = 'COMPLETED'),
    coalesce(sum(s.total_cents) filter (where s.status = 'COMPLETED'), 0)::bigint,
    case when count(*) filter (where s.status = 'COMPLETED') = 0 then 0
         else round(coalesce(sum(s.total_cents) filter (where s.status = 'COMPLETED'), 0)::numeric
                    / count(*) filter (where s.status = 'COMPLETED'))::bigint end,
    coalesce(sum(s.discount_total_cents) filter (where s.status = 'COMPLETED'), 0)::bigint,
    count(*) filter (where s.status = 'VOIDED'),
    (select count(*) from sale_items si
      where si.sale_id in (select sale_id from sales s2
                            where s2.cashier_id = c.cashier_id
                              and coalesce(s2.completed_at, s2.occurred_at)
                                  between p_from and p_to)
        and si.price_overridden)
  from sales s
  join cashiers c on c.cashier_id = s.cashier_id
  join devices  d on d.device_id  = s.device_id
  where s.business_id = auth_business_id()
    and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
    and (p_event_id is null or s.event_id = p_event_id)
  group by c.cashier_id, c.full_name, d.code
  order by 4 desc
$$;

-- ── Sales by hour (the staffing report) ────────────────────────────────────
create or replace function report_by_hour(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns table (
  hour int,
  sales_count bigint,
  gross_cents bigint,
  items numeric
)
language sql stable security definer set search_path = public
as $$
  with scoped_sales as (
    select
      s.sale_id,
      s.total_cents,
      extract(
        hour from (
          coalesce(s.completed_at, s.occurred_at)
          at time zone 'Africa/Nairobi'
        )
      )::int as sale_hour
    from sales s
    where s.business_id = auth_business_id()
      and s.status = 'COMPLETED'
      and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
      and (p_event_id is null or s.event_id = p_event_id)
  )
  select
    ss.sale_hour as hour,
    count(*)::bigint as sales_count,
    coalesce(sum(ss.total_cents), 0)::bigint as gross_cents,
    coalesce(sum(si.qty), 0) as items
  from scoped_sales ss
  left join sale_items si
    on si.sale_id = ss.sale_id
  group by ss.sale_hour
  order by ss.sale_hour
$$;

-- ── Sales by payment method ────────────────────────────────────────────────
create or replace function report_by_payment(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns table (
  method text, count bigint, amount_cents bigint,
  verified_cents bigint, unverified_cents bigint, share_pct numeric
)
language sql stable security definer set search_path = public
as $$
  with pay as (
    select p.method::text as method, p.amount_cents, p.status
      from payments p
      join sales s on s.sale_id = p.sale_id
     where s.business_id = auth_business_id()
       and s.status = 'COMPLETED'
       and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
       and (p_event_id is null or s.event_id = p_event_id)
  )
  select
    method, count(*), sum(amount_cents)::bigint,
    coalesce(sum(amount_cents) filter (where status = 'VERIFIED'), 0)::bigint,
    coalesce(sum(amount_cents) filter (where status <> 'VERIFIED'), 0)::bigint,
    case when (select sum(amount_cents) from pay) = 0 then 0
         else round(sum(amount_cents) * 100.0
                    / (select sum(amount_cents) from pay), 1) end
  from pay
  group by method
  order by 3 desc
$$;

-- ── Sales by date ───────────────────────────────────────────────────────────
create or replace function report_by_date(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now(),
  p_event_id uuid default null
) returns table (
  day date, sales_count bigint, gross_cents bigint,
  vat_cents bigint, average_basket_cents bigint
)
language sql stable security definer set search_path = public
as $$
  select
    coalesce(s.completed_at, s.occurred_at)::date,
    count(*),
    coalesce(sum(s.total_cents), 0)::bigint,
    coalesce(sum(s.tax_total_cents), 0)::bigint,
    round(coalesce(sum(s.total_cents), 0)::numeric / count(*))::bigint
  from sales s
  where s.business_id = auth_business_id()
    and s.status = 'COMPLETED'
    and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
    and (p_event_id is null or s.event_id = p_event_id)
  group by 1
  order by 1 desc
$$;

-- ── VAT summary (the one the accountant wants) ─────────────────────────────
create or replace function report_vat(
  p_from timestamptz default now() - interval '30 days',
  p_to   timestamptz default now()
) returns table (
  tax_code text, rate_pct numeric,
  taxable_cents bigint, vat_cents bigint,
  net_cents bigint, lines bigint
)
language sql stable security definer set search_path = public
as $$
  select
    si.tax_ty_cd::text,
    round(si.tax_rate_bp / 100.0, 2),
    sum(si.taxable_amount_cents)::bigint,
    sum(si.tax_amount_cents)::bigint,
    sum(si.line_total_cents - si.tax_amount_cents)::bigint,
    count(*)
  from sale_items si
  join sales s on s.sale_id = si.sale_id
  where s.business_id = auth_business_id()
    and s.status = 'COMPLETED'
    and coalesce(s.completed_at, s.occurred_at) between p_from and p_to
  group by si.tax_ty_cd, si.tax_rate_bp
  order by si.tax_ty_cd
$$;

-- ── Stock valuation ─────────────────────────────────────────────────────────
create or replace function report_stock_valuation()
returns table (
  location text, location_kind text,
  product_id uuid, sku text, name text,
  qty numeric, unit_cost_cents bigint, value_cents bigint
)
language sql stable security definer set search_path = public
as $$
  select
    sl.name, sl.kind,
    p.product_id, p.sku, p.name,
    sb.qty_on_hand, p.cost_price_cents,
    round(sb.qty_on_hand * p.cost_price_cents)::bigint
  from stock_balances sb
  join stock_locations sl on sl.location_id = sb.location_id
  join products p on p.product_id = sb.product_id
  where sb.business_id = auth_business_id()
    and sb.qty_on_hand <> 0
  order by sl.kind, sl.name, p.name
$$;

-- ── eTIMS submission status ────────────────────────────────────────────────
create or replace function report_etims_status()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'queue', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (
        select status::text, count(*) as n
          from etims_submissions
         where business_id = auth_business_id()
         group by status) q),
    'oldest_pending_at', (
      select min(created_at) from etims_submissions
       where business_id = auth_business_id()
         and status in ('PENDING','FAILED')),
    'halted', exists (
      select 1 from etims_submissions
       where business_id = auth_business_id() and status = 'REJECTED'),
    'fiscalised_sales', (
      select count(*) from invoices where business_id = auth_business_id()),
    'awaiting_fiscalisation', (
      select count(*) from sales s
       where s.business_id = auth_business_id() and s.status = 'COMPLETED'
         and not exists (select 1 from invoices i where i.sale_id = s.sale_id))
  )
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- EVENT P&L (§15)
--
--   Revenue (excluding VAT)
--   - Cost of goods sold
--   = Gross profit
--   - Wastage and samples, at cost
--   - Event expenses
--   = Event profit / loss
--
-- Two deliberate choices:
--
-- 1. VAT is EXCLUDED from revenue. It is collected on KRA's behalf and is not
--    income. Including it would overstate profit by 16% of every drink sold.
--
-- 2. Stock still at the stall is reported SEPARATELY, not as a loss. It is
--    inventory that has not come home yet. If it never comes home, a
--    load-back or a stock take turns it into shrinkage — at which point it
--    does hit the P&L.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function event_pnl(p_event_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  with ev as (
    select * from events
     where event_id = p_event_id and business_id = auth_business_id()
  ),
  sold as (
    select
      coalesce(sum(s.subtotal_cents), 0)::bigint as revenue,
      coalesce(sum(s.tax_total_cents), 0)::bigint as vat,
      coalesce(sum(s.total_cents), 0)::bigint as gross,
      coalesce(sum(s.discount_total_cents), 0)::bigint as discounts,
      count(*) as sales_count
    from sales s
    where s.event_id = p_event_id and s.status = 'COMPLETED'
  ),
  cogs as (
    select coalesce(sum(abs(m.qty_delta) * m.unit_cost_cents), 0)::bigint as amount
      from stock_movements m
     where m.event_id = p_event_id and m.movement_type = 'SALE'
  ),
  losses as (
    select
      coalesce(sum(abs(m.qty_delta) * m.unit_cost_cents)
               filter (where m.movement_type = 'WASTAGE'), 0)::bigint as wastage,
      coalesce(sum(abs(m.qty_delta) * m.unit_cost_cents)
               filter (where m.movement_type = 'SAMPLE'), 0)::bigint as samples,
      coalesce(sum(abs(m.qty_delta) * m.unit_cost_cents)
               filter (where m.movement_type = 'SHRINKAGE'), 0)::bigint as shrinkage,
      coalesce(sum(abs(m.qty_delta)) filter (where m.movement_type = 'WASTAGE'), 0) as wastage_qty
    from stock_movements m
    where m.event_id = p_event_id
  ),
  costs as (
    -- The inner query already aliases the sum as `amount`; summing
    -- `amount_cents` here would reference a column that no longer exists.
    select
      coalesce(sum(c.amount), 0)::bigint as total,
      coalesce(jsonb_object_agg(c.category, c.amount), '{}'::jsonb) as by_category
    from (
      select category, sum(amount_cents)::bigint as amount
        from event_costs where event_id = p_event_id
       group by category) c
  ),
  remaining as (
    select coalesce(sum(sb.qty_on_hand * p.cost_price_cents), 0)::bigint as value,
           coalesce(sum(sb.qty_on_hand), 0) as qty
      from stock_balances sb
      join stock_locations sl on sl.location_id = sb.location_id
      join products p on p.product_id = sb.product_id
     where sl.event_id = p_event_id
  )
  select jsonb_build_object(
    'event', jsonb_build_object(
      'event_id', (select event_id from ev),
      'name', (select name from ev),
      'venue', (select venue from ev),
      'status', (select status from ev),
      'start_date', (select start_date from ev),
      'end_date', (select end_date from ev)),

    'sales_count', (select sales_count from sold),
    'gross_takings_cents', (select gross from sold),
    'vat_collected_cents', (select vat from sold),
    'discounts_cents', (select discounts from sold),

    'revenue_cents', (select revenue from sold),
    'cogs_cents', (select amount from cogs),
    'gross_profit_cents', (select revenue from sold) - (select amount from cogs),
    'gross_margin_pct', case
      when (select revenue from sold) = 0 then 0
      else round(((select revenue from sold) - (select amount from cogs))
                 * 100.0 / (select revenue from sold), 1) end,

    'wastage_cents', (select wastage from losses),
    'wastage_qty', (select wastage_qty from losses),
    'samples_cents', (select samples from losses),
    'shrinkage_cents', (select shrinkage from losses),
    'losses_total_cents',
      (select wastage + samples + shrinkage from losses),

    'expenses_cents', (select total from costs),
    'expenses_by_category', (select by_category from costs),

    'profit_cents',
      (select revenue from sold)
      - (select amount from cogs)
      - (select wastage + samples + shrinkage from losses)
      - (select total from costs),

    'net_margin_pct', case
      when (select revenue from sold) = 0 then 0
      else round((
        (select revenue from sold) - (select amount from cogs)
        - (select wastage + samples + shrinkage from losses)
        - (select total from costs)) * 100.0 / (select revenue from sold), 1) end,

    -- Inventory, not a loss. Reported separately so it cannot be mistaken
    -- for profit or for shrinkage.
    'stock_left_at_stall_cents', (select value from remaining),
    'stock_left_at_stall_qty', (select qty from remaining)
  )
$$;

-- ── Event comparison ────────────────────────────────────────────────────────
create or replace function compare_events()
returns table (
  event_id uuid, name text, start_date date, status text,
  sales_count bigint, revenue_cents bigint, cogs_cents bigint,
  losses_cents bigint, expenses_cents bigint, profit_cents bigint,
  margin_pct numeric, revenue_per_day bigint
)
language sql stable security definer set search_path = public
as $$
  select
    e.event_id, e.name, e.start_date, e.status,
    coalesce(s.cnt, 0),
    coalesce(s.revenue, 0),
    coalesce(cg.amount, 0),
    coalesce(ls.amount, 0),
    coalesce(ec.amount, 0),
    coalesce(s.revenue, 0) - coalesce(cg.amount, 0)
      - coalesce(ls.amount, 0) - coalesce(ec.amount, 0),
    case when coalesce(s.revenue, 0) = 0 then 0
         else round((coalesce(s.revenue, 0) - coalesce(cg.amount, 0)
                     - coalesce(ls.amount, 0) - coalesce(ec.amount, 0))
                    * 100.0 / s.revenue, 1) end,
    -- Normalising by day makes a two-day event comparable to a five-day one.
    case when (e.end_date - e.start_date) + 1 = 0 then 0
         else (coalesce(s.revenue, 0) / ((e.end_date - e.start_date) + 1))::bigint end
  from events e
  left join lateral (
    select count(*) as cnt, coalesce(sum(subtotal_cents), 0)::bigint as revenue
      from sales where event_id = e.event_id and status = 'COMPLETED') s on true
  left join lateral (
    select coalesce(sum(abs(qty_delta) * unit_cost_cents), 0)::bigint as amount
      from stock_movements
     where event_id = e.event_id and movement_type = 'SALE') cg on true
  left join lateral (
    select coalesce(sum(abs(qty_delta) * unit_cost_cents), 0)::bigint as amount
      from stock_movements
     where event_id = e.event_id
       and movement_type in ('WASTAGE','SAMPLE','SHRINKAGE')) ls on true
  left join lateral (
    select coalesce(sum(amount_cents), 0)::bigint as amount
      from event_costs where event_id = e.event_id) ec on true
  where e.business_id = auth_business_id()
  order by e.start_date desc
$$;

-- ── Event costs: add and list ──────────────────────────────────────────────
create or replace function add_event_cost(
  p_event_id uuid, p_category text, p_description text,
  p_amount_cents bigint, p_incurred_on date default current_date
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare v_id uuid := uuid_generate_v7();
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_category not in ('STALL','TRANSPORT','STAFF','ACCOMMODATION','LICENCE','OTHER') then
    raise exception 'invalid_category: %', p_category using errcode = '23514';
  end if;
  if p_amount_cents <= 0 then
    raise exception 'amount_must_be_positive' using errcode = '23514';
  end if;

  insert into event_costs (
    cost_id, event_id, business_id, category, description,
    amount_cents, incurred_on, recorded_by)
  values (
    v_id, p_event_id, auth_business_id(), p_category,
    nullif(trim(p_description), ''), p_amount_cents, p_incurred_on, auth.uid());

  return jsonb_build_object('cost_id', v_id);
end $$;

create or replace function list_event_costs(p_event_id uuid)
returns table (
  cost_id uuid, category text, description text,
  amount_cents bigint, incurred_on date
)
language sql stable security definer set search_path = public
as $$
  select cost_id, category, description, amount_cents, incurred_on
    from event_costs
   where event_id = p_event_id and business_id = auth_business_id()
   order by incurred_on desc, category
$$;

grant execute on function report_summary(timestamptz, timestamptz, uuid)      to authenticated;
grant execute on function report_by_product(timestamptz, timestamptz, uuid)   to authenticated;
grant execute on function report_by_category(timestamptz, timestamptz, uuid)  to authenticated;
grant execute on function report_by_cashier(timestamptz, timestamptz, uuid)   to authenticated;
grant execute on function report_by_hour(timestamptz, timestamptz, uuid)      to authenticated;
grant execute on function report_by_payment(timestamptz, timestamptz, uuid)   to authenticated;
grant execute on function report_by_date(timestamptz, timestamptz, uuid)      to authenticated;
grant execute on function report_vat(timestamptz, timestamptz)                to authenticated;
grant execute on function report_stock_valuation()                            to authenticated;
grant execute on function report_etims_status()                               to authenticated;
grant execute on function event_pnl(uuid)                                     to authenticated;
grant execute on function compare_events()                                    to authenticated;
grant execute on function add_event_cost(uuid, text, text, bigint, date)      to authenticated;
grant execute on function list_event_costs(uuid)                              to authenticated;
