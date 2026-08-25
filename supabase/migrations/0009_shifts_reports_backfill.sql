-- ============================================================================
-- 0009_shifts_reports_backfill.sql
--
-- Shift lifecycle, X/Z reports, the supervisor paper-slip backfill screen,
-- and sale voiding. Completes the operational surface the till needs.
-- ============================================================================

-- ── Open a shift ────────────────────────────────────────────────────────────
create or replace function open_shift(
  p_cashier_id uuid,
  p_opening_float_cents bigint default 0
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_business_id uuid := auth_business_id();
  v_device_id   uuid := auth_device_id();
  v_event       events%rowtype;
  v_cashier     cashiers%rowtype;
  v_shift_id    uuid := uuid_generate_v7();
begin
  if v_business_id is null or v_device_id is null then
    raise exception 'no_device_context' using errcode = '28000';
  end if;

  if exists (select 1 from shifts
              where device_id = v_device_id and status = 'OPEN') then
    raise exception 'shift_already_open' using errcode = '23505',
      hint = 'Close the open shift on this till before starting another.';
  end if;

  select * into v_event from events
   where business_id = v_business_id and status = 'ACTIVE';
  if not found then
    raise exception 'no_active_event' using errcode = '23503',
      hint = 'A supervisor must activate an event before tills can sell.';
  end if;

  select * into v_cashier from cashiers
   where cashier_id = p_cashier_id and business_id = v_business_id and is_active;
  if not found then
    raise exception 'invalid_cashier' using errcode = '23503';
  end if;

  insert into shifts (
    shift_id, business_id, event_id, device_id, cashier_id,
    opening_float_cents, catalogue_snapshot_at, status)
  values (
    v_shift_id, v_business_id, v_event.event_id, v_device_id, p_cashier_id,
    p_opening_float_cents, now(), 'OPEN');

  insert into audit_logs (
    business_id, actor_cashier_id, device_id, shift_id,
    action, entity_type, entity_id, after_state)
  values (
    v_business_id, p_cashier_id, v_device_id, v_shift_id,
    'SHIFT_OPEN', 'shift', v_shift_id,
    jsonb_build_object('float_cents', p_opening_float_cents,
                       'event_id', v_event.event_id));

  return jsonb_build_object(
    'shift_id', v_shift_id,
    'event_id', v_event.event_id,
    'event_name', v_event.name,
    'cashier_name', v_cashier.full_name,
    'opening_float_cents', p_opening_float_cents);
end $$;

-- ── X report (mid-shift snapshot, non-destructive) ─────────────────────────
-- Z report is the same figures taken at close, with the shift then sealed.
create or replace function shift_report(p_shift_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_shift shifts%rowtype;
  v_result jsonb;
begin
  select * into v_shift from shifts
   where shift_id = p_shift_id and business_id = auth_business_id();
  if not found then
    raise exception 'unknown_shift' using errcode = '23503';
  end if;

  select jsonb_build_object(
    'shift_id',    v_shift.shift_id,
    'report_type', case when v_shift.status = 'OPEN' then 'X' else 'Z' end,
    'status',      v_shift.status,
    'device_code', (select code from devices where device_id = v_shift.device_id),
    'cashier',     (select full_name from cashiers where cashier_id = v_shift.cashier_id),
    'event',       (select name from events where event_id = v_shift.event_id),
    'opened_at',   v_shift.opened_at,
    'closed_at',   v_shift.closed_at,
    'generated_at', now(),
    'opening_float_cents', v_shift.opening_float_cents,

    'sales', (
      select jsonb_build_object(
        'count',          count(*),
        'gross_cents',    coalesce(sum(total_cents), 0),
        'discount_cents', coalesce(sum(discount_total_cents), 0),
        'tax_cents',      coalesce(sum(tax_total_cents), 0),
        'net_cents',      coalesce(sum(subtotal_cents), 0),
        'average_basket_cents',
          case when count(*) = 0 then 0
               else round(coalesce(sum(total_cents), 0)::numeric / count(*)) end,
        'voided_count', count(*) filter (where status = 'VOIDED'),
        'backfilled_count', count(*) filter (where is_backfilled))
        from sales
       where shift_id = p_shift_id and status in ('COMPLETED','VOIDED')),

    -- Payment mix. Unverified M-Pesa is broken out separately: it must be
    -- reconciled before the shift is signed off (ARCHITECTURE §G.3).
    'payments', (
      select coalesce(jsonb_object_agg(method, detail), '{}'::jsonb) from (
        select p.method::text as method,
               jsonb_build_object(
                 'count', count(*),
                 'amount_cents', sum(p.amount_cents),
                 'verified_cents', sum(p.amount_cents) filter (where p.status = 'VERIFIED'),
                 'unverified_cents', sum(p.amount_cents) filter (where p.status <> 'VERIFIED')
               ) as detail
          from payments p
          join sales s on s.sale_id = p.sale_id
         where s.shift_id = p_shift_id and s.status = 'COMPLETED'
         group by p.method) x),

    'cash', (
      select jsonb_build_object(
        'expected_cents',
          v_shift.opening_float_cents + coalesce(sum(p.amount_cents), 0),
        'counted_cents', v_shift.counted_cash_cents,
        'variance_cents', v_shift.variance_cents)
        from payments p
        join sales s on s.sale_id = p.sale_id
       where s.shift_id = p_shift_id and s.status = 'COMPLETED' and p.method = 'CASH'),

    'top_products', (
      select coalesce(jsonb_agg(t order by t.qty desc), '[]'::jsonb) from (
        select si.product_name as name,
               sum(si.qty) as qty,
               sum(si.line_total_cents) as amount_cents
          from sale_items si
          join sales s on s.sale_id = si.sale_id
         where s.shift_id = p_shift_id and s.status = 'COMPLETED'
         group by si.product_name
         order by sum(si.qty) desc
         limit 10) t),

    'exceptions', jsonb_build_object(
      'price_overrides', (
        select count(*) from sale_items si join sales s on s.sale_id = si.sale_id
         where s.shift_id = p_shift_id and si.price_overridden),
      'discounted_lines', (
        select count(*) from sale_items si join sales s on s.sale_id = si.sale_id
         where s.shift_id = p_shift_id and si.discount_cents > 0),
      'below_stock_lines', (
        select count(*) from sale_items si join sales s on s.sale_id = si.sale_id
         where s.shift_id = p_shift_id and si.sold_below_recorded_stock),
      'unresolved_doubt', (
        select count(*) from sales_in_doubt
         where shift_id = p_shift_id and status = 'OPEN')),

    -- Fiscal state must appear on the face of the report. A Z report with
    -- pending submissions is not a closed day.
    'fiscal', jsonb_build_object(
      'fiscalised', (
        select count(*) from sales s join invoices i on i.sale_id = s.sale_id
         where s.shift_id = p_shift_id),
      'awaiting_etims', (
        select count(*) from sales s
         where s.shift_id = p_shift_id and s.status = 'COMPLETED'
           and not exists (select 1 from invoices i where i.sale_id = s.sale_id)))
  ) into v_result;

  return v_result;
end $$;

grant execute on function open_shift(uuid, bigint)  to authenticated;
grant execute on function shift_report(uuid)        to authenticated;

-- ── Backfill a paper slip (§C.6) ────────────────────────────────────────────
-- Supervisor-only, online-only, fully audited. This is what turns a hotspot
-- failure into a delay rather than lost revenue.
create or replace function backfill_sale(p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_result jsonb;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501',
      hint = 'Only a supervisor may enter paper slips.';
  end if;

  if nullif(p_payload ->> 'backfill_ref', '') is null then
    raise exception 'backfill_ref_required' using errcode = '23514',
      hint = 'Enter the paper slip number so the entry can be traced.';
  end if;

  if (p_payload ->> 'occurred_at') is null then
    raise exception 'occurred_at_required' using errcode = '23514',
      hint = 'Enter the time written on the slip, not the time now.';
  end if;

  v_result := complete_sale(
    jsonb_set(
      jsonb_set(p_payload, '{is_backfilled}', 'true'::jsonb),
      '{local_ref}',
      to_jsonb('PAPER-' || (p_payload ->> 'backfill_ref'))));

  insert into audit_logs (
    business_id, actor_user_id, action, entity_type, entity_id, after_state)
  values (
    auth_business_id(), auth.uid(), 'SALE_BACKFILLED', 'sale',
    (p_payload ->> 'sale_id')::uuid,
    jsonb_build_object('slip_ref', p_payload ->> 'backfill_ref',
                       'occurred_at', p_payload ->> 'occurred_at',
                       'total_cents', v_result ->> 'total_cents'));

  return v_result;
end $$;

grant execute on function backfill_sale(jsonb) to authenticated;

-- ── Void a completed sale ───────────────────────────────────────────────────
-- Only permitted BEFORE fiscalisation. Once KRA has signed an invoice the
-- correction is a credit note, never an edit (SAL-06).
create or replace function void_sale(
  p_sale_id uuid, p_reason text, p_approver_cashier_id uuid
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_sale sales%rowtype;
  v_approver cashiers%rowtype;
  v_location uuid;
  v_item record;
begin
  select * into v_sale from sales
   where sale_id = p_sale_id and business_id = auth_business_id()
   for update;
  if not found then
    raise exception 'unknown_sale' using errcode = '23503';
  end if;

  if v_sale.status <> 'COMPLETED' then
    raise exception 'sale_not_completed' using errcode = '23514';
  end if;

  if exists (select 1 from invoices where sale_id = p_sale_id) then
    raise exception 'sale_already_fiscalised' using errcode = '23514',
      hint = 'This sale has a tax invoice. Issue a credit note instead.';
  end if;

  select * into v_approver from cashiers
   where cashier_id = p_approver_cashier_id
     and business_id = auth_business_id() and is_active;
  if not found or not v_approver.can_void then
    raise exception 'approver_cannot_void' using errcode = '42501';
  end if;

  if nullif(trim(p_reason), '') is null then
    raise exception 'reason_required' using errcode = '23514';
  end if;

  -- Reverse the stock with NEW ledger entries. The originals are immutable.
  select location_id into v_location from stock_locations
   where business_id = v_sale.business_id and event_id = v_sale.event_id and is_active
   limit 1;

  for v_item in
    select product_id, qty from sale_items where sale_id = p_sale_id
  loop
    insert into stock_movements (
      movement_id, business_id, product_id, location_id, event_id,
      movement_type, qty_delta, sale_id, device_id, cashier_id,
      reason, occurred_at, idempotency_key)
    values (
      uuid_generate_v7(), v_sale.business_id, v_item.product_id, v_location,
      v_sale.event_id, 'RETURN', v_item.qty, p_sale_id,
      v_sale.device_id, p_approver_cashier_id,
      'void: ' || p_reason, now(),
      v_sale.idempotency_key || ':void:' || v_item.product_id);
  end loop;

  update sales
     set status = 'VOIDED', void_reason = p_reason,
         voided_by_cashier_id = p_approver_cashier_id
   where sale_id = p_sale_id;

  -- Drop any queued eTIMS submission that has not yet gone out.
  update etims_submissions
     set status = 'SKIPPED', last_error = 'sale voided before submission'
   where sale_id = p_sale_id and status in ('PENDING','FAILED');

  insert into audit_logs (
    business_id, actor_cashier_id, device_id, shift_id,
    action, entity_type, entity_id, before_state, after_state)
  values (
    v_sale.business_id, p_approver_cashier_id, v_sale.device_id, v_sale.shift_id,
    'SALE_VOIDED', 'sale', p_sale_id,
    jsonb_build_object('total_cents', v_sale.total_cents, 'status', 'COMPLETED'),
    jsonb_build_object('reason', p_reason, 'approved_by', p_approver_cashier_id));

  return jsonb_build_object('sale_id', p_sale_id, 'status', 'VOIDED');
end $$;

grant execute on function void_sale(uuid, text, uuid) to authenticated;

-- ── Unmatched M-Pesa payments, for the tender panel ────────────────────────
create or replace function unmatched_mpesa(p_since_minutes int default 15)
returns table (
  mpesa_txn_id uuid, receipt_number text, amount_cents bigint,
  phone_number text, payer_name text, confirmed_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select m.mpesa_txn_id, m.mpesa_receipt_number, m.amount_cents,
         m.phone_number, m.payer_name, m.confirmed_at
    from mpesa_transactions m
   where m.business_id = auth_business_id()
     and m.payment_id is null
     and m.status = 'VERIFIED'
     and m.confirmed_at > now() - make_interval(mins => p_since_minutes)
   order by m.confirmed_at desc
$$;

grant execute on function unmatched_mpesa(int) to authenticated;
