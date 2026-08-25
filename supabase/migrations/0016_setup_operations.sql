-- ============================================================================
-- 0016_setup_operations.sql
--
-- Everything a supervisor needs to stand up an event without SQL:
-- events, products, staff/PINs, and load-out.
--
-- Fixes a modelling gap along the way. The demo seed wrote load-out as a
-- SINGLE movement into the event location and never decremented the base
-- store, so base stock was fictional. `record_load_out` below writes proper
-- double-entry: out of BASE, into EVENT, in one transaction.
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- EVENTS
-- ═══════════════════════════════════════════════════════════════════════════

-- Creating an event also creates its stock location. Forgetting that step is
-- what produces "no_event_location" at the till, which is a confusing error
-- to hit mid-queue.
create or replace function create_event(
  p_name text,
  p_venue text,
  p_county text,
  p_start_date date,
  p_end_date date,
  p_activate boolean default false
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_business_id uuid := auth_business_id();
  v_event_id uuid := uuid_generate_v7();
  v_location_id uuid := uuid_generate_v7();
  v_code text;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'name_required' using errcode = '23514';
  end if;
  if p_end_date < p_start_date then
    raise exception 'end_before_start' using errcode = '23514';
  end if;

  insert into events (
    event_id, business_id, name, venue, county, start_date, end_date, status)
  values (
    v_event_id, v_business_id, trim(p_name), nullif(trim(p_venue), ''),
    nullif(trim(p_county), ''), p_start_date, p_end_date, 'PLANNED');

  -- Location code must be unique per business; derive then disambiguate.
  v_code := 'EV-' || upper(regexp_replace(substring(p_name from 1 for 8), '[^a-zA-Z0-9]', '', 'g'));
  if exists (select 1 from stock_locations
              where business_id = v_business_id and code = v_code) then
    v_code := v_code || '-' || substring(v_event_id::text from 1 for 4);
  end if;

  insert into stock_locations (
    location_id, business_id, code, name, kind, event_id)
  values (
    v_location_id, v_business_id, v_code, p_name || ' stall', 'EVENT', v_event_id);

  if p_activate then
    perform activate_event(v_event_id);
  end if;

  insert into audit_logs (business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (v_business_id, auth.uid(), 'EVENT_CREATED', 'event', v_event_id,
          jsonb_build_object('name', p_name, 'location_id', v_location_id));

  return jsonb_build_object(
    'event_id', v_event_id, 'location_id', v_location_id, 'location_code', v_code);
end $$;

-- Only one event may be ACTIVE (enforced by a unique index). Activating one
-- therefore has to stand the previous one down, atomically.
create or replace function activate_event(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_business_id uuid := auth_business_id();
  v_previous uuid;
  v_name text;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select name into v_name from events
   where event_id = p_event_id and business_id = v_business_id;
  if not found then
    raise exception 'unknown_event' using errcode = '23503';
  end if;

  -- Refuse while a till is mid-shift: sales would silently jump events.
  if exists (
    select 1 from shifts s
     where s.business_id = v_business_id and s.status = 'OPEN'
       and s.event_id <> p_event_id
  ) then
    raise exception 'shifts_open_on_another_event' using errcode = '23514',
      hint = 'Close all open shifts before switching events.';
  end if;

  select event_id into v_previous from events
   where business_id = v_business_id and status = 'ACTIVE' and event_id <> p_event_id;

  if v_previous is not null then
    update events set status = 'PLANNED' where event_id = v_previous;
  end if;

  update events set status = 'ACTIVE' where event_id = p_event_id;

  -- An event with no stock location cannot be sold from. Repair silently
  -- rather than failing at the till later.
  if not exists (select 1 from stock_locations
                  where event_id = p_event_id and is_active) then
    insert into stock_locations (business_id, code, name, kind, event_id)
    values (v_business_id,
            'EV-' || substring(p_event_id::text from 1 for 8),
            v_name || ' stall', 'EVENT', p_event_id);
  end if;

  insert into audit_logs (business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (v_business_id, auth.uid(), 'EVENT_ACTIVATED', 'event', p_event_id,
          jsonb_build_object('previous_event', v_previous));

  return jsonb_build_object('event_id', p_event_id, 'deactivated', v_previous);
end $$;

create or replace function close_event(p_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_business_id uuid := auth_business_id();
  v_open_shifts int;
  v_remaining numeric;
  v_summary jsonb;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select count(*) into v_open_shifts from shifts
   where event_id = p_event_id and status = 'OPEN';
  if v_open_shifts > 0 then
    raise exception 'shifts_still_open: %', v_open_shifts using errcode = '23514',
      hint = 'Every till must close its shift before the event closes.';
  end if;

  -- Stock left at the stall means load-back was not recorded. Warn rather
  -- than block: the supervisor may be closing up remotely.
  select coalesce(sum(sb.qty_on_hand), 0) into v_remaining
    from stock_balances sb
    join stock_locations sl on sl.location_id = sb.location_id
   where sl.event_id = p_event_id;

  select jsonb_build_object(
    'sales_count', count(*),
    'gross_cents', coalesce(sum(total_cents), 0),
    'tax_cents',   coalesce(sum(tax_total_cents), 0)
  ) into v_summary
    from sales where event_id = p_event_id and status = 'COMPLETED';

  update events set status = 'CLOSED', closed_at = now()
   where event_id = p_event_id and business_id = v_business_id;

  insert into audit_logs (business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (v_business_id, auth.uid(), 'EVENT_CLOSED', 'event', p_event_id,
          v_summary || jsonb_build_object('stock_left_at_stall', v_remaining));

  return v_summary || jsonb_build_object('stock_left_at_stall', v_remaining);
end $$;

create or replace function list_events()
returns table (
  event_id uuid, name text, venue text, county text,
  start_date date, end_date date, status text,
  location_id uuid, sales_count bigint, gross_cents bigint,
  stock_at_stall numeric, open_shifts bigint
)
language sql stable security definer set search_path = public
as $$
  select
    e.event_id, e.name, e.venue, e.county, e.start_date, e.end_date, e.status,
    sl.location_id,
    (select count(*) from sales s
      where s.event_id = e.event_id and s.status = 'COMPLETED'),
    (select coalesce(sum(s.total_cents), 0) from sales s
      where s.event_id = e.event_id and s.status = 'COMPLETED'),
    (select coalesce(sum(sb.qty_on_hand), 0) from stock_balances sb
      where sb.location_id = sl.location_id),
    (select count(*) from shifts sh
      where sh.event_id = e.event_id and sh.status = 'OPEN')
  from events e
  left join stock_locations sl
    on sl.event_id = e.event_id and sl.is_active
  where e.business_id = auth_business_id()
  order by
    case e.status when 'ACTIVE' then 0 when 'PLANNED' then 1 else 2 end,
    e.start_date desc
$$;

grant execute on function create_event(text, text, text, date, date, boolean) to authenticated;
grant execute on function activate_event(uuid)  to authenticated;
grant execute on function close_event(uuid)     to authenticated;
grant execute on function list_events()         to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- PRODUCTS
-- ═══════════════════════════════════════════════════════════════════════════

-- itemCd format per KRA OSCU spec §4.19:
--   KE + productType(1) + pkgUnitCd(2) + qtyUnitCd(1-3) + 7-digit sequence
create sequence if not exists etims_item_cd_seq start 1;

create or replace function upsert_product(
  p_product_id uuid,          -- null to create
  p_sku text,
  p_name text,
  p_short_name text,
  p_category text,
  p_uom text,
  p_cost_price_cents bigint,
  p_selling_price_cents bigint,
  p_tax_ty_cd text,
  p_item_cls_cd text,
  p_track_stock boolean default true,
  p_is_active boolean default true,
  p_tile_order int default 0
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_business_id uuid := auth_business_id();
  v_category_id uuid;
  v_product_id uuid;
  v_item_cd text;
  v_qty_unit text;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if nullif(trim(p_sku), '') is null or nullif(trim(p_name), '') is null then
    raise exception 'sku_and_name_required' using errcode = '23514';
  end if;
  if p_selling_price_cents < 0 or p_cost_price_cents < 0 then
    raise exception 'prices_cannot_be_negative' using errcode = '23514';
  end if;
  if p_tax_ty_cd is not null and p_tax_ty_cd not in ('A','B','C','D','E') then
    raise exception 'invalid_tax_type: %', p_tax_ty_cd using errcode = '23514';
  end if;

  if nullif(trim(p_category), '') is not null then
    insert into categories (business_id, name)
    values (v_business_id, trim(p_category))
    on conflict (business_id, name) do nothing;

    select category_id into v_category_id from categories
     where business_id = v_business_id and name = trim(p_category);
  end if;

  v_qty_unit := case upper(coalesce(p_uom, 'EA')) when 'KG' then 'KG' else 'U' end;

  if p_product_id is null then
    v_product_id := uuid_generate_v7();
    -- Generated once, at creation. itemCd must never change afterwards:
    -- KRA links historic invoices to it.
    v_item_cd := 'KE2NT' || v_qty_unit
               || lpad(nextval('etims_item_cd_seq')::text, 7, '0');

    insert into products (
      product_id, business_id, sku, name, short_name, category_id, uom,
      cost_price_cents, selling_price_cents,
      etims_tax_ty_cd, etims_item_cls_cd, etims_item_cd,
      etims_pkg_unit_cd, etims_qty_unit_cd,
      track_stock, is_active, tile_order)
    values (
      v_product_id, v_business_id, trim(p_sku), trim(p_name),
      nullif(trim(p_short_name), ''), v_category_id, upper(coalesce(p_uom,'EA')),
      p_cost_price_cents, p_selling_price_cents,
      p_tax_ty_cd::tax_type_code, nullif(trim(p_item_cls_cd), ''), v_item_cd,
      'NT', v_qty_unit,
      p_track_stock, p_is_active, p_tile_order);
  else
    v_product_id := p_product_id;

    update products set
      sku = trim(p_sku),
      name = trim(p_name),
      short_name = nullif(trim(p_short_name), ''),
      category_id = v_category_id,
      uom = upper(coalesce(p_uom,'EA')),
      cost_price_cents = p_cost_price_cents,
      selling_price_cents = p_selling_price_cents,
      etims_tax_ty_cd = p_tax_ty_cd::tax_type_code,
      etims_item_cls_cd = nullif(trim(p_item_cls_cd), ''),
      etims_qty_unit_cd = v_qty_unit,
      track_stock = p_track_stock,
      is_active = p_is_active,
      tile_order = p_tile_order,
      updated_at = now()
    where product_id = p_product_id and business_id = v_business_id;

    if not found then
      raise exception 'unknown_product' using errcode = '23503';
    end if;
  end if;

  insert into audit_logs (business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (v_business_id, auth.uid(),
          case when p_product_id is null then 'PRODUCT_CREATED' else 'PRODUCT_UPDATED' end,
          'product', v_product_id,
          jsonb_build_object('sku', p_sku, 'name', p_name,
                             'price_cents', p_selling_price_cents,
                             'tax_ty_cd', p_tax_ty_cd));

  return jsonb_build_object('product_id', v_product_id, 'item_cd', v_item_cd);
end $$;

create or replace function list_products()
returns table (
  product_id uuid, sku text, name text, short_name text,
  category text, uom text,
  cost_price_cents bigint, selling_price_cents bigint,
  tax_ty_cd text, item_cls_cd text, item_cd text,
  track_stock boolean, is_active boolean, tile_order int,
  qty_base numeric, sellable boolean
)
language sql stable security definer set search_path = public
as $$
  select
    p.product_id, p.sku, p.name, p.short_name,
    c.name, p.uom,
    p.cost_price_cents, p.selling_price_cents,
    p.etims_tax_ty_cd::text, p.etims_item_cls_cd, p.etims_item_cd,
    p.track_stock, p.is_active, p.tile_order,
    coalesce((select sb.qty_on_hand from stock_balances sb
               join stock_locations sl on sl.location_id = sb.location_id
              where sb.product_id = p.product_id and sl.kind = 'BASE'
              limit 1), 0),
    p.etims_tax_ty_cd is not null
  from products p
  left join categories c on c.category_id = p.category_id
  where p.business_id = auth_business_id()
  order by p.is_active desc, p.tile_order, p.name
$$;

grant execute on function upsert_product(uuid, text, text, text, text, text,
  bigint, bigint, text, text, boolean, boolean, int) to authenticated;
grant execute on function list_products() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- STAFF
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function upsert_cashier(
  p_cashier_id uuid,          -- null to create
  p_full_name text,
  p_role text,
  p_max_discount_bp int,
  p_can_void boolean,
  p_can_override_price boolean,
  p_is_active boolean default true,
  p_pin text default null     -- set or reset; null leaves it unchanged
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_business_id uuid := auth_business_id();
  v_cashier_id uuid;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if nullif(trim(p_full_name), '') is null then
    raise exception 'name_required' using errcode = '23514';
  end if;
  if p_role not in ('OWNER','SUPERVISOR','CASHIER') then
    raise exception 'invalid_role: %', p_role using errcode = '23514';
  end if;
  if p_max_discount_bp < 0 or p_max_discount_bp > 10000 then
    raise exception 'discount_limit_out_of_range' using errcode = '23514';
  end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4 to 6 digits' using errcode = '22023';
  end if;

  if p_cashier_id is null then
    if p_pin is null then
      raise exception 'pin_required_for_new_cashier' using errcode = '23514';
    end if;
    v_cashier_id := uuid_generate_v7();

    insert into cashiers (
      cashier_id, business_id, full_name, pin_hash, role,
      max_discount_bp, can_void, can_override_price, is_active)
    values (
      v_cashier_id, v_business_id, trim(p_full_name),
      extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), p_role::user_role,
      p_max_discount_bp, p_can_void, p_can_override_price, p_is_active);
  else
    v_cashier_id := p_cashier_id;

    update cashiers set
      full_name = trim(p_full_name),
      role = p_role::user_role,
      max_discount_bp = p_max_discount_bp,
      can_void = p_can_void,
      can_override_price = p_can_override_price,
      is_active = p_is_active,
      pin_hash = case when p_pin is null then pin_hash
                      else extensions.crypt(p_pin, extensions.gen_salt('bf', 10)) end
    where cashier_id = p_cashier_id and business_id = v_business_id;

    if not found then
      raise exception 'unknown_cashier' using errcode = '23503';
    end if;
  end if;

  -- The PIN itself is never logged, only the fact that it changed.
  insert into audit_logs (business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (v_business_id, auth.uid(),
          case when p_cashier_id is null then 'CASHIER_CREATED' else 'CASHIER_UPDATED' end,
          'cashier', v_cashier_id,
          jsonb_build_object('name', p_full_name, 'role', p_role,
                             'max_discount_bp', p_max_discount_bp,
                             'pin_changed', p_pin is not null,
                             'is_active', p_is_active));

  return jsonb_build_object('cashier_id', v_cashier_id);
end $$;

-- Five wrong PINs in five minutes locks a cashier out. This clears it.
create or replace function unlock_cashier(p_cashier_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_removed int;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  delete from pin_attempts
   where cashier_id = p_cashier_id and not succeeded
     and attempted_at > now() - interval '15 minutes';
  get diagnostics v_removed = row_count;

  insert into audit_logs (business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (auth_business_id(), auth.uid(), 'CASHIER_UNLOCKED', 'cashier', p_cashier_id,
          jsonb_build_object('cleared_attempts', v_removed));

  return jsonb_build_object('cleared', v_removed);
end $$;

create or replace function list_cashiers()
returns table (
  cashier_id uuid, full_name text, role text,
  max_discount_bp int, can_void boolean, can_override_price boolean,
  is_active boolean, recent_failures bigint, is_locked boolean,
  sales_today bigint
)
language sql stable security definer set search_path = public
as $$
  select
    c.cashier_id, c.full_name, c.role::text,
    c.max_discount_bp, c.can_void, c.can_override_price, c.is_active,
    (select count(*) from pin_attempts a
      where a.cashier_id = c.cashier_id and not a.succeeded
        and a.attempted_at > now() - interval '5 minutes'),
    (select count(*) from pin_attempts a
      where a.cashier_id = c.cashier_id and not a.succeeded
        and a.attempted_at > now() - interval '5 minutes') >= 5,
    (select count(*) from sales s
      where s.cashier_id = c.cashier_id and s.status = 'COMPLETED'
        and s.completed_at > current_date)
  from cashiers c
  where c.business_id = auth_business_id() and auth_is_staff()
  order by c.is_active desc, c.role, c.full_name
$$;

grant execute on function upsert_cashier(uuid, text, text, int, boolean, boolean,
  boolean, text) to authenticated;
grant execute on function unlock_cashier(uuid) to authenticated;
grant execute on function list_cashiers()      to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- LOAD-OUT  /  LOAD-BACK
-- ═══════════════════════════════════════════════════════════════════════════

-- Proper double-entry: stock leaves BASE and arrives at the EVENT location in
-- one transaction. The demo seed only ever wrote the arrival, which left base
-- store stock fictional.
--
-- p_lines: [{ "product_id": uuid, "qty": number }, ...]
create or replace function record_load_out(
  p_event_id uuid,
  p_lines jsonb,
  p_direction text default 'OUT'      -- OUT = base->event, BACK = event->base
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_business_id uuid := auth_business_id();
  v_base uuid;
  v_event_loc uuid;
  v_from uuid;
  v_to uuid;
  v_type movement_type;
  v_batch uuid := uuid_generate_v7();
  v_line jsonb;
  v_qty numeric;
  v_count int := 0;
  v_cost bigint := 0;
  v_product products%rowtype;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_direction not in ('OUT','BACK') then
    raise exception 'invalid_direction' using errcode = '23514';
  end if;

  select location_id into v_base from stock_locations
   where business_id = v_business_id and kind = 'BASE' and is_active limit 1;
  if v_base is null then
    raise exception 'no_base_location' using errcode = '23503',
      hint = 'Create a BASE stock location before loading out.';
  end if;

  select location_id into v_event_loc from stock_locations
   where business_id = v_business_id and event_id = p_event_id and is_active limit 1;
  if v_event_loc is null then
    raise exception 'no_event_location' using errcode = '23503';
  end if;

  if p_direction = 'OUT' then
    v_from := v_base; v_to := v_event_loc; v_type := 'LOAD_OUT';
  else
    v_from := v_event_loc; v_to := v_base; v_type := 'LOAD_BACK';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_qty := (v_line ->> 'qty')::numeric;
    continue when v_qty is null or v_qty = 0;

    select * into v_product from products
     where product_id = (v_line ->> 'product_id')::uuid
       and business_id = v_business_id;
    if not found then
      raise exception 'unknown_product: %', v_line ->> 'product_id'
        using errcode = '23503';
    end if;

    -- Out of the source location
    insert into stock_movements (
      movement_id, business_id, product_id, location_id, event_id,
      movement_type, qty_delta, unit_cost_cents, user_id,
      reason, occurred_at, idempotency_key)
    values (
      uuid_generate_v7(), v_business_id, v_product.product_id, v_from, p_event_id,
      v_type, -abs(v_qty), v_product.cost_price_cents, auth.uid(),
      p_direction || ' batch ' || substring(v_batch::text from 1 for 8), now(),
      'loadout:' || v_batch::text || ':from:' || v_product.product_id::text);

    -- Into the destination
    insert into stock_movements (
      movement_id, business_id, product_id, location_id, event_id,
      movement_type, qty_delta, unit_cost_cents, user_id,
      reason, occurred_at, idempotency_key)
    values (
      uuid_generate_v7(), v_business_id, v_product.product_id, v_to, p_event_id,
      v_type, abs(v_qty), v_product.cost_price_cents, auth.uid(),
      p_direction || ' batch ' || substring(v_batch::text from 1 for 8), now(),
      'loadout:' || v_batch::text || ':to:' || v_product.product_id::text);

    v_count := v_count + 1;
    v_cost := v_cost + (v_product.cost_price_cents * abs(v_qty))::bigint;
  end loop;

  if v_count = 0 then
    raise exception 'nothing_to_move' using errcode = '23514',
      hint = 'Enter a quantity against at least one product.';
  end if;

  insert into audit_logs (business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (v_business_id, auth.uid(), 'STOCK_' || p_direction, 'event', p_event_id,
          jsonb_build_object('batch', v_batch, 'lines', v_count,
                             'cost_cents', v_cost));

  return jsonb_build_object(
    'batch', v_batch, 'lines', v_count, 'cost_cents', v_cost,
    'direction', p_direction);
end $$;

-- What is at base, what is at the stall, side by side.
create or replace function load_out_sheet(p_event_id uuid)
returns table (
  product_id uuid, sku text, name text, category text, uom text,
  qty_base numeric, qty_event numeric,
  cost_price_cents bigint, sellable boolean
)
language sql stable security definer set search_path = public
as $$
  select
    p.product_id, p.sku, p.name, c.name, p.uom,
    coalesce((select sb.qty_on_hand from stock_balances sb
               join stock_locations sl on sl.location_id = sb.location_id
              where sb.product_id = p.product_id and sl.kind = 'BASE'
                and sl.business_id = p.business_id limit 1), 0),
    coalesce((select sb.qty_on_hand from stock_balances sb
               join stock_locations sl on sl.location_id = sb.location_id
              where sb.product_id = p.product_id and sl.event_id = p_event_id
              limit 1), 0),
    p.cost_price_cents,
    p.etims_tax_ty_cd is not null
  from products p
  left join categories c on c.category_id = p.category_id
  where p.business_id = auth_business_id()
    and p.is_active and p.track_stock
  order by p.tile_order, p.name
$$;

grant execute on function record_load_out(uuid, jsonb, text) to authenticated;
grant execute on function load_out_sheet(uuid)               to authenticated;
