-- ============================================================================
-- 0008_event_pricing.sql
--
-- Event-specific pricing, set by admin/supervisor, plus a security fix:
-- complete_sale() now RESOLVES prices server-side instead of trusting the
-- client. Any client-supplied price that differs from the resolved price is
-- treated as a price override and requires explicit authority.
--
-- Why this matters: before this migration a tampered client could post
-- unit_price_cents = 1 and the server would accept it. Price overrides are a
-- legitimate feature (SAL-02), so the fix is not to forbid them — it is to
-- make them explicit, authorised and audited.
-- ============================================================================

create table event_prices (
  event_price_id uuid primary key default uuid_generate_v7(),
  business_id    uuid not null references businesses on delete cascade,
  event_id       uuid not null references events on delete cascade,
  product_id     uuid not null references products on delete cascade,
  price_cents    bigint not null check (price_cents >= 0),
  note           text,
  set_by_user_id uuid references users,
  set_at         timestamptz not null default now(),
  unique (event_id, product_id)
);

create index event_prices_lookup on event_prices (event_id, product_id);

comment on table event_prices is
  'Overrides products.selling_price_cents for a specific event. Absent row = '
  'use the base price. Prices are VAT-INCLUSIVE, matching the base price.';

-- Price changes are audited: a mid-event price change is exactly the kind of
-- thing that needs a paper trail.
create or replace function audit_event_price_change()
returns trigger
language plpgsql
as $$
begin
  insert into audit_logs (
    business_id, actor_user_id, action, entity_type, entity_id,
    before_state, after_state)
  values (
    coalesce(new.business_id, old.business_id),
    coalesce(new.set_by_user_id, old.set_by_user_id),
    case tg_op when 'INSERT' then 'EVENT_PRICE_SET'
               when 'UPDATE' then 'EVENT_PRICE_CHANGED'
               else 'EVENT_PRICE_REMOVED' end,
    'event_price',
    coalesce(new.event_price_id, old.event_price_id),
    case when old is null then null
         else jsonb_build_object('product_id', old.product_id,
                                 'price_cents', old.price_cents) end,
    case when new is null then null
         else jsonb_build_object('product_id', new.product_id,
                                 'price_cents', new.price_cents) end);
  return coalesce(new, old);
end $$;

create trigger event_prices_audited
  after insert or update or delete on event_prices
  for each row execute function audit_event_price_change();

alter table event_prices enable row level security;

create policy event_prices_select on event_prices for select to authenticated
  using (business_id = auth_business_id());

-- Only the supervisor/owner sets prices. Cashiers read them.
create policy event_prices_write on event_prices for all to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id() and auth_is_staff());

-- ── Effective price resolution ──────────────────────────────────────────────

create or replace function effective_price(p_event_id uuid, p_product_id uuid)
returns bigint
language sql stable
as $$
  select coalesce(
    (select ep.price_cents from event_prices ep
      where ep.event_id = p_event_id and ep.product_id = p_product_id),
    (select p.selling_price_cents from products p
      where p.product_id = p_product_id))
$$;

/**
 * The till's price list for an event. One call at shift open; the result is
 * held in memory so scanning and pricing never touch the network.
 */
create or replace function event_price_list(p_event_id uuid)
returns table (
  product_id uuid, sku text, name text, short_name text,
  category_id uuid, category_name text, uom text,
  price_cents bigint, base_price_cents bigint, is_event_price boolean,
  tax_ty_cd tax_type_code, tax_rate_bp int,
  item_cls_cd text, item_cd text, track_stock boolean,
  qty_on_hand numeric, image_path text, tile_order int, sellable boolean
)
language sql stable security definer set search_path = public
as $$
  select
    p.product_id, p.sku, p.name, coalesce(p.short_name, p.name),
    p.category_id, c.name, p.uom,
    coalesce(ep.price_cents, p.selling_price_cents),
    p.selling_price_cents,
    ep.price_cents is not null,
    p.etims_tax_ty_cd,
    tax_rate_bp(p.etims_tax_ty_cd::text),
    p.etims_item_cls_cd, p.etims_item_cd, p.track_stock,
    coalesce(sb.qty_on_hand, 0), p.image_path, p.tile_order,
    p.etims_tax_ty_cd is not null
  from products p
  left join categories c on c.category_id = p.category_id
  left join event_prices ep
    on ep.product_id = p.product_id and ep.event_id = p_event_id
  left join stock_locations sl
    on sl.event_id = p_event_id and sl.is_active
  left join stock_balances sb
    on sb.product_id = p.product_id and sb.location_id = sl.location_id
  where p.business_id = (select business_id from events where event_id = p_event_id)
    and p.is_active
  order by p.tile_order, p.name
