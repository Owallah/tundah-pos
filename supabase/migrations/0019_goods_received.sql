-- ============================================================================
-- 0019_goods_received.sql
--
-- The missing first link in the stock chain.
--
--   Buy from supplier  →  BASE STORE  →  load out  →  EVENT STALL  →  sale
--   ^^^^^^^^^^^^^^^^^      this step had no UI at all
--
-- `PURCHASE` existed in the movement_type enum from migration 0003 but was
-- never reachable: record_stock_adjustment() rejects it, and record_load_out()
-- can only move stock that is already in the base store. So a fresh install
-- had no supported way to put stock into the system, and every product showed
-- zero at the till.
--
-- This also updates cost price, which matters more than it looks: COGS and
-- every margin figure come from `stock_movements.unit_cost_cents` captured at
-- the time of sale. If receiving does not maintain cost, margins are fiction.
-- ============================================================================

-- ── Make sure a base store exists ──────────────────────────────────────────
-- create_event() only creates EVENT locations. A business that created an
-- event before ever receiving stock would have no BASE at all.
create or replace function ensure_base_location()
returns uuid
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_business_id uuid := auth_business_id();
  v_id uuid;
begin
  select location_id into v_id from stock_locations
   where business_id = v_business_id and kind = 'BASE' and is_active
   limit 1;

  if v_id is null then
    v_id := uuid_generate_v7();
    insert into stock_locations (location_id, business_id, code, name, kind)
    values (v_id, v_business_id, 'BASE', 'Base store', 'BASE');
  end if;

  return v_id;
end
$fn$;

