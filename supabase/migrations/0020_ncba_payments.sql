-- ============================================================================
-- 0020_ncba_payments.sql
--
-- NCBA Till STK Push & dynamic QR, per NCBA's API specification (2024).
--
-- ═══ WHAT CHANGES, AND WHY IT MATTERS ══════════════════════════════════════
--
-- The existing payment model was built for Safaricom Daraja, which PUSHES a
-- callback containing the M-Pesa receipt number. NCBA's API does neither:
--
--   1. NO CALLBACK. There is no webhook in the specification. The only way to
--      learn the outcome is to POLL /stk-push/query.
--
--   2. NO RECEIPT NUMBER. The query returns exactly {status, description}.
--      No M-Pesa code, no amount, no payer phone. So a payment can be
--      confirmed as SUCCESS while we still cannot record the Safaricom code
--      that an accountant would reconcile a bank statement against.
--
-- Consequences, both handled below:
--
--   · `mpesa_receipt_number` stays NULLABLE and unset for NCBA payments. We
--     store NCBA's own TransactionID and ReferenceID instead, and mark how
--     the payment was verified so reconciliation is honest about it.
--
--   · `AccountNo` becomes the per-sale reference. This is the field that
--     solves the three-tills-one-number problem the Daraja Buy Goods path
--     could never solve: the payment carries the till and sale reference,
--     so matching is exact instead of scored.
-- ============================================================================

alter table mpesa_transactions
  add column if not exists provider text not null default 'DARAJA'
    check (provider in ('DARAJA','NCBA')),
  add column if not exists provider_txn_id text,
  add column if not exists provider_reference text,
  add column if not exists account_no text,
  add column if not exists verified_by text
    check (verified_by in ('CALLBACK','QUERY','MANUAL','STATEMENT')),
  add column if not exists last_polled_at timestamptz,
  add column if not exists poll_count int not null default 0;

comment on column mpesa_transactions.provider_txn_id is
  'NCBA TransactionID. Used for /stk-push/query and as the correlation key, '
  'because NCBA never returns a Safaricom receipt number.';

comment on column mpesa_transactions.verified_by is
  'How the payment was confirmed. QUERY means NCBA said SUCCESS but supplied '
  'no M-Pesa code — reconcile against the NCBA statement, not against a code.';

comment on column mpesa_transactions.account_no is
  'The AccountNo sent to NCBA. Carries the till and sale reference, which is '
  'what makes NCBA payments exactly matchable.';

-- NCBA TransactionID must be unique per business, the same way a Safaricom
-- receipt number is. Partial so Daraja rows are unaffected.
create unique index if not exists mpesa_provider_txn_unique
  on mpesa_transactions (business_id, provider, provider_txn_id)
  where provider_txn_id is not null;

create index if not exists mpesa_polling_idx
  on mpesa_transactions (business_id, status, last_polled_at)
  where provider = 'NCBA' and status = 'PENDING';

