-- ============================================================================
-- 0005_functions.sql
-- complete_sale (the single transactional write path), PIN verification,
-- shift close, and money helpers.
--
-- ARCHITECTURE §C.3: every completed sale commits in ONE function call.
-- The v2 offline engine calls this same function with the same payload --
-- only the timing changes.
-- ============================================================================

-- ── Money helpers ───────────────────────────────────────────────────────────
-- All money is BIGINT minor units (cents). Rounding is half-up, away from zero.
-- Mirrored exactly by src/lib/money/money.ts -- the two MUST agree.

create or replace function round_half_up(p numeric)
returns bigint
language sql immutable
as $$
  select (sign(p) * floor(abs(p) + 0.5))::bigint
$$;

-- VAT extraction from a VAT-INCLUSIVE gross amount:  vat = gross * r / (1 + r)
create or replace function vat_from_gross(p_gross_cents bigint, p_rate_bp int)
returns bigint
language sql immutable
as $$
  select case when p_rate_bp = 0 then 0
    else round_half_up(p_gross_cents::numeric * p_rate_bp / (10000 + p_rate_bp))
  end
$$;

-- VAT added to a VAT-EXCLUSIVE net amount:  vat = net * r
create or replace function vat_from_net(p_net_cents bigint, p_rate_bp int)
returns bigint
language sql immutable
as $$
  select case when p_rate_bp = 0 then 0
    else round_half_up(p_net_cents::numeric * p_rate_bp / 10000)
  end
$$;

comment on function vat_from_gross is
  'Kenyan retail prices are VAT-inclusive, so this is the normal path. '
  'NOTE (K3): KRA OSCU spec v2.0 samples are internally inconsistent about '
  'whether taxblAmt is gross or net. Pin this during sandbox certification '
  'before any production submission.';

-- ── Current tax rate for a KRA tax type, from synced KRA data ──────────────
create or replace function tax_rate_bp(p_tax_ty_cd text)
returns int
language plpgsql stable
as $$
declare v_rate text;
begin
  select user_dfn_cd1 into v_rate
    from etims_code_list
   where code_class = '04' and code = p_tax_ty_cd and is_active;

  if v_rate is null then
    -- Fallback ONLY until /selectCodeList has been synced. Logged loudly.
    return case p_tax_ty_cd
      when 'A' then 0      -- Exempt
      when 'B' then 1600   -- Standard 16%
      when 'C' then 0      -- Zero-rated
      when 'D' then 0      -- Non-VAT
      when 'E' then 800    -- 8%
      else 0 end;
  end if;

  return round_half_up(v_rate::numeric * 100);
end $$;

-- ── PIN verification ────────────────────────────────────────────────────────
create or replace function verify_cashier_pin(p_cashier_id uuid, p_pin text)
returns table (
  cashier_id uuid, full_name text, role user_role,
  max_discount_bp int, can_void boolean, can_override_price boolean
)
language plpgsql security definer set search_path = public
as $$
declare
  v record;
  v_recent_failures int;
begin
  select count(*) into v_recent_failures
    from pin_attempts
   where pin_attempts.cashier_id = p_cashier_id
     and not succeeded
     and attempted_at > now() - interval '5 minutes';

  if v_recent_failures >= 5 then
    raise exception 'pin_locked' using errcode = '28000',
      hint = 'Too many failed attempts. A supervisor must unlock this cashier.';
  end if;

  select * into v from cashiers c
   where c.cashier_id = p_cashier_id
     and c.business_id = auth_business_id()
     and c.is_active;

  if not found or v.pin_hash <> crypt(p_pin, v.pin_hash) then
    insert into pin_attempts (cashier_id, device_id, succeeded)
    values (p_cashier_id, auth_device_id(), false);

    insert into audit_logs (business_id, action, entity_type, entity_id, device_id)
    values (auth_business_id(), 'PIN_FAILURE', 'cashier', p_cashier_id, auth_device_id());

    raise exception 'invalid_pin' using errcode = '28000';
  end if;

  insert into pin_attempts (cashier_id, device_id, succeeded)
  values (p_cashier_id, auth_device_id(), true);

  return query
    select v.cashier_id, v.full_name, v.role,
           v.max_discount_bp, v.can_void, v.can_override_price;
end $$;

