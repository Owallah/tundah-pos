-- ============================================================================
-- 0010_mpesa_ingestion.sql
--
-- The RPCs the Daraja webhooks call. Business logic lives HERE, not in the
-- Edge Function, for three reasons:
--   - Idempotency needs the unique index, so it belongs in a transaction.
--   - A webhook may be retried by Safaricom at any time; a single atomic
--     call is the only safe shape.
--   - The function stays a thin, auditable transport layer that anyone can
--     read in one screen.
-- ============================================================================

-- ── C2B: customer paid the till directly. THE PRIMARY PATH. ────────────────
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
begin
  -- Safaricom retries confirmations. A repeat must be a no-op, not a
  -- duplicate payment sitting in the cashier's match list.
  select * into v_existing from mpesa_transactions
   where business_id = p_business_id
     and mpesa_receipt_number = p_receipt_number;

  if found then
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

-- ── STK: we initiated, so a pending row already exists ─────────────────────
create or replace function record_stk_result(
  p_checkout_request_id text,
  p_result_code   int,
  p_result_desc   text,
  p_receipt_number text,
  p_amount_cents  bigint,
  p_phone         text,
  p_occurred_at   timestamptz,
  p_raw           jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare v_txn mpesa_transactions%rowtype;
begin
  select * into v_txn from mpesa_transactions
   where checkout_request_id = p_checkout_request_id
   for update;

  if not found then
    return jsonb_build_object('status', 'UNKNOWN_CHECKOUT_REQUEST');
  end if;

  -- Already resolved: a retried callback must not reopen a settled payment.
  if v_txn.status in ('VERIFIED', 'FAILED', 'CANCELLED') then
    return jsonb_build_object('status', 'ALREADY_RESOLVED',
                              'mpesa_txn_id', v_txn.mpesa_txn_id);
  end if;

  if p_result_code = 0 then
    update mpesa_transactions
       set status = 'VERIFIED',
           mpesa_receipt_number = p_receipt_number,
           phone_number = coalesce(p_phone, phone_number),
           -- Trust the amount Safaricom confirms, not the one we asked for.
           amount_cents = coalesce(p_amount_cents, amount_cents),
           result_code = p_result_code,
           result_desc = p_result_desc,
           confirmed_at = coalesce(p_occurred_at, now()),
           raw_callback = p_raw
     where mpesa_txn_id = v_txn.mpesa_txn_id;

    -- If the amount differs from what we requested, flag rather than accept
    -- silently. The reconciliation screen surfaces it.
    if p_amount_cents is not null and p_amount_cents <> v_txn.amount_cents then
      update mpesa_transactions set status = 'MISMATCH'
       where mpesa_txn_id = v_txn.mpesa_txn_id;
      update payments set status = 'MISMATCH' where payment_id = v_txn.payment_id;
      return jsonb_build_object('status', 'MISMATCH',
        'expected_cents', v_txn.amount_cents, 'actual_cents', p_amount_cents);
    end if;

    update payments set status = 'VERIFIED' where payment_id = v_txn.payment_id;
    return jsonb_build_object('status', 'VERIFIED', 'mpesa_txn_id', v_txn.mpesa_txn_id);
  end if;

  update mpesa_transactions
     set status = case when p_result_code = 1032 then 'CANCELLED' else 'FAILED' end,
         result_code = p_result_code, result_desc = p_result_desc, raw_callback = p_raw
   where mpesa_txn_id = v_txn.mpesa_txn_id;

  update payments set status = 'FAILED' where payment_id = v_txn.payment_id;

  return jsonb_build_object('status', 'FAILED', 'result_code', p_result_code);
end $$;

-- ── Register an STK request before it is sent ──────────────────────────────
create or replace function register_stk_request(
  p_checkout_request_id text,
  p_merchant_request_id text,
  p_amount_cents bigint,
  p_phone text,
  p_sale_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare v_id uuid := uuid_generate_v7();
begin
  insert into mpesa_transactions (
    mpesa_txn_id, business_id, channel, direction,
    checkout_request_id, merchant_request_id,
    phone_number, amount_cents, status, initiated_at)
  values (
    v_id, auth_business_id(), 'STK', 'C2B',
    p_checkout_request_id, p_merchant_request_id,
    p_phone, p_amount_cents, 'PENDING', now());
  return v_id;
end $$;

grant execute on function register_stk_request(text, text, bigint, text, uuid)
  to authenticated;
revoke execute on function record_c2b_payment(uuid, text, bigint, text, text, text,
  timestamptz, jsonb) from authenticated, anon;
revoke execute on function record_stk_result(text, int, text, text, bigint, text,
  timestamptz, jsonb) from authenticated, anon;

-- ── Which STK payments need chasing? Used by the 5-minute reconciler. ──────
create or replace function stk_awaiting_callback(p_older_than_seconds int default 120)
returns table (mpesa_txn_id uuid, checkout_request_id text, initiated_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select m.mpesa_txn_id, m.checkout_request_id, m.initiated_at
    from mpesa_transactions m
   where m.channel = 'STK'
     and m.status = 'PENDING'
     and m.checkout_request_id is not null
     and m.initiated_at < now() - make_interval(secs => p_older_than_seconds)
     -- After an hour, stop chasing: Safaricom expires the request and the
     -- reconciliation screen takes over as a human task.
     and m.initiated_at > now() - interval '1 hour'
   order by m.initiated_at
$$;

-- ── Reconciliation screen (PAY-05): the six buckets ───────────────────────
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
      'mismatch', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select mpesa_txn_id, mpesa_receipt_number, amount_cents,
                 phone_number, payer_name, confirmed_at, result_desc
            from mpesa_transactions
           where business_id = auth_business_id() and status = 'MISMATCH'
             and confirmed_at between p_from and p_to
           order by confirmed_at desc) t),

      -- A manual code the cashier typed that Safaricom has no record of.
      -- After 24 hours this escalates as suspected fraud.
      'unverified_manual', (
        select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (
          select p.payment_id, p.amount_cents, p.occurred_at,
                 s.local_ref, c.full_name as cashier,
                 extract(epoch from (now() - p.occurred_at)) / 3600 as hours_old
            from payments p
            join sales s on s.sale_id = p.sale_id
            join cashiers c on c.cashier_id = s.cashier_id
           where p.business_id = auth_business_id()
             and p.method = 'MPESA_MANUAL'
             and p.status = 'PENDING'
             and p.occurred_at between p_from and p_to
           order by p.occurred_at) t),

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

grant execute on function mpesa_reconciliation(timestamptz, timestamptz) to authenticated;
revoke execute on function stk_awaiting_callback(int) from authenticated, anon;

-- ── Resolve a mismatch or attach an orphan payment ────────────────────────
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
       set status = 'VERIFIED', reconciled_at = now()
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

grant execute on function resolve_mpesa(uuid, text, uuid, text) to authenticated;
