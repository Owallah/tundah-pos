-- 0028_stock_adjustment_fixes.sql
--
-- Two confirmed bugs in record_stock_adjustment(), the function behind the
-- "Correction" screen (StockAdjust.tsx) — distinct from record_load_out(),
-- which powers the separate LoadOut.tsx screen and was already correct.
--
-- BUG 1 — LOAD_BACK never credited base.
-- The function wrote exactly one stock_movements row: a negative delta at
-- the event location. Nothing was ever written crediting base. Stock
-- returned at the end of an event was genuinely vanishing from the ledger,
-- not just failing to display — rebuild_stock_balances() would reproduce
-- the same missing quantity, because the movement to create it was never
-- written in the first place.
--
-- BUG 2 — ADJUSTMENT (a deliberate miscount correction) could never take a
-- negative number. The guard clause `if p_qty <= 0 then raise exception`
-- fired before the code ever reached the line, several lines below, that
-- says `when 'ADJUSTMENT' then p_qty -- signed: the one exception` — the
-- signed behaviour was implemented but unreachable.

create or replace function record_stock_adjustment(
  p_product_id  uuid,
  p_movement_type text,
  p_qty         numeric,
  p_reason      text,
  p_cashier_id  uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_business_id uuid := auth_business_id();
  v_event_id    uuid;
  v_location_id uuid;    -- the event location (or base, if no active event)
  v_base_id     uuid;
  v_movement_id uuid := uuid_generate_v7();
  v_delta       numeric(13,3);
  v_product     products%rowtype;
  v_dual        boolean;  -- LOAD_OUT / LOAD_BACK: moves between two locations
  v_from        uuid;
  v_to          uuid;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only a supervisor or owner may adjust stock.';
  end if;

  if p_movement_type not in
     ('WASTAGE','SAMPLE','LOAD_OUT','LOAD_BACK','ADJUSTMENT','SHRINKAGE') then
    raise exception 'unsupported_movement_type: %', p_movement_type
      using errcode = '23514';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '23514',
      hint = 'Every manual stock movement needs a reason. It is audited.';
  end if;

  -- A correction is the one type where a negative number is meaningful
  -- (found LESS stock than recorded). Every other type still needs a
  -- positive quantity — direction comes from the movement type, never
  -- from the sign the person typed.
  if p_qty is null or p_qty = 0 then
    raise exception 'qty_cannot_be_zero' using errcode = '23514';
  end if;
  if p_movement_type <> 'ADJUSTMENT' and p_qty < 0 then
    raise exception 'qty_must_be_positive: %', p_movement_type
      using errcode = '23514',
      hint = 'Enter a positive quantity; direction comes from the movement type.';
  end if;

  select * into v_product from products
   where product_id = p_product_id and business_id = v_business_id;
  if not found then
    raise exception 'unknown_product' using errcode = '23503';
  end if;

  select event_id into v_event_id from events
   where business_id = v_business_id and status = 'ACTIVE';

  select location_id into v_base_id from stock_locations
   where business_id = v_business_id and kind = 'BASE' and is_active
   limit 1;

  select location_id into v_location_id from stock_locations
   where business_id = v_business_id
     and (event_id = v_event_id or (v_event_id is null and kind = 'BASE'))
     and is_active
   order by case when event_id = v_event_id then 0 else 1 end
   limit 1;

  if v_location_id is null then
    raise exception 'no_stock_location' using errcode = '23503';
  end if;

  -- LOAD_OUT and LOAD_BACK move stock BETWEEN two locations and must write
  -- both legs, exactly like record_load_out() already does correctly.
  -- Everything else (wastage, samples, a correction, shrinkage) happens at
  -- a single location and simply adjusts its balance.
  v_dual := p_movement_type in ('LOAD_OUT','LOAD_BACK')
            and v_base_id is not null and v_base_id <> v_location_id;

  if v_dual then
    if p_movement_type = 'LOAD_OUT' then
      v_from := v_base_id; v_to := v_location_id;
    else
      v_from := v_location_id; v_to := v_base_id;
    end if;

    insert into stock_movements (
      movement_id, business_id, product_id, location_id, event_id,
      movement_type, qty_delta, unit_cost_cents,
      user_id, cashier_id, reason, occurred_at, idempotency_key)
    values (
      v_movement_id, v_business_id, p_product_id, v_from, v_event_id,
      p_movement_type::movement_type, -abs(p_qty), v_product.cost_price_cents,
      auth.uid(), p_cashier_id, p_reason, now(),
      'adj:' || v_movement_id::text || ':from');

    insert into stock_movements (
      movement_id, business_id, product_id, location_id, event_id,
      movement_type, qty_delta, unit_cost_cents,
      user_id, cashier_id, reason, occurred_at, idempotency_key)
    values (
      uuid_generate_v7(), v_business_id, p_product_id, v_to, v_event_id,
      p_movement_type::movement_type, abs(p_qty), v_product.cost_price_cents,
      auth.uid(), p_cashier_id, p_reason, now(),
      'adj:' || v_movement_id::text || ':to');

    -- Reported delta is the net effect at the till-visible (event) side,
    -- which is what the on-screen log line is describing.
    v_delta := case p_movement_type when 'LOAD_OUT' then abs(p_qty) else -abs(p_qty) end;
  else
    -- Direction is a property of the movement type, never of the entered
    -- number. A cashier typing "-3" for wastage should not add stock.
    v_delta := case p_movement_type
      when 'LOAD_OUT'   then  abs(p_qty)     -- into the event location
      when 'ADJUSTMENT' then  p_qty          -- signed: the one exception
      else                   -abs(p_qty)     -- wastage, samples, load-back out
    end;

    insert into stock_movements (
      movement_id, business_id, product_id, location_id, event_id,
      movement_type, qty_delta, unit_cost_cents,
      user_id, cashier_id, reason, occurred_at, idempotency_key)
    values (
      v_movement_id, v_business_id, p_product_id, v_location_id, v_event_id,
      p_movement_type::movement_type, v_delta, v_product.cost_price_cents,
      auth.uid(), p_cashier_id, p_reason, now(),
      'adj:' || v_movement_id::text);
  end if;

  insert into audit_logs (
    business_id, actor_user_id, actor_cashier_id,
    action, entity_type, entity_id, after_state)
  values (
    v_business_id, auth.uid(), p_cashier_id,
    'STOCK_' || p_movement_type, 'product', p_product_id,
    jsonb_build_object('qty', v_delta, 'reason', p_reason,
                       'movement_id', v_movement_id,
                       'cost_cents', v_product.cost_price_cents * abs(p_qty)));

  return jsonb_build_object(
    'movement_id', v_movement_id,
    'product', v_product.name,
    'qty_delta', v_delta,
    'cost_impact_cents', v_product.cost_price_cents * abs(p_qty));
end $$;
