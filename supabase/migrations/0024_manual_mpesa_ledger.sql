-- 0024_manual_mpesa_ledger.sql
--
-- Option B from the reconciliation-visibility discussion: a manually-typed
-- M-Pesa code was never persisted anywhere past the moment the cashier
-- typed it. toSalePayload() dropped it before it even left the browser, and
-- `payments` has no column that could have held it anyway. The owner had
-- no way to ever see the code again — not on reprint, not on the
-- reconciliation screen, nowhere.
--
-- Fix: a manual entry now gets a real, permanent row in mpesa_transactions —
-- the same ledger every STK and C2B payment already lives in — instead of a
-- second, separate, code-less record on `payments`. Three consequences:
--
--   1. The code survives forever: visible on the reconciliation screen and
--      on any future receipt reprint, exactly like a real STK payment.
--   2. If Safaricom's own C2B confirmation for that exact code arrives
--      later (the common case — a manual entry usually means the
--      confirmation was merely delayed, not that it doesn't exist),
--      record_c2b_payment() now upgrades the placeholder to fully verified
--      automatically, instead of discarding it as a no-op duplicate.
--   3. It sits in the one table any future NCBA-statement-matching tool
--      would already read from, at no extra integration cost.

-- ── 1. Let the ledger actually hold a manual entry ─────────────────────────
-- The original CHECK constraints were declared inline, so Postgres assigned
-- their names automatically — guessing that name here would be unsafe if
-- wrong (a silent no-op drop, leaving the OLD constraint still enforced).
-- Look it up by column instead of by a guessed name.
do $$
declare r record;
begin
  for r in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_attribute att on att.attrelid = rel.oid
     where rel.relname = 'mpesa_transactions'
       and con.contype = 'c'
       and att.attname = 'channel'
       and att.attnum = any(con.conkey)
  loop
    execute format('alter table mpesa_transactions drop constraint %I', r.conname);
  end loop;
end $$;

alter table mpesa_transactions
  add constraint mpesa_transactions_channel_check
  check (channel in ('C2B','STK','MANUAL'));

do $$
declare r record;
begin
  for r in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_attribute att on att.attrelid = rel.oid
     where rel.relname = 'mpesa_transactions'
       and con.contype = 'c'
       and att.attname = 'provider'
       and att.attnum = any(con.conkey)
  loop
    execute format('alter table mpesa_transactions drop constraint %I', r.conname);
  end loop;
end $$;

alter table mpesa_transactions
  add constraint mpesa_transactions_provider_check
  check (provider in ('DARAJA','NCBA','MANUAL'));

-- ── 2. complete_sale(): write the manual code into the ledger ─────────────
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
         and business_id = v_business_id and payment_id is null
      returning * into v_mpesa;

      if v_mpesa.mpesa_txn_id is null then
        raise exception 'mpesa_already_matched' using errcode = '23505',
          hint = 'That M-Pesa payment is already attached to another sale.';
      end if;

      -- An NCBA STK payment is confirmed BEFORE the sale is completed: the
      -- cashier waits for the prompt to clear, then taps Complete. Without
      -- this the payment would be written as PENDING (because the method is
      -- MPESA_STK) and sit in the reconciliation queue forever despite
      -- already being verified.
      if v_mpesa.status = 'VERIFIED' then
        update payments set status = 'VERIFIED'
         where payment_id = (v_pay ->> 'payment_id')::uuid;
      end if;

      -- The provider confirmed a different amount from the one tendered.
      -- Flag rather than silently accept; the reconciliation screen shows it.
      if v_mpesa.amount_cents <> (v_pay ->> 'amount_cents')::bigint then
        update payments set status = 'MISMATCH'
         where payment_id = (v_pay ->> 'payment_id')::uuid;
        update mpesa_transactions set status = 'MISMATCH'
         where mpesa_txn_id = v_mpesa.mpesa_txn_id;
      end if;
    end if;

    -- A manually-typed M-Pesa code: give it a permanent row in the SAME
    -- ledger every other M-Pesa payment lives in (channel MANUAL, so it
    -- stays visibly distinct from anything webhook-confirmed), instead of
    -- letting the code vanish the moment this transaction commits.
    if (v_pay ->> 'method') = 'MPESA_MANUAL'
       and nullif(trim(v_pay ->> 'manual_reference'), '') is not null then
      declare
        v_code text := upper(trim(v_pay ->> 'manual_reference'));
        v_existing_manual mpesa_transactions%rowtype;
      begin
        select * into v_existing_manual from mpesa_transactions
         where business_id = v_business_id and mpesa_receipt_number = v_code
         for update;

        if found then
          if v_existing_manual.payment_id is null then
            -- A confirmation for this exact code already exists (arrived,
            -- or was recorded, before this sale did). Attach it — the
            -- unique index on (business_id, mpesa_receipt_number) would
            -- reject a second row for the same code anyway.
            update mpesa_transactions
               set payment_id = (v_pay ->> 'payment_id')::uuid,
                   matched_at = now(), matched_by_cashier_id = v_cashier.cashier_id
             where mpesa_txn_id = v_existing_manual.mpesa_txn_id;

            if v_existing_manual.status = 'VERIFIED' then
              update payments set status = 'VERIFIED'
               where payment_id = (v_pay ->> 'payment_id')::uuid;
            end if;
          end if;
          -- else: this exact code is already attached to a different sale.
          -- That is a genuine anomaly (duplicate/typo) — leave this
          -- payment PENDING rather than silently overwrite the other one;
          -- it is exactly the kind of thing reconciliation should surface.
        else
          insert into mpesa_transactions (
            mpesa_txn_id, business_id, payment_id, channel, direction, provider,
            mpesa_receipt_number, amount_cents, status, initiated_at)
          values (
            uuid_generate_v7(), v_business_id, (v_pay ->> 'payment_id')::uuid,
            'MANUAL', 'C2B', 'MANUAL',
            v_code, (v_pay ->> 'amount_cents')::bigint, 'PENDING', now());
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

comment on function complete_sale is
  'The ONLY write path for a completed sale. Prices resolved server-side. '
  'Manual M-Pesa codes now get a permanent mpesa_transactions row (channel '
  'MANUAL) instead of vanishing after the payload is built.';

-- ── 3. record_c2b_payment(): auto-upgrade a manual entry if it arrives ────
create or replace function record_c2b_payment(
  p_business_id   uuid,
  p_receipt_number text,
  p_amount_cents  bigint,
  p_phone         text,
  p_payer_name    text,
  p_bill_ref      text,
  p_occurred_at   timestamptz,
  p_raw           jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_existing mpesa_transactions%rowtype;
  v_id uuid := uuid_generate_v7();
  v_mismatch boolean;
begin
  select * into v_existing from mpesa_transactions
   where business_id = p_business_id
     and mpesa_receipt_number = p_receipt_number
   for update;

  if found then
    -- A cashier already typed this exact code by hand, ahead of Safaricom's
    -- own confirmation. Upgrade that placeholder to fully verified instead
    -- of discarding this as a no-op repeat — this is the one case where a
    -- manual entry resolves itself with no one needing to look at it.
    if v_existing.channel = 'MANUAL' and v_existing.status = 'PENDING' then
      v_mismatch := p_amount_cents is not null
                    and p_amount_cents <> v_existing.amount_cents;

      update mpesa_transactions
         set status = case when v_mismatch then 'MISMATCH' else 'VERIFIED' end,
             channel = 'C2B', provider = 'DARAJA', verified_by = 'CALLBACK',
             phone_number = coalesce(p_phone, phone_number),
             payer_name = coalesce(p_payer_name, payer_name),
             bill_ref_number = coalesce(nullif(p_bill_ref,''), bill_ref_number),
             amount_cents = coalesce(p_amount_cents, amount_cents),
             confirmed_at = coalesce(p_occurred_at, now()),
             raw_callback = p_raw
       where mpesa_txn_id = v_existing.mpesa_txn_id;

      if v_existing.payment_id is not null then
        update payments
           set status = case when v_mismatch then 'MISMATCH' else 'VERIFIED' end
         where payment_id = v_existing.payment_id;
      end if;

      return jsonb_build_object(
        'status', case when v_mismatch
                        then 'UPGRADED_FROM_MANUAL_MISMATCH'
                        else 'UPGRADED_FROM_MANUAL' end,
        'mpesa_txn_id', v_existing.mpesa_txn_id,
        'already_matched', v_existing.payment_id is not null);
    end if;

    -- Safaricom retries confirmations. A genuine repeat must be a no-op,
    -- not a duplicate payment sitting in the cashier's match list.
    return jsonb_build_object(
      'status', 'DUPLICATE',
      'mpesa_txn_id', v_existing.mpesa_txn_id,
      'already_matched', v_existing.payment_id is not null);
  end if;

  insert into mpesa_transactions (
    mpesa_txn_id, business_id, channel, direction,
    mpesa_receipt_number, phone_number, payer_name, bill_ref_number,
    amount_cents, status, confirmed_at, raw_callback)
  values (
    v_id, p_business_id, 'C2B', 'C2B',
    p_receipt_number, p_phone, p_payer_name, nullif(p_bill_ref, ''),
    p_amount_cents, 'VERIFIED', coalesce(p_occurred_at, now()), p_raw);

  return jsonb_build_object('status', 'RECORDED', 'mpesa_txn_id', v_id);
end $$;

-- ── 4. mpesa_reconciliation(): read manual codes from the ledger ─────────
create or replace function mpesa_reconciliation(
  p_from timestamptz default now() - interval '24 hours',
  p_to   timestamptz default now()
) returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'from', p_from,
    'to',   p_to,
    'buckets', jsonb_build_object(
      'pending', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select mpesa_txn_id, channel, amount_cents, phone_number,
                 initiated_at, checkout_request_id
            from mpesa_transactions
           where business_id = auth_business_id()
             and status = 'PENDING'
             and channel <> 'MANUAL'
             and coalesce(initiated_at, confirmed_at) between p_from and p_to
           order by initiated_at desc) t),

      'verified', (
        select jsonb_build_object(
          'count', count(*), 'total_cents', coalesce(sum(amount_cents), 0))
          from mpesa_transactions
         where business_id = auth_business_id() and status = 'VERIFIED'
           and confirmed_at between p_from and p_to),

      'failed', (
        select jsonb_build_object('count', count(*))
          from mpesa_transactions
         where business_id = auth_business_id()
           and status in ('FAILED','CANCELLED')
           and coalesce(initiated_at, confirmed_at) between p_from and p_to),

      -- Amount confirmed differs from amount requested. Needs a human.
      -- Channel-agnostic on purpose: a manual code that later mismatches on
      -- confirmation lands here too, with the same Accept/Write-off tools.
      'mismatch', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select mpesa_txn_id, mpesa_receipt_number, amount_cents,
                 phone_number, payer_name, confirmed_at, result_desc
            from mpesa_transactions
           where business_id = auth_business_id() and status = 'MISMATCH'
             and confirmed_at between p_from and p_to
           order by confirmed_at desc) t),

      -- A manual code the cashier typed, now a real ledger row (channel
      -- MANUAL) instead of a code-less entry on `payments`. The code
      -- itself is visible here, and mpesa_txn_id is the same id
      -- resolve_mpesa() already knows how to Accept or Write off.
      'unverified_manual', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select m.mpesa_txn_id, m.mpesa_receipt_number, m.amount_cents,
                 s.local_ref, c.full_name as cashier,
                 extract(epoch from (now() - m.initiated_at)) / 3600 as hours_old
            from mpesa_transactions m
            join payments p on p.payment_id = m.payment_id
            join sales s on s.sale_id = p.sale_id
            join cashiers c on c.cashier_id = s.cashier_id
           where m.business_id = auth_business_id()
             and m.channel = 'MANUAL'
             and m.status = 'PENDING'
             and m.initiated_at between p_from and p_to
           order by m.initiated_at) t),

      -- Money arrived but no cashier attached it to a sale.
      'unmatched', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select mpesa_txn_id, mpesa_receipt_number, amount_cents,
                 phone_number, payer_name, confirmed_at
            from mpesa_transactions
           where business_id = auth_business_id()
             and status = 'VERIFIED' and payment_id is null
             and confirmed_at between p_from and p_to
           order by confirmed_at desc) t)
    ))