$$;

grant execute on function effective_price(uuid, uuid)  to authenticated;
grant execute on function event_price_list(uuid)       to authenticated;

-- ── Bulk price setting, for the supervisor's event-pricing screen ──────────
create or replace function set_event_prices(p_event_id uuid, p_prices jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_business_id uuid;
  v_user_id uuid := auth.uid();
  v_row jsonb;
  v_count int := 0;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only a supervisor or owner may set event prices.';
  end if;

  select business_id into v_business_id from events
   where event_id = p_event_id and business_id = auth_business_id();
  if not found then
    raise exception 'unknown_event' using errcode = '23503';
  end if;

  for v_row in select * from jsonb_array_elements(p_prices)
  loop
    if (v_row ->> 'price_cents') is null then
      delete from event_prices
       where event_id = p_event_id
         and product_id = (v_row ->> 'product_id')::uuid;
    else
      insert into event_prices (
        business_id, event_id, product_id, price_cents, note, set_by_user_id)
      values (
        v_business_id, p_event_id, (v_row ->> 'product_id')::uuid,
        (v_row ->> 'price_cents')::bigint, nullif(v_row ->> 'note',''), v_user_id)
      on conflict (event_id, product_id) do update
        set price_cents = excluded.price_cents,
            note = excluded.note,
            set_by_user_id = excluded.set_by_user_id,
            set_at = now();
    end if;
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('event_id', p_event_id, 'updated', v_count);
end $$;

grant execute on function set_event_prices(uuid, jsonb) to authenticated;

-- ── Copy pricing from a previous event (supervisors set up fast) ───────────
create or replace function copy_event_prices(p_from_event_id uuid, p_to_event_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_count int;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into event_prices (business_id, event_id, product_id, price_cents,
                            note, set_by_user_id)
  select business_id, p_to_event_id, product_id, price_cents,
         'copied from previous event', auth.uid()
    from event_prices
   where event_id = p_from_event_id
     and business_id = auth_business_id()
  on conflict (event_id, product_id) do update
    set price_cents = excluded.price_cents, set_at = now();

  get diagnostics v_count = row_count;
  return jsonb_build_object('copied', v_count);
end $$;

grant execute on function copy_event_prices(uuid, uuid) to authenticated;

-- ============================================================================
-- complete_sale v2 — server-authoritative pricing
-- ============================================================================
create or replace function complete_sale(p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_business_id uuid := auth_business_id();
  v_device_id   uuid := auth_device_id();
  v_sale_id     uuid := (p_payload ->> 'sale_id')::uuid;
  v_idem        text := p_payload ->> 'idempotency_key';
  v_shift       shifts%rowtype;
  v_cashier     cashiers%rowtype;
  v_approver    cashiers%rowtype;
  v_existing    sales%rowtype;
  v_location_id uuid;

  v_item    jsonb;
  v_pay     jsonb;
  v_product products%rowtype;
  v_rate_bp int;

  v_resolved_price bigint;
  v_claimed_price  bigint;
  v_overridden     boolean;

  v_gross    bigint;
  v_line_tax bigint;
  v_taxable  bigint;
  v_discount_bp int;

  v_subtotal  bigint := 0;
  v_discount  bigint := 0;
  v_tax_total bigint := 0;
  v_total     bigint := 0;
  v_paid      bigint := 0;

  v_qty_before  numeric(13,3);
  v_below_stock boolean;
  v_prices_incl boolean;
begin
  -- 1. Idempotency
  select * into v_existing from sales where idempotency_key = v_idem;
  if found then
    return jsonb_build_object(
      'status','ALREADY_COMPLETED', 'sale_id', v_existing.sale_id,
      'local_ref', v_existing.local_ref, 'total_cents', v_existing.total_cents);
  end if;

  if v_business_id is null or v_device_id is null then
    raise exception 'no_device_context' using errcode = '28000';
  end if;

  select prices_include_vat into v_prices_incl
    from businesses where business_id = v_business_id;

  -- 2. Shift
  select * into v_shift from shifts
   where shift_id = (p_payload ->> 'shift_id')::uuid
     and business_id = v_business_id and device_id = v_device_id
     and status = 'OPEN'
   for update;
  if not found then
    raise exception 'no_open_shift' using errcode = '23514',
      hint = 'Open a shift on this till before selling.';
  end if;

  select * into v_cashier from cashiers
   where cashier_id = (p_payload ->> 'cashier_id')::uuid
     and business_id = v_business_id and is_active;
  if not found then
    raise exception 'invalid_cashier' using errcode = '23503';
  end if;

  select location_id into v_location_id from stock_locations
   where business_id = v_business_id and event_id = v_shift.event_id and is_active
   limit 1;
  if v_location_id is null then
    raise exception 'no_event_location' using errcode = '23503',
      hint = 'Create a stock location for this event before selling.';
  end if;

  -- 3. Header
  insert into sales (
    sale_id, business_id, event_id, shift_id, device_id, cashier_id,
    status, local_ref, occurred_at, idempotency_key,
    customer_kra_pin, customer_name, customer_phone, is_backfilled, backfill_ref)
  values (
    v_sale_id, v_business_id, v_shift.event_id, v_shift.shift_id,
    v_device_id, v_cashier.cashier_id, 'DRAFT',
    p_payload ->> 'local_ref',
    coalesce((p_payload ->> 'occurred_at')::timestamptz, now()), v_idem,
    nullif(p_payload #>> '{customer,kra_pin}',''),
    nullif(p_payload #>> '{customer,name}',''),
    nullif(p_payload #>> '{customer,phone}',''),
    coalesce((p_payload ->> 'is_backfilled')::boolean, false),
    nullif(p_payload ->> 'backfill_ref',''));

  -- 4. Lines
  for v_item in select * from jsonb_array_elements(p_payload -> 'items')
  loop
    select * into v_product from products
     where product_id = (v_item ->> 'product_id')::uuid
       and business_id = v_business_id and is_active;
    if not found then
      raise exception 'unknown_product: %', v_item ->> 'product_id'
        using errcode = '23503';
    end if;

    if v_product.etims_tax_ty_cd is null then
      raise exception 'product_not_tax_classified: % (%)', v_product.name, v_product.sku
        using errcode = '23514',
        hint = 'Awaiting accountant classification. See supabase/seed/README.md.';
    end if;

    v_rate_bp := tax_rate_bp(v_product.etims_tax_ty_cd::text);

    -- ── SERVER RESOLVES THE PRICE. The client does not get to decide. ─────
    v_resolved_price := effective_price(v_shift.event_id, v_product.product_id);
    v_claimed_price  := coalesce((v_item ->> 'unit_price_cents')::bigint,
                                 v_resolved_price);
    v_overridden := v_claimed_price <> v_resolved_price;

    if v_overridden then
      -- A different price is an OVERRIDE and needs a supervisor (SAL-02).
      if (v_item ->> 'approved_by_cashier_id') is null then
        raise exception
          'price_override_requires_approval: % (list %, entered %)',
          v_product.name, v_resolved_price, v_claimed_price
          using errcode = '42501',
          hint = 'Supervisor approval is required to change a price.';
      end if;

      select * into v_approver from cashiers
       where cashier_id = (v_item ->> 'approved_by_cashier_id')::uuid
         and business_id = v_business_id and is_active;

      if not found or not v_approver.can_override_price then
        raise exception 'approver_cannot_override_price' using errcode = '42501';
      end if;

      insert into audit_logs (
        business_id, actor_cashier_id, device_id, shift_id,
        action, entity_type, entity_id, before_state, after_state)
      values (
        v_business_id, v_cashier.cashier_id, v_device_id, v_shift.shift_id,
        'PRICE_OVERRIDE', 'product', v_product.product_id,
        jsonb_build_object('list_price_cents', v_resolved_price),
        jsonb_build_object('charged_cents', v_claimed_price,
                           'approved_by', v_approver.cashier_id,
                           'reason', v_item ->> 'override_reason',
                           'sale_id', v_sale_id));
    end if;

    v_gross := round_half_up((v_item ->> 'qty')::numeric * v_claimed_price)
               - coalesce((v_item ->> 'discount_cents')::bigint, 0);
    if v_gross < 0 then
      raise exception 'negative_line_total' using errcode = '23514';
    end if;

    -- Discount authority, in basis points of the pre-discount line.
    if coalesce((v_item ->> 'discount_cents')::bigint, 0) > 0 then
      v_discount_bp := (coalesce((v_item ->> 'discount_cents')::bigint, 0) * 10000)
                       / nullif(round_half_up((v_item ->> 'qty')::numeric * v_claimed_price), 0);

      if v_discount_bp > v_cashier.max_discount_bp then
        if (v_item ->> 'approved_by_cashier_id') is null then
          raise exception 'discount_exceeds_authority: %.2f%% > %.2f%%',
            v_discount_bp / 100.0, v_cashier.max_discount_bp / 100.0
            using errcode = '42501',
            hint = 'Supervisor approval is required for this discount.';
        end if;

        select * into v_approver from cashiers
         where cashier_id = (v_item ->> 'approved_by_cashier_id')::uuid
           and business_id = v_business_id and is_active;

        if not found or v_discount_bp > v_approver.max_discount_bp then
          raise exception 'approver_discount_authority_insufficient'
            using errcode = '42501';
        end if;

        insert into audit_logs (
          business_id, actor_cashier_id, device_id, shift_id,
          action, entity_type, entity_id, after_state)
        values (
          v_business_id, v_cashier.cashier_id, v_device_id, v_shift.shift_id,
          'DISCOUNT_APPROVED', 'product', v_product.product_id,
          jsonb_build_object('discount_bp', v_discount_bp,
                             'approved_by', v_approver.cashier_id,
                             'sale_id', v_sale_id));
      end if;
    end if;

    if v_prices_incl then
      v_taxable  := v_gross;
      v_line_tax := vat_from_gross(v_gross, v_rate_bp);
    else
      v_taxable  := v_gross;
      v_line_tax := vat_from_net(v_gross, v_rate_bp);
    end if;

    v_qty_before := null; v_below_stock := false;
    if v_product.track_stock then
      select qty_on_hand into v_qty_before from stock_balances
       where product_id = v_product.product_id and location_id = v_location_id
       for update;
      v_below_stock := coalesce(v_qty_before, 0) < (v_item ->> 'qty')::numeric;

      if v_below_stock and v_product.stock_policy = 'BLOCK_IF_UNAVAILABLE' then
        raise exception 'insufficient_stock: %', v_product.name using errcode = '23514';
      end if;
    end if;

    insert into sale_items (
      line_id, sale_id, business_id, product_id, line_no,
      qty, unit_price_cents, discount_cents,
      gross_cents, taxable_amount_cents, tax_amount_cents, line_total_cents,
      product_name, tax_ty_cd, tax_rate_bp, item_cls_cd, item_cd,
      price_overridden, override_reason, approved_by_cashier_id,
      sold_below_recorded_stock)
    values (
      (v_item ->> 'line_id')::uuid, v_sale_id, v_business_id,
      v_product.product_id, (v_item ->> 'line_no')::int,
      (v_item ->> 'qty')::numeric, v_claimed_price,
      coalesce((v_item ->> 'discount_cents')::bigint, 0),
      v_gross, v_taxable, v_line_tax,
      case when v_prices_incl then v_gross else v_gross + v_line_tax end,
      v_product.name, v_product.etims_tax_ty_cd, v_rate_bp,
      v_product.etims_item_cls_cd, v_product.etims_item_cd,
      v_overridden, nullif(v_item ->> 'override_reason',''),
      nullif(v_item ->> 'approved_by_cashier_id','')::uuid,
      v_below_stock);

    if v_product.track_stock then
      insert into stock_movements (
        movement_id, business_id, product_id, location_id, event_id,
        movement_type, qty_delta, unit_cost_cents, sale_id,
        device_id, cashier_id, occurred_at, idempotency_key)
      values (
        uuid_generate_v7(), v_business_id, v_product.product_id, v_location_id,
        v_shift.event_id, 'SALE', -((v_item ->> 'qty')::numeric),
        v_product.cost_price_cents, v_sale_id, v_device_id, v_cashier.cashier_id,
        coalesce((p_payload ->> 'occurred_at')::timestamptz, now()),
        v_idem || ':mv:' || (v_item ->> 'line_id'));
    end if;

    v_subtotal  := v_subtotal
                   + round_half_up((v_item ->> 'qty')::numeric * v_claimed_price)
                   - case when v_prices_incl then v_line_tax else 0 end;
    v_discount  := v_discount + coalesce((v_item ->> 'discount_cents')::bigint, 0);
    v_tax_total := v_tax_total + v_line_tax;
    v_total     := v_total
                   + case when v_prices_incl then v_gross else v_gross + v_line_tax end;
  end loop;

  if v_total <= 0 then
    raise exception 'empty_or_zero_sale' using errcode = '23514';
  end if;

  -- 5. Payments
  for v_pay in select * from jsonb_array_elements(p_payload -> 'payments')
  loop
    insert into payments (
      payment_id, sale_id, business_id, method, amount_cents, status,
      tendered_cents, change_cents, occurred_at, idempotency_key)
    values (
      (v_pay ->> 'payment_id')::uuid, v_sale_id, v_business_id,
      (v_pay ->> 'method')::payment_method, (v_pay ->> 'amount_cents')::bigint,
      case (v_pay ->> 'method')
        when 'CASH' then 'VERIFIED'::payment_status
        when 'MPESA_C2B' then 'VERIFIED'::payment_status
        when 'MPESA_MANUAL' then 'PENDING'::payment_status
        else 'PENDING'::payment_status end,
      nullif(v_pay ->> 'tendered_cents','')::bigint,
      nullif(v_pay ->> 'change_cents','')::bigint,
      coalesce((p_payload ->> 'occurred_at')::timestamptz, now()),
      v_idem || ':pay:' || (v_pay ->> 'payment_id'));

    if (v_pay ->> 'mpesa_txn_id') is not null then
      update mpesa_transactions
         set payment_id = (v_pay ->> 'payment_id')::uuid,
             matched_at = now(), matched_by_cashier_id = v_cashier.cashier_id
       where mpesa_txn_id = (v_pay ->> 'mpesa_txn_id')::uuid
         and business_id = v_business_id and payment_id is null;
      if not found then
        raise exception 'mpesa_already_matched' using errcode = '23505',
          hint = 'That M-Pesa payment is already attached to another sale.';
      end if;
    end if;

    v_paid := v_paid + (v_pay ->> 'amount_cents')::bigint;
  end loop;

  if v_paid < v_total then
    raise exception 'underpaid: expected %, got %', v_total, v_paid
      using errcode = '23514';
  end if;

  -- 6. Finalise
  update sales
     set status = 'COMPLETED', subtotal_cents = v_subtotal,
         discount_total_cents = v_discount, tax_total_cents = v_tax_total,
         total_cents = v_total, completed_at = now()
   where sale_id = v_sale_id;

  -- 7. Enqueue for eTIMS. Never blocks the sale.
  insert into etims_submissions (business_id, kind, sale_id, request_body)
  values (v_business_id, 'SALE', v_sale_id,
          jsonb_build_object('sale_id', v_sale_id, 'built', false));

  return jsonb_build_object(
    'status','COMPLETED', 'sale_id', v_sale_id,
    'local_ref', p_payload ->> 'local_ref',
    'total_cents', v_total, 'tax_total_cents', v_tax_total,
    'change_cents', v_paid - v_total, 'fiscal_status','PENDING');
end $$;

comment on function complete_sale is
  'The ONLY write path for a completed sale. Prices are resolved SERVER-SIDE '
  'from event_prices/products; a differing client price is an override that '
  'requires supervisor authority and is audited. ARCHITECTURE §C.3.';