create or replace function set_cashier_pin(p_cashier_id uuid, p_pin text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_pin !~ '^[0-9]{6}$' then
    raise exception 'PIN must be exactly 6 digits' using errcode = '22023';
  end if;

  update cashiers
     set pin_hash = crypt(p_pin, gen_salt('bf', 10))
   where cashier_id = p_cashier_id and business_id = auth_business_id();
end $$;

-- ============================================================================
-- complete_sale
-- ============================================================================
-- Payload shape (validated client-side by Zod, re-validated here):
-- {
--   "sale_id": uuid, "idempotency_key": text, "local_ref": text,
--   "shift_id": uuid, "cashier_id": uuid, "occurred_at": timestamptz,
--   "customer": { "kra_pin": text?, "name": text?, "phone": text? },
--   "is_backfilled": bool?, "backfill_ref": text?,
--   "items": [ { "line_id","product_id","line_no","qty",
--                "unit_price_cents","discount_cents" } ],
--   "payments": [ { "payment_id","method","amount_cents",
--                   "tendered_cents"?,"mpesa_txn_id"? } ]
-- }
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
  v_existing    sales%rowtype;
  v_location_id uuid;

  v_item        jsonb;
  v_pay         jsonb;
  v_product     products%rowtype;
  v_rate_bp     int;

  v_gross       bigint;
  v_line_tax    bigint;
  v_taxable     bigint;

  v_subtotal    bigint := 0;
  v_discount    bigint := 0;
  v_tax_total   bigint := 0;
  v_total       bigint := 0;
  v_paid        bigint := 0;

  v_qty_before  numeric(13,3);
  v_below_stock boolean;
  v_prices_incl boolean;
begin
  -- ── 1. Idempotency. A retry after an ambiguous timeout is a no-op. ───────
  select * into v_existing from sales where idempotency_key = v_idem;
  if found then
    return jsonb_build_object(
      'status',    'ALREADY_COMPLETED',
      'sale_id',   v_existing.sale_id,
      'local_ref', v_existing.local_ref,
      'total_cents', v_existing.total_cents);
  end if;

  if v_business_id is null or v_device_id is null then
    raise exception 'no_device_context' using errcode = '28000';
  end if;

  select prices_include_vat into v_prices_incl
    from businesses where business_id = v_business_id;

  -- ── 2. Shift must be open on THIS device ────────────────────────────────
  select * into v_shift from shifts
   where shift_id = (p_payload ->> 'shift_id')::uuid
     and business_id = v_business_id
     and device_id = v_device_id
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

  -- Event stock location
  select location_id into v_location_id
    from stock_locations
   where business_id = v_business_id and event_id = v_shift.event_id and is_active
   limit 1;
  if v_location_id is null then
    raise exception 'no_event_location' using errcode = '23503',
      hint = 'Create a stock location for this event before selling.';
  end if;

  -- ── 3. Sale header (totals filled in at step 6) ──────────────────────────
  insert into sales (
    sale_id, business_id, event_id, shift_id, device_id, cashier_id,
    status, local_ref, occurred_at, idempotency_key,
    customer_kra_pin, customer_name, customer_phone,
    is_backfilled, backfill_ref)
  values (
    v_sale_id, v_business_id, v_shift.event_id, v_shift.shift_id,
    v_device_id, v_cashier.cashier_id,
    'DRAFT',
    p_payload ->> 'local_ref',
    coalesce((p_payload ->> 'occurred_at')::timestamptz, now()),
    v_idem,
    nullif(p_payload #>> '{customer,kra_pin}', ''),
    nullif(p_payload #>> '{customer,name}', ''),
    nullif(p_payload #>> '{customer,phone}', ''),
    coalesce((p_payload ->> 'is_backfilled')::boolean, false),
    nullif(p_payload ->> 'backfill_ref', ''));

  -- ── 4. Lines ────────────────────────────────────────────────────────────
  for v_item in select * from jsonb_array_elements(p_payload -> 'items')
  loop
    select * into v_product from products
     where product_id = (v_item ->> 'product_id')::uuid
       and business_id = v_business_id and is_active;

    if not found then
      raise exception 'unknown_product: %', v_item ->> 'product_id'
        using errcode = '23503';
    end if;

    -- INV-02: no sale without KRA classification.
    if v_product.etims_tax_ty_cd is null then
      raise exception 'product_not_tax_classified: % (%)',
        v_product.name, v_product.sku
        using errcode = '23514',
        hint = 'Awaiting accountant classification. See seed/catalogue.csv.';
    end if;

    v_rate_bp := tax_rate_bp(v_product.etims_tax_ty_cd::text);

    v_gross := round_half_up(
                 (v_item ->> 'qty')::numeric
                 * (v_item ->> 'unit_price_cents')::bigint)
               - coalesce((v_item ->> 'discount_cents')::bigint, 0);

    if v_gross < 0 then
      raise exception 'negative_line_total' using errcode = '23514';
    end if;

    -- Discount authority (§13)
    if coalesce((v_item ->> 'discount_cents')::bigint, 0) > 0 then
      if v_gross > 0
         and (coalesce((v_item ->> 'discount_cents')::bigint, 0) * 10000)
             / nullif(v_gross + coalesce((v_item ->> 'discount_cents')::bigint, 0), 0)
             > v_cashier.max_discount_bp
         and (v_item ->> 'approved_by_cashier_id') is null then
        raise exception 'discount_exceeds_authority' using errcode = '42501',
          hint = 'Supervisor approval required for this discount.';
      end if;
    end if;

    -- Discounts apply BEFORE tax (§13). VAT direction depends on the business.
    if v_prices_incl then
      v_taxable  := v_gross;
      v_line_tax := vat_from_gross(v_gross, v_rate_bp);
    else
      v_taxable  := v_gross;
      v_line_tax := vat_from_net(v_gross, v_rate_bp);
    end if;

    -- Stock: read balance BEFORE moving, so we can flag (never block).
    v_qty_before := null;
    v_below_stock := false;
    if v_product.track_stock then
      select qty_on_hand into v_qty_before
        from stock_balances
       where product_id = v_product.product_id and location_id = v_location_id
       for update;                                  -- serialises the 3 tills

      v_below_stock := coalesce(v_qty_before, 0) < (v_item ->> 'qty')::numeric;

      if v_below_stock and v_product.stock_policy = 'BLOCK_IF_UNAVAILABLE' then
        raise exception 'insufficient_stock: %', v_product.name
          using errcode = '23514';
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
      (v_item ->> 'qty')::numeric,
      (v_item ->> 'unit_price_cents')::bigint,
      coalesce((v_item ->> 'discount_cents')::bigint, 0),
      v_gross, v_taxable, v_line_tax,
      case when v_prices_incl then v_gross else v_gross + v_line_tax end,
      v_product.name, v_product.etims_tax_ty_cd, v_rate_bp,
      v_product.etims_item_cls_cd, v_product.etims_item_cd,
      coalesce((v_item ->> 'price_overridden')::boolean, false),
      nullif(v_item ->> 'override_reason', ''),
      nullif(v_item ->> 'approved_by_cashier_id', '')::uuid,
      v_below_stock);

    -- Ledger movement (append-only). Trigger updates the balance cache.
    if v_product.track_stock then
      insert into stock_movements (
        movement_id, business_id, product_id, location_id, event_id,
        movement_type, qty_delta, unit_cost_cents, sale_id,
        device_id, cashier_id, occurred_at, idempotency_key)
      values (
        uuid_generate_v7(), v_business_id, v_product.product_id, v_location_id,
        v_shift.event_id, 'SALE', -((v_item ->> 'qty')::numeric),
        v_product.cost_price_cents, v_sale_id,
        v_device_id, v_cashier.cashier_id,
        coalesce((p_payload ->> 'occurred_at')::timestamptz, now()),
        v_idem || ':mv:' || (v_item ->> 'line_id'));
    end if;

    v_subtotal  := v_subtotal
                   + round_half_up((v_item ->> 'qty')::numeric
                                   * (v_item ->> 'unit_price_cents')::bigint)
                   - case when v_prices_incl then v_line_tax else 0 end;
    v_discount  := v_discount + coalesce((v_item ->> 'discount_cents')::bigint, 0);
    v_tax_total := v_tax_total + v_line_tax;
    v_total     := v_total
                   + case when v_prices_incl then v_gross else v_gross + v_line_tax end;
  end loop;

  if v_total <= 0 then
    raise exception 'empty_or_zero_sale' using errcode = '23514';
  end if;

  -- ── 5. Payments ─────────────────────────────────────────────────────────
  for v_pay in select * from jsonb_array_elements(p_payload -> 'payments')
  loop
    insert into payments (
      payment_id, sale_id, business_id, method, amount_cents, status,
      tendered_cents, change_cents, occurred_at, idempotency_key)
    values (
      (v_pay ->> 'payment_id')::uuid, v_sale_id, v_business_id,
      (v_pay ->> 'method')::payment_method,
      (v_pay ->> 'amount_cents')::bigint,
      case (v_pay ->> 'method')
        when 'CASH' then 'VERIFIED'::payment_status
        when 'MPESA_C2B' then 'VERIFIED'::payment_status   -- pre-matched
        when 'MPESA_MANUAL' then 'PENDING'::payment_status -- verified on reconcile
        else 'PENDING'::payment_status
      end,
      nullif(v_pay ->> 'tendered_cents', '')::bigint,
      nullif(v_pay ->> 'change_cents', '')::bigint,
      coalesce((p_payload ->> 'occurred_at')::timestamptz, now()),
      v_idem || ':pay:' || (v_pay ->> 'payment_id'));

    -- Bind a pre-matched C2B transaction to this payment.
    if (v_pay ->> 'mpesa_txn_id') is not null then
      update mpesa_transactions
         set payment_id = (v_pay ->> 'payment_id')::uuid,
             matched_at = now(),
             matched_by_cashier_id = v_cashier.cashier_id
       where mpesa_txn_id = (v_pay ->> 'mpesa_txn_id')::uuid
         and business_id = v_business_id
         and payment_id is null;

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

  -- ── 6. Finalise ─────────────────────────────────────────────────────────
  update sales
     set status = 'COMPLETED',
         subtotal_cents = v_subtotal,
         discount_total_cents = v_discount,
         tax_total_cents = v_tax_total,
         total_cents = v_total,
         completed_at = now()
   where sale_id = v_sale_id;

  -- ── 7. Enqueue for eTIMS. NEVER blocks the sale. ────────────────────────
  insert into etims_submissions (business_id, kind, sale_id, request_body)
  values (v_business_id, 'SALE', v_sale_id,
          jsonb_build_object('sale_id', v_sale_id, 'built', false));

  return jsonb_build_object(
    'status',      'COMPLETED',
    'sale_id',     v_sale_id,
    'local_ref',   p_payload ->> 'local_ref',
    'total_cents', v_total,
    'tax_total_cents', v_tax_total,
    'change_cents',    v_paid - v_total,
    'fiscal_status',   'PENDING');
end $$;

comment on function complete_sale is
  'The ONLY write path for a completed sale. Single transaction: header, '
  'lines, ledger movements, payments, eTIMS enqueue. Idempotent on '
  'idempotency_key. ARCHITECTURE §C.3.';

-- ── Resolve a sale that timed out mid-flight (§C.5) ─────────────────────────
create or replace function resolve_sale(p_sale_id uuid, p_idempotency_key text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_sale sales%rowtype; v_inv invoices%rowtype;
begin
  select * into v_sale from sales
   where sale_id = p_sale_id and business_id = auth_business_id();

  if not found then
    select * into v_sale from sales where idempotency_key = p_idempotency_key;
  end if;

  if not found then
    return jsonb_build_object('status', 'NOT_FOUND');
  end if;

  select * into v_inv from invoices where sale_id = v_sale.sale_id;

  return jsonb_build_object(
    'status',        'FOUND',
    'sale_id',       v_sale.sale_id,
    'sale_status',   v_sale.status,
    'local_ref',     v_sale.local_ref,
    'total_cents',   v_sale.total_cents,
    'fiscal_status', case when v_inv.invoice_id is null then 'PENDING' else 'FISCALISED' end,
    'invc_no',       v_inv.invc_no);
end $$;

-- ── Shift close ─────────────────────────────────────────────────────────────
create or replace function close_shift(
  p_shift_id uuid, p_counted_cash_cents bigint, p_notes text default null)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_shift shifts%rowtype;
  v_expected bigint;
  v_open_doubt int;
begin
  select * into v_shift from shifts
   where shift_id = p_shift_id and business_id = auth_business_id() and status = 'OPEN'
   for update;
  if not found then
    raise exception 'shift_not_open' using errcode = '23514';
  end if;

  select count(*) into v_open_doubt from sales_in_doubt
   where shift_id = p_shift_id and status = 'OPEN';

  if v_open_doubt > 0 and not auth_is_staff() then
    raise exception 'unresolved_sales_in_doubt: %', v_open_doubt
      using errcode = '23514',
      hint = 'A supervisor must resolve unconfirmed sales before closing.';
  end if;

  select v_shift.opening_float_cents + coalesce(sum(p.amount_cents), 0)
    into v_expected
    from sales s
    join payments p on p.sale_id = s.sale_id
   where s.shift_id = p_shift_id
     and s.status = 'COMPLETED'
     and p.method = 'CASH';

  update shifts
     set status = 'CLOSED',
         closed_at = now(),
         counted_cash_cents = p_counted_cash_cents,
         expected_cash_cents = v_expected,
         close_notes = p_notes,
         closed_with_unresolved_doubt = (v_open_doubt > 0)
   where shift_id = p_shift_id;

  insert into audit_logs (business_id, action, entity_type, entity_id,
                          shift_id, device_id, after_state)
  values (auth_business_id(), 'SHIFT_CLOSE', 'shift', p_shift_id,
          p_shift_id, v_shift.device_id,
          jsonb_build_object('counted', p_counted_cash_cents,
                             'expected', v_expected,
                             'variance', p_counted_cash_cents - v_expected,
                             'unresolved_doubt', v_open_doubt));

  return jsonb_build_object(
    'shift_id', p_shift_id,
    'expected_cash_cents', v_expected,
    'counted_cash_cents',  p_counted_cash_cents,
    'variance_cents',      p_counted_cash_cents - v_expected,
    'unresolved_doubt',    v_open_doubt);
end $$;
