-- 0035_atomic_local_ref.sql
--
-- Fixes: "duplicate key value violates unique constraint
-- sales_business_id_local_ref_key" on complete_sale.
--
-- ROOT CAUSE: local_ref (e.g. TILL-01-000071) was generated CLIENT-SIDE, in
-- TillBoot.tsx, as `count(sales where device_id = X) + 1` -- computed once
-- at shift boot and then advanced only in local React state afterwards.
-- complete_sale() then trusted whatever the client sent and inserted it
-- directly, with only the raw unique constraint as a backstop.
--
-- A plain "count rows, add one" sequence is not safe under concurrency, and
-- does not need anything unusual to break it -- the ordinary case is enough:
--
--   1. Two sessions boot for the same till around the same time (a second
--      browser tab, a phone left signed in alongside the laptop, or simply
--      reopening the PWA while an old tab is still alive) and both COUNT
--      the same set of existing sales before either one has completed a
--      new one. Both compute the same "next" number.
--   2. A tab reloads BEFORE a sale it just attempted has committed (a slow
--      request, a brief drop) and re-derives the same number the still-
--      pending attempt already claimed, because the count has not moved.
--
-- Neither of these is exotic; both become likely simply from a device
-- running for a full trading day.
--
-- FIX: mint local_ref ATOMICALLY, server-side, inside complete_sale()
-- itself, from a per-device counter table with UPSERT semantics. Two
-- concurrent callers for the same device now serialise on that row's lock
-- rather than both reading the same "next" value independently -- which is
-- exactly the property COUNT(*) could never provide. The client's own guess
-- is kept only so the cart has SOMETHING to display while it is being
-- built, before any server round trip; it is discarded the moment the sale
-- actually commits, and the RETURNED value is what the receipt must show.

create table if not exists device_sale_counters (
  device_id uuid primary key references devices(device_id),
  next_seq  bigint not null default 1
);

alter table device_sale_counters enable row level security;

create policy device_sale_counters_staff_read on device_sale_counters
  for select to authenticated using (
    device_id in (select device_id from devices where business_id = auth_business_id())
  );

-- Only complete_sale() (SECURITY DEFINER) may write here.
revoke insert, update, delete on device_sale_counters from authenticated, anon;

comment on table device_sale_counters is
  'One row per device. next_seq is the next local_ref suffix to hand out, '
  'advanced atomically by complete_sale() via an UPSERT. Never written to '
  'directly -- see 0035_atomic_local_ref.sql for why a plain count() was '
  'not safe here.';

-- ── Backfill: seed every existing device past its highest USED number ─────
-- so the new counter cannot immediately collide with sales that already
-- exist from before this migration.
insert into device_sale_counters (device_id, next_seq)
select
  d.device_id,
  coalesce(
    (select max((regexp_match(s.local_ref, '(\d+)$'))[1]::bigint) + 1
       from sales s where s.device_id = d.device_id),
    1)
  from devices d
on conflict (device_id) do update
  set next_seq = greatest(device_sale_counters.next_seq, excluded.next_seq);