-- ── Register an NCBA STK request ───────────────────────────────────────────
create or replace function register_ncba_stk(
  p_provider_txn_id text,
  p_provider_reference text,
  p_amount_cents bigint,
  p_phone text,
  p_account_no text,
  p_sale_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public, extensions
as $fn$
declare v_id uuid := uuid_generate_v7();
begin
  insert into mpesa_transactions (
    mpesa_txn_id, business_id, provider, channel, direction,
    provider_txn_id, provider_reference, account_no,
    phone_number, amount_cents, status, initiated_at)
  values (
    v_id, auth_business_id(), 'NCBA', 'STK', 'C2B',
    p_provider_txn_id, p_provider_reference, p_account_no,
    p_phone, p_amount_cents, 'PENDING', now());
  return v_id;
end
$fn$;

-- ── Record the outcome of a poll ───────────────────────────────────────────
-- NCBA returns only {status, description}. There is no amount to verify
-- against and no receipt to store, so a SUCCESS is taken at face value and
-- recorded as verified_by = 'QUERY' so the reconciliation screen can show it
-- differently from a Daraja callback.
create or replace function record_ncba_result(
  p_provider_txn_id text,
  p_status text,
  p_description text,
  p_raw jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public
as $fn$
declare v_txn mpesa_transactions%rowtype;
begin
  select * into v_txn from mpesa_transactions
   where provider = 'NCBA' and provider_txn_id = p_provider_txn_id
   for update;

  if not found then
    return jsonb_build_object('status', 'UNKNOWN_TRANSACTION');
  end if;

  update mpesa_transactions
     set last_polled_at = now(), poll_count = poll_count + 1
   where mpesa_txn_id = v_txn.mpesa_txn_id;

  -- Terminal states are never reopened by a later poll.
  if v_txn.status in ('VERIFIED','FAILED','CANCELLED') then
    return jsonb_build_object('status', 'ALREADY_RESOLVED',
                              'mpesa_txn_id', v_txn.mpesa_txn_id,
                              'resolved_as', v_txn.status);
  end if;

  if upper(p_status) = 'SUCCESS' then
    update mpesa_transactions
       set status = 'VERIFIED', verified_by = 'QUERY',
           result_desc = p_description, confirmed_at = now(),
           raw_callback = coalesce(p_raw, raw_callback)
     where mpesa_txn_id = v_txn.mpesa_txn_id;

    update payments set status = 'VERIFIED' where payment_id = v_txn.payment_id;

    return jsonb_build_object('status', 'VERIFIED',
                              'mpesa_txn_id', v_txn.mpesa_txn_id);
  end if;

  if upper(p_status) = 'FAILED' then
    update mpesa_transactions
       set status = 'FAILED', result_desc = p_description,
           raw_callback = coalesce(p_raw, raw_callback)
     where mpesa_txn_id = v_txn.mpesa_txn_id;

    update payments set status = 'FAILED' where payment_id = v_txn.payment_id;

    return jsonb_build_object('status', 'FAILED', 'reason', p_description);
  end if;

  -- Anything else (still processing) leaves it PENDING for the next poll.
  return jsonb_build_object('status', 'PENDING',
                            'mpesa_txn_id', v_txn.mpesa_txn_id);
end
$fn$;

-- ── Which NCBA payments still need polling? ────────────────────────────────
-- Poll for two minutes, then stop: an STK prompt expires and further polling
-- only burns requests. After that it becomes a reconciliation task.
create or replace function ncba_awaiting_result(p_max_age_seconds int default 120)
returns table (
  mpesa_txn_id uuid, provider_txn_id text,
  initiated_at timestamptz, poll_count int
)
language sql stable security definer set search_path = public
as $fn$
  select m.mpesa_txn_id, m.provider_txn_id, m.initiated_at, m.poll_count
    from mpesa_transactions m
   where m.provider = 'NCBA'
     and m.status = 'PENDING'
     and m.provider_txn_id is not null
     and m.initiated_at > now() - make_interval(secs => p_max_age_seconds)
   order by m.initiated_at
$fn$;

-- ── Payments NCBA confirmed but that carry no M-Pesa code ─────────────────
-- Not an error, but the accountant must reconcile these against the NCBA
-- account statement rather than against a Safaricom code. Surfacing them
-- separately is more honest than pretending they are the same as a
-- callback-verified Daraja payment.
create or replace function ncba_statement_reconciliation(
  p_from timestamptz default now() - interval '24 hours',
  p_to   timestamptz default now()
) returns table (
  mpesa_txn_id uuid, provider_txn_id text, provider_reference text,
  account_no text, amount_cents bigint, phone_number text,
  confirmed_at timestamptz, local_ref text, cashier text
)
language sql stable security definer set search_path = public
as $fn$
  select m.mpesa_txn_id, m.provider_txn_id, m.provider_reference,
         m.account_no, m.amount_cents, m.phone_number, m.confirmed_at,
         s.local_ref, c.full_name
    from mpesa_transactions m
    left join payments p on p.payment_id = m.payment_id
    left join sales s    on s.sale_id = p.sale_id
    left join cashiers c on c.cashier_id = s.cashier_id
   where m.business_id = auth_business_id()
     and m.provider = 'NCBA'
     and m.status = 'VERIFIED'
     and m.verified_by = 'QUERY'
     and m.mpesa_receipt_number is null
     and m.confirmed_at between p_from and p_to
   order by m.confirmed_at desc
$fn$;

grant execute on function register_ncba_stk(text, text, bigint, text, text, uuid)
  to authenticated;
grant execute on function ncba_statement_reconciliation(timestamptz, timestamptz)
  to authenticated;
revoke execute on function record_ncba_result(text, text, text, jsonb)
  from authenticated, anon;
revoke execute on function ncba_awaiting_result(int) from authenticated, anon;