-- ── Suppliers ───────────────────────────────────────────────────────────────
create or replace function upsert_supplier(
  p_supplier_id uuid,
  p_name text,
  p_phone text default null,
  p_kra_pin text default null,
  p_email text default null,
  p_is_active boolean default true
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_business_id uuid := auth_business_id();
  v_id uuid;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '23514';
  end if;

  if p_supplier_id is null then
    v_id := uuid_generate_v7();
    insert into suppliers (supplier_id, business_id, name, phone, kra_pin, email, is_active)
    values (v_id, v_business_id, trim(p_name), nullif(trim(p_phone),''),
            nullif(trim(p_kra_pin),''), nullif(trim(p_email),''), p_is_active)
    on conflict (business_id, name) do update
      set phone = excluded.phone, kra_pin = excluded.kra_pin,
          email = excluded.email, is_active = excluded.is_active
    returning supplier_id into v_id;
  else
    v_id := p_supplier_id;
    update suppliers set
      name = trim(p_name), phone = nullif(trim(p_phone),''),
      kra_pin = nullif(trim(p_kra_pin),''), email = nullif(trim(p_email),''),
      is_active = p_is_active
    where supplier_id = p_supplier_id and business_id = v_business_id;
    if not found then
      raise exception 'unknown_supplier' using errcode = '23503';
    end if;
  end if;

  return jsonb_build_object('supplier_id', v_id);
end
$fn$;

create or replace function list_suppliers()
returns table (
  supplier_id uuid, name text, phone text, kra_pin text,
  email text, is_active boolean, last_delivery timestamptz
)
language sql stable security definer set search_path = public
as $fn$
  select s.supplier_id, s.name, s.phone, s.kra_pin, s.email, s.is_active,
         (select max(m.created_at_server) from stock_movements m
           where m.movement_type = 'PURCHASE'
             and m.source_ref like 'supplier:' || s.supplier_id::text || '%')
    from suppliers s
   where s.business_id = auth_business_id() and auth_is_staff()
   order by s.is_active desc, s.name
$fn$;

-- ── Goods received ──────────────────────────────────────────────────────────
--
-- p_lines: [{ "product_id": uuid, "qty": number, "unit_cost_cents": bigint }]
--
-- `unit_cost_cents` is optional per line. When supplied and p_update_cost is
-- true, the product's cost price is updated — so the NEXT sale computes COGS
-- against what you actually paid. Historic movements keep the cost they were
-- written with, so past margins never move.
create or replace function record_goods_received(
  p_lines jsonb,
  p_supplier_id uuid default null,
  p_reference text default null,
  p_update_cost boolean default true,
  p_received_on date default current_date
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $fn$
declare
  v_business_id uuid := auth_business_id();
  v_base uuid;
  v_batch uuid := uuid_generate_v7();
  v_line jsonb;
  v_qty numeric;
  v_cost bigint;
  v_product products%rowtype;
  v_count int := 0;
  v_total bigint := 0;
  v_supplier text;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only a supervisor or owner may receive stock.';
  end if;

  v_base := ensure_base_location();

  if p_supplier_id is not null then
    select name into v_supplier from suppliers
     where supplier_id = p_supplier_id and business_id = v_business_id;
    if not found then
      raise exception 'unknown_supplier' using errcode = '23503';
    end if;
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line ->> 'qty')::numeric;
    continue when v_qty is null or v_qty <= 0;

    select * into v_product from products
     where product_id = (v_line ->> 'product_id')::uuid
       and business_id = v_business_id;
    if not found then
      raise exception 'unknown_product: %', v_line ->> 'product_id'
        using errcode = '23503';
    end if;

    v_cost := coalesce(
      nullif(v_line ->> 'unit_cost_cents','')::bigint,
      v_product.cost_price_cents);

    if v_cost < 0 then
      raise exception 'cost_cannot_be_negative' using errcode = '23514';
    end if;

    insert into stock_movements (
      movement_id, business_id, product_id, location_id,
      movement_type, qty_delta, unit_cost_cents,
      user_id, source_ref, reason,
      occurred_at, idempotency_key)
    values (
      uuid_generate_v7(), v_business_id, v_product.product_id, v_base,
      'PURCHASE', abs(v_qty), v_cost,
      auth.uid(),
      case when p_supplier_id is null then null
           else 'supplier:' || p_supplier_id::text end,
      coalesce(nullif(trim(p_reference),''),
               'Goods received ' || p_received_on::text),
      p_received_on::timestamptz,
      'grn:' || v_batch::text || ':' || v_product.product_id::text);

    -- Update cost for FUTURE sales only. Movements already written keep the
    -- cost they captured, so historic margin cannot shift under you.
    if p_update_cost and v_cost <> v_product.cost_price_cents then
      update products
         set cost_price_cents = v_cost, updated_at = now()
       where product_id = v_product.product_id;
    end if;

    v_count := v_count + 1;
    v_total := v_total + (v_cost * abs(v_qty))::bigint;
  end loop;

  if v_count = 0 then
    raise exception 'nothing_received' using errcode = '23514',
      hint = 'Enter a quantity against at least one product.';
  end if;

  insert into audit_logs (
    business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (
    v_business_id, auth.uid(), 'GOODS_RECEIVED', 'stock_location', v_base,
    jsonb_build_object('batch', v_batch, 'lines', v_count,
                       'total_cost_cents', v_total,
                       'supplier', v_supplier, 'reference', p_reference));

  return jsonb_build_object(
    'batch', v_batch, 'lines', v_count,
    'total_cost_cents', v_total, 'supplier', v_supplier);
end
$fn$;

-- ── The receiving sheet ─────────────────────────────────────────────────────
create or replace function goods_received_sheet()
returns table (
  product_id uuid, sku text, name text, category text, uom text,
  qty_base numeric, qty_all_locations numeric,
  cost_price_cents bigint, selling_price_cents bigint,
  reorder_point numeric, below_reorder boolean, sellable boolean
)
language sql stable security definer set search_path = public
as $fn$
  select
    p.product_id, p.sku, p.name, c.name, p.uom,
    coalesce((select sb.qty_on_hand from stock_balances sb
               join stock_locations sl on sl.location_id = sb.location_id
              where sb.product_id = p.product_id and sl.kind = 'BASE'
                and sl.business_id = p.business_id limit 1), 0),
    coalesce((select sum(sb.qty_on_hand) from stock_balances sb
              where sb.product_id = p.product_id), 0),
    p.cost_price_cents, p.selling_price_cents,
    p.reorder_point,
    p.reorder_point is not null
      and coalesce((select sum(sb.qty_on_hand) from stock_balances sb
                    where sb.product_id = p.product_id), 0) <= p.reorder_point,
    p.etims_tax_ty_cd is not null
  from products p
  left join categories c on c.category_id = p.category_id
  where p.business_id = auth_business_id()
    and p.is_active and p.track_stock
  order by p.tile_order, p.name
$fn$;

grant execute on function ensure_base_location()                          to authenticated;
grant execute on function upsert_supplier(uuid, text, text, text, text, boolean) to authenticated;
grant execute on function list_suppliers()                                to authenticated;
grant execute on function record_goods_received(jsonb, uuid, text, boolean, date) to authenticated;
grant execute on function goods_received_sheet()                          to authenticated;