$$;

-- ── 5. resolve_mpesa(): record that a manual accept was a human decision ──
create or replace function resolve_mpesa(
  p_mpesa_txn_id uuid,
  p_action text,          -- ACCEPT | WRITE_OFF | ATTACH
  p_payment_id uuid default null,
  p_note text default null
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_txn mpesa_transactions%rowtype;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_txn from mpesa_transactions
   where mpesa_txn_id = p_mpesa_txn_id and business_id = auth_business_id()
   for update;
  if not found then
    raise exception 'unknown_transaction' using errcode = '23503';
  end if;

  if p_action = 'ATTACH' then
    if p_payment_id is null then
      raise exception 'payment_id_required' using errcode = '23514';
    end if;
    update mpesa_transactions
       set payment_id = p_payment_id, matched_at = now(), reconciled_at = now()
     where mpesa_txn_id = p_mpesa_txn_id;
    update payments set status = 'VERIFIED' where payment_id = p_payment_id;

  elsif p_action = 'ACCEPT' then
    update mpesa_transactions
       set status = 'VERIFIED', reconciled_at = now(),
           -- A human confirmed this — most often a manual code checked
           -- against the actual NCBA/Safaricom statement by hand.
           verified_by = coalesce(verified_by, 'MANUAL')
     where mpesa_txn_id = p_mpesa_txn_id;
    if v_txn.payment_id is not null then
      update payments set status = 'VERIFIED' where payment_id = v_txn.payment_id;
    end if;

  elsif p_action = 'WRITE_OFF' then
    update mpesa_transactions
       set status = 'FAILED', reconciled_at = now(),
           result_desc = coalesce(p_note, 'written off during reconciliation')
     where mpesa_txn_id = p_mpesa_txn_id;

  else
    raise exception 'unknown_action: %', p_action using errcode = '23514';
  end if;

  insert into audit_logs (
    business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (
    auth_business_id(), auth.uid(), 'MPESA_RECONCILED', 'mpesa_transaction',
    p_mpesa_txn_id,
    jsonb_build_object('action', p_action, 'note', p_note,
                       'payment_id', p_payment_id));

  return jsonb_build_object('mpesa_txn_id', p_mpesa_txn_id, 'action', p_action);
end $$;