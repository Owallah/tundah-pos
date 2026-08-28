-- 0026_ledger_ncba_code.sql
--
-- The "Code / receipt" column in the new all-transactions ledger only ever
-- read mpesa_receipt_number — which NCBA never populates (see the column
-- comment on mpesa_transactions.provider_txn_id: "because NCBA never
-- returns a Safaricom receipt number"). Every NCBA row was showing a blank
-- dash instead of any code at all.
--
-- NCBA's own equivalent identifier is provider_txn_id (its TransactionID,
-- already used as the correlation key for polling). Surface it as a
-- fallback so the column always shows something identifying the
-- transaction, and add provider_reference (NCBA's ReferenceID) alongside it
-- since it is sometimes the more human-readable of the two.
--
-- CREATE OR REPLACE cannot change the output columns of a RETURNS TABLE
-- function (Postgres error 42P13) — it has to be dropped and recreated.

drop function if exists mpesa_ledger(uuid, timestamptz, timestamptz);

create function mpesa_ledger(
  p_event_id uuid default null,
  p_from     timestamptz default now() - interval '24 hours',
  p_to       timestamptz default now()
) returns table (
  mpesa_txn_id uuid,
  channel      text,
  provider     text,
  status       payment_status,
  mpesa_receipt_number text,
  provider_txn_id      text,
  provider_reference   text,
  amount_cents bigint,
  phone_number text,
  payer_name   text,
  initiated_at timestamptz,
  confirmed_at timestamptz,
  local_ref    text,
  cashier      text,
  event_name   text
)
language sql stable security definer set search_path = public
as $$
  select
    m.mpesa_txn_id, m.channel, m.provider, m.status,
    m.mpesa_receipt_number, m.provider_txn_id, m.provider_reference,
    m.amount_cents,
    m.phone_number, m.payer_name,
    m.initiated_at, m.confirmed_at,
    s.local_ref, c.full_name as cashier, e.name as event_name
  from mpesa_transactions m
  left join payments p on p.payment_id = m.payment_id
  left join sales    s on s.sale_id    = p.sale_id
  left join cashiers c on c.cashier_id = s.cashier_id
  left join events   e on e.event_id   = s.event_id
  where m.business_id = auth_business_id()
    and coalesce(m.confirmed_at, m.initiated_at) between p_from and p_to
    and (p_event_id is null or s.event_id = p_event_id)
  order by coalesce(m.confirmed_at, m.initiated_at) desc
  limit 500
$$;

grant execute on function mpesa_ledger(uuid, timestamptz, timestamptz) to authenticated;