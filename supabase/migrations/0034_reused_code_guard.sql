-- 0033_reused_code_guard.sql
--
-- The fraud shape this closes: a customer shows a real M-Pesa confirmation
-- message — genuine, but from an earlier, unrelated payment — and the
-- cashier, with no way to check, accepts it as proof of a brand-new payment
-- that never happened. Before this migration, complete_sale() silently let
-- this through: a manual code already attached to a different sale just
-- left the new payment PENDING with no signal to anyone, discoverable only
-- much later during reconciliation — by which point the customer has
-- already walked away with the goods.
--
-- Two layers, matching how every other risky judgement call in this app
-- already works (price overrides, discount overrides):
--
--   1. check_manual_code() — a fast, live lookup the till calls the moment
--      a full code is typed, so the cashier finds out immediately, not
--      after the sale completes.
--   2. complete_sale() now REJECTS the whole sale outright if a manual
--      code is already attached to a different payment, unless a
--      supervisor's PIN and a reason are attached to the tender. This is
--      the layer that actually matters — the client-side check is for
--      speed, this is what makes it impossible for a cashier to wave one
--      through alone.
--
-- Deliberately NOT an absolute block: a cashier legitimately re-entering
-- the same code (a voided-and-redone sale) is a real, non-fraudulent case.
-- A supervisor override records who accepted the risk and why, rather than
-- creating a dead end for the honest scenario.

create or replace function check_manual_code(p_code text)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_business_id uuid := auth_business_id();
  v_code text := upper(trim(p_code));
  v_existing mpesa_transactions%rowtype;
begin
  select * into v_existing from mpesa_transactions
   where business_id = v_business_id and mpesa_receipt_number = v_code;

  if not found or v_existing.payment_id is null then
    -- Either never seen before (the normal case for a fresh code), or seen
    -- but not yet attached to any sale (an unclaimed confirmation) — safe
    -- to proceed either way.
    return jsonb_build_object('status', 'AVAILABLE');
  end if;

  -- Already spent on a different sale. Deliberately minimal detail
  -- returned — enough for the cashier to know this is real, not enough to
  -- leak another customer's sale details to whoever is standing at the
  -- till right now.
  return jsonb_build_object(
    'status', 'ALREADY_USED',
    'amount_cents', v_existing.amount_cents,
    'used_at', coalesce(v_existing.matched_at, v_existing.confirmed_at));
end $$;

grant execute on function check_manual_code(text) to authenticated;

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
    'local_ref', p_payload ->> 'local_ref',
    'total_cents', v_total, 'tax_total_cents', v_tax_total,
    'change_cents', v_paid - v_total, 'fiscal_status','PENDING');
end $$;