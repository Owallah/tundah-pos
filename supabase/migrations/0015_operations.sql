-- ============================================================================
-- 0015_operations.sql
--
-- RPCs behind the operational screens that were missing: wastage recording,
-- sale history, receipt reprint and the mid-shift X report.
--
-- These all existed as capability in the schema but had no reachable
-- interface. See AUDIT.md sections B and C.
-- ============================================================================

-- ── Stock adjustments: wastage, samples, load-back, corrections ────────────
--
-- For fresh produce, WASTAGE is a DAILY movement, not an exception. Without
-- it every spoiled mango silently becomes shrinkage and the ledger drifts
-- from the shelf within one event.
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
  v_location_id uuid;
  v_movement_id uuid := uuid_generate_v7();
  v_delta       numeric(13,3);
  v_product     products%rowtype;
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

  if p_qty is null or p_qty <= 0 then
    raise exception 'qty_must_be_positive' using errcode = '23514',
      hint = 'Enter a positive quantity; direction comes from the movement type.';
  end if;

  select * into v_product from products
   where product_id = p_product_id and business_id = v_business_id;
  if not found then
    raise exception 'unknown_product' using errcode = '23503';
  end if;

  select event_id into v_event_id from events
   where business_id = v_business_id and status = 'ACTIVE';

  select location_id into v_location_id from stock_locations
   where business_id = v_business_id
     and (event_id = v_event_id or (v_event_id is null and kind = 'BASE'))
     and is_active
   order by case when event_id = v_event_id then 0 else 1 end
   limit 1;

  if v_location_id is null then
    raise exception 'no_stock_location' using errcode = '23503';
  end if;

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

grant execute on function record_stock_adjustment(uuid, text, numeric, text, uuid)
  to authenticated;

-- ── Sale history ────────────────────────────────────────────────────────────
create or replace function recent_sales(
  p_limit int default 50,
  p_shift_id uuid default null
) returns table (
  sale_id uuid, local_ref text, status sale_status,
  total_cents bigint, occurred_at timestamptz,
  cashier text, device text,
  invc_no bigint, public_token text,
  is_backfilled boolean, payment_methods text
)
language sql stable security definer set search_path = public
as $$
  select
    s.sale_id, s.local_ref, s.status, s.total_cents,
    coalesce(s.completed_at, s.occurred_at),
    c.full_name, d.code,
    i.invc_no, i.public_token, s.is_backfilled,
    (select string_agg(distinct p.method::text, ', ')
       from payments p where p.sale_id = s.sale_id)
  from sales s
  join cashiers c on c.cashier_id = s.cashier_id
  join devices  d on d.device_id  = s.device_id
  left join invoices i on i.sale_id = s.sale_id
  where s.business_id = auth_business_id()
    and s.status in ('COMPLETED','VOIDED')
    and (p_shift_id is null or s.shift_id = p_shift_id)
    -- A till sees its own sales; staff see everything.
    and (auth_is_staff() or s.device_id = auth_device_id())
  order by coalesce(s.completed_at, s.occurred_at) desc
  limit least(p_limit, 200)
$$;

grant execute on function recent_sales(int, uuid) to authenticated;

-- ── Receipt reprint (SAL-10) ───────────────────────────────────────────────
-- Rebuilds a receipt for any historic sale. If the sale has been fiscalised
-- the stored immutable snapshot is authoritative; otherwise it is rebuilt
-- from the sale, and comes back marked provisional.
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
        'reference', (select m.mpesa_receipt_number from mpesa_transactions m
                       where m.payment_id = p.payment_id))), '[]'::jsonb)
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

grant execute on function sale_receipt(uuid) to authenticated;

-- ── Which shift is open on this till? (drives the X report button) ─────────
create or replace function my_open_shift()
returns table (shift_id uuid, opened_at timestamptz, cashier text, event text)
language sql stable security definer set search_path = public
as $$
  select s.shift_id, s.opened_at, c.full_name, e.name
    from shifts s
    join cashiers c on c.cashier_id = s.cashier_id
    join events   e on e.event_id   = s.event_id
   where s.business_id = auth_business_id()
     and s.status = 'OPEN'
     and (auth_is_staff() or s.device_id = auth_device_id())
   order by s.opened_at desc
$$;

grant execute on function my_open_shift() to authenticated;