create or replace function complete_sale(p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_business_id uuid := auth_business_id();
  v_device_id   uuid := auth_device_id();
  v_sale_id     uuid := (p_payload ->> 'sale_id')::uuid;
  v_idem        text := p_payload ->> 'idempotency_key';
  v_local_ref   text;
  v_seq         bigint;
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
  v_mpesa   mpesa_transactions%rowtype;
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
  --
  -- local_ref is minted HERE, atomically, per device -- never trusted from
  -- the client. The client's own guess (used only so the cart has something
  -- to display WHILE it is being built, before any server round trip) is
  -- discarded. An UPSERT with ON CONFLICT DO UPDATE serialises correctly
  -- under concurrent callers for the same device: two tills racing on this
  -- row block on the row lock rather than both reading the same "next"
  -- value the way two independent COUNT(*) queries could.
  insert into device_sale_counters (device_id, next_seq)
  values (v_device_id, 2)
  on conflict (device_id) do update
    set next_seq = device_sale_counters.next_seq + 1
  returning next_seq - 1 into v_seq;

  v_local_ref := (select code from devices where device_id = v_device_id)
                 || '-' || lpad(v_seq::text, 6, '0');

  insert into sales (
    sale_id, business_id, event_id, shift_id, device_id, cashier_id,
    status, local_ref, occurred_at, idempotency_key,
    customer_kra_pin, customer_name, customer_phone, is_backfilled, backfill_ref)
  values (
    v_sale_id, v_business_id, v_shift.event_id, v_shift.shift_id,
    v_device_id, v_cashier.cashier_id, 'DRAFT',
    v_local_ref,
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
      tendered_cents, change_cents, occurred_at, idempotency_key,
      card_reference)
    values (
      (v_pay ->> 'payment_id')::uuid, v_sale_id, v_business_id,
      (v_pay ->> 'method')::payment_method, (v_pay ->> 'amount_cents')::bigint,
      case (v_pay ->> 'method')
        when 'CASH' then 'VERIFIED'::payment_status
        when 'MPESA_C2B' then 'VERIFIED'::payment_status
        when 'CARD' then 'VERIFIED'::payment_status
        when 'MPESA_MANUAL' then 'PENDING'::payment_status
        else 'PENDING'::payment_status end,
      nullif(v_pay ->> 'tendered_cents','')::bigint,
      nullif(v_pay ->> 'change_cents','')::bigint,
      coalesce((p_payload ->> 'occurred_at')::timestamptz, now()),
      v_idem || ':pay:' || (v_pay ->> 'payment_id'),
      case when (v_pay ->> 'method') = 'CARD'
           then nullif(trim(v_pay ->> 'card_reference'), '') end);

    if (v_pay ->> 'mpesa_txn_id') is not null then
      update mpesa_transactions
         set payment_id = (v_pay ->> 'payment_id')::uuid,
             matched_at = now(), matched_by_cashier_id = v_cashier.cashier_id
       where mpesa_txn_id = (v_pay ->> 'mpesa_txn_id')::uuid
         and business_id = v_business_id and payment_id is null
      returning * into v_mpesa;

      if v_mpesa.mpesa_txn_id is null then
        raise exception 'mpesa_already_matched' using errcode = '23505',
          hint = 'That M-Pesa payment is already attached to another sale.';
      end if;

      if v_mpesa.status = 'VERIFIED' then
        update payments set status = 'VERIFIED'
         where payment_id = (v_pay ->> 'payment_id')::uuid;
      end if;

      if v_mpesa.amount_cents <> (v_pay ->> 'amount_cents')::bigint then
        update payments set status = 'MISMATCH'
         where payment_id = (v_pay ->> 'payment_id')::uuid;
        update mpesa_transactions set status = 'MISMATCH'
         where mpesa_txn_id = v_mpesa.mpesa_txn_id;
      end if;
    end if;

    -- A manually-typed M-Pesa code.
    if (v_pay ->> 'method') = 'MPESA_MANUAL'
       and nullif(trim(v_pay ->> 'manual_reference'), '') is not null then
      declare
        v_code text := upper(trim(v_pay ->> 'manual_reference'));
        v_bank text := nullif(upper(trim(v_pay ->> 'manual_bank')), '');
        v_existing_manual mpesa_transactions%rowtype;
      begin
        select * into v_existing_manual from mpesa_transactions
         where business_id = v_business_id and mpesa_receipt_number = v_code
         for update;

        if found then
          if v_existing_manual.payment_id is null then
            -- A confirmation for this exact code already exists and is
            -- unclaimed (arrived, or was recorded, before this sale did).
            -- Attaching it is safe — nobody else has claimed it.
            update mpesa_transactions
               set payment_id = (v_pay ->> 'payment_id')::uuid,
                   matched_at = now(), matched_by_cashier_id = v_cashier.cashier_id
             where mpesa_txn_id = v_existing_manual.mpesa_txn_id;

            if v_existing_manual.status = 'VERIFIED' then
              update payments set status = 'VERIFIED'
               where payment_id = (v_pay ->> 'payment_id')::uuid;
            end if;
          else
            -- ── The reused-code guard ─────────────────────────────────
            -- This exact code is already attached to a DIFFERENT sale.
            -- Fraud (an old, genuine message shown as if it were new) and
            -- an honest re-entry (a voided-and-redone sale) look
            -- identical here — the only thing that tells them apart is a
            -- supervisor consciously accepting the risk. No approval on
            -- file means the whole sale is rejected, not just this line.
            if (v_pay ->> 'approved_by_cashier_id') is null then
              raise exception 'manual_code_already_used: %', v_code
                using errcode = '42501',
                hint = 'This M-Pesa code is already attached to a different sale. Supervisor approval is required to accept it again.';
            end if;

            select * into v_approver from cashiers
             where cashier_id = (v_pay ->> 'approved_by_cashier_id')::uuid
               and business_id = v_business_id and is_active;

            if not found or not v_approver.can_override_price then
              raise exception 'approver_cannot_override_reused_code'
                using errcode = '42501';
            end if;

            -- Deliberately does NOT touch the existing mpesa_transactions
            -- row — it stays correctly attached to its original sale. This
            -- payment proceeds as an approved, still-manual, unverified
            -- entry with no ledger row of its own (the unique index would
            -- reject a second row for the same code regardless), but the
            -- override is now on permanent record for the owner to review.
            insert into audit_logs (
              business_id, actor_cashier_id, device_id, shift_id,
              action, entity_type, entity_id, before_state, after_state)
            values (
              v_business_id, v_cashier.cashier_id, v_device_id, v_shift.shift_id,
              'MANUAL_CODE_REUSE_OVERRIDDEN', 'mpesa_transaction',
              v_existing_manual.mpesa_txn_id,
              jsonb_build_object('code', v_code,
                                 'original_payment_id', v_existing_manual.payment_id,
                                 'original_amount_cents', v_existing_manual.amount_cents),
              jsonb_build_object('new_payment_id', (v_pay ->> 'payment_id')::uuid,
                                 'new_sale_id', v_sale_id,
                                 'new_amount_cents', (v_pay ->> 'amount_cents')::bigint,
                                 'approved_by', v_approver.cashier_id,
                                 'reason', v_pay ->> 'override_reason'));
          end if;
        else
          insert into mpesa_transactions (
            mpesa_txn_id, business_id, payment_id, channel, direction, provider,
            mpesa_receipt_number, amount_cents, status, initiated_at,
            manual_bank)
          values (
            uuid_generate_v7(), v_business_id, (v_pay ->> 'payment_id')::uuid,
            'MANUAL', 'C2B', 'MANUAL',
            v_code, (v_pay ->> 'amount_cents')::bigint, 'PENDING', now(),
            v_bank);
        end if;
      end;
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
    'local_ref', v_local_ref,
    'total_cents', v_total, 'tax_total_cents', v_tax_total,
    'change_cents', v_paid - v_total, 'fiscal_status','PENDING');
end $$;
comment on function complete_sale is
  'The ONLY write path for a completed sale. Prices resolved server-side. '
  'local_ref is minted atomically here via device_sale_counters, never '
  'trusted from the client -- see 0035_atomic_local_ref.sql.';
