-- 0030_card_and_bank_tagged_manual.sql
--
-- Two related additions from the gap-analysis list:
--
-- #1 — PDQ/card payments (a Co-op Bank card terminal) had nowhere to go.
-- `payment_method` already had 'CARD' sitting unused in its enum since the
-- very first migration, but nothing ever captured the terminal's reference
-- number, and nothing showed it back on a receipt. Fixed with a plain
-- `card_reference` column on `payments` — this is deliberately NOT part of
-- the mpesa_transactions ledger, because a card slip is not an M-Pesa
-- transaction at all; it belongs to a different rail entirely.
--
-- #6 — the business is adding a second paybill (Co-op Bank), alongside
-- NCBA. A manually-typed code already gets a permanent row in
-- mpesa_transactions (channel MANUAL, since 0024) — but there was no way
-- to say WHICH bank a given manual code belongs to, which matters the
-- moment there are two statements to check it against instead of one.
-- Fixed with `manual_bank` on mpesa_transactions, captured at entry time.

alter table payments
  add column if not exists card_reference text;

alter table mpesa_transactions
  add column if not exists manual_bank text
  check (manual_bank is null or manual_bank in ('NCBA','COOP'));

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
        -- A card slip is confirmed the moment the PDQ terminal prints it —
        -- there is no later verification step the way an M-Pesa code has.
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
    -- manual_bank records WHICH paybill this code is claimed to belong to
    -- (NCBA or Co-op) — the business now has two, and a code is only
    -- checkable against the right statement if we know which one it is.
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

-- ── Reprint: a card reference must survive after the fact too ────────────
create or replace function sale_receipt(p_sale_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_sale sales%rowtype;
  v_inv  invoices%rowtype;
  v_biz  businesses%rowtype;
begin
  select * into v_sale from sales
   where sale_id = p_sale_id and business_id = auth_business_id();
  if not found then
    raise exception 'unknown_sale' using errcode = '23503';
  end if;

  if not auth_is_staff() and v_sale.device_id <> auth_device_id() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_biz from businesses where business_id = v_sale.business_id;
  select * into v_inv from invoices where sale_id = p_sale_id;

  return jsonb_build_object(
    'business', jsonb_build_object(
      'legalName', v_biz.legal_name, 'tradingName', v_biz.trading_name,
      'kraPin', v_biz.kra_pin, 'address', v_biz.address,
      'phone', v_biz.phone, 'vatRegistered', v_biz.vat_registered),
    'localRef', v_sale.local_ref,
    'issuedAt', coalesce(v_sale.completed_at, v_sale.occurred_at),
    'status', v_sale.status,
    'cashierName', (select full_name from cashiers
                     where cashier_id = v_sale.cashier_id),
    'deviceCode',  (select code from devices where device_id = v_sale.device_id),
    'eventName',   (select name from events where event_id = v_sale.event_id),
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'lineNo', si.line_no, 'name', si.product_name,
        'qty', si.qty, 'uom', 'EA',
        'unitPrice', si.unit_price_cents, 'discount', si.discount_cents,
        'lineTotal', si.line_total_cents, 'taxCode', si.tax_ty_cd
      ) order by si.line_no), '[]'::jsonb)
      from sale_items si where si.sale_id = p_sale_id),
    'subtotal', v_sale.subtotal_cents,
    'discountTotal', v_sale.discount_total_cents,
    'taxBands', (
      select coalesce(jsonb_agg(b), '[]'::jsonb) from (
        select si.tax_ty_cd as "code", si.tax_rate_bp as "rateBp",
               sum(si.taxable_amount_cents) as "taxable",
               sum(si.tax_amount_cents) as "tax"
          from sale_items si where si.sale_id = p_sale_id
         group by si.tax_ty_cd, si.tax_rate_bp) b),
    'taxTotal', v_sale.tax_total_cents,
    'total', v_sale.total_cents,
    'payments', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'method', p.method, 'amount', p.amount_cents,
        'verified', p.status = 'VERIFIED',
        -- A card slip's reference lives directly on `payments` — it is not
        -- an M-Pesa transaction and was never meant to live in that ledger.
        'reference', coalesce(
          (select m.mpesa_receipt_number from mpesa_transactions m
            where m.payment_id = p.payment_id),
          p.card_reference))), '[]'::jsonb)
      from payments p where p.sale_id = p_sale_id),
    'changeGiven', coalesce((select sum(greatest(0, tendered_cents - amount_cents))
                               from payments where sale_id = p_sale_id), 0),
    'isBackfilled', v_sale.is_backfilled,
    'backfillRef', v_sale.backfill_ref,
    'fiscal', case when v_inv.invoice_id is null then null else
      jsonb_build_object(
        'invcNo', v_inv.invc_no, 'curRcptNo', v_inv.cur_rcpt_no,
        'totRcptNo', v_inv.tot_rcpt_no, 'intrlData', v_inv.intrl_data,
        'rcptSign', v_inv.rcpt_sign, 'sdcDateTime', v_inv.sdc_date_time,
        'qrPayload', v_inv.qr_payload) end,
    'publicToken', v_inv.public_token);
end $$;
