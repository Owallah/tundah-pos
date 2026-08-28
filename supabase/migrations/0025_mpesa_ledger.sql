-- 0025_mpesa_ledger.sql
--
-- The reconciliation screen only ever showed rows that need a decision
-- (mismatch, unverified manual, unmatched) plus a bare total for anything
-- already verified. There was no screen answering the plain question
-- "show me every M-Pesa transaction for this event" — verified ones
-- included, in one browsable, exportable list.
--
-- This is deliberately a SEPARATE function from mpesa_reconciliation(), not
-- an extension of it. Several of the existing buckets (unmatched money,
-- STK still pending) are, by definition, not yet linked to any sale — and
-- therefore not yet linked to any event. Forcing an event filter onto those
-- would hide genuine problems instead of surfacing them. This new ledger
-- is a browsing/audit view; the six buckets stay exactly as they were.

create or replace function mpesa_ledger(
  p_event_id uuid default null,
  p_from     timestamptz default now() - interval '24 hours',
  p_to       timestamptz default now()
) returns table (
  mpesa_txn_id uuid,
  channel      text,
  provider     text,
  status       payment_status,
  mpesa_receipt_number text,
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
    m.mpesa_receipt_number, m.amount_cents,
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
    -- A row with no linked sale (unmatched money, or an STK push abandoned
    -- before a sale was ever completed) cannot be attributed to an event.
    -- Selecting a specific event hides those rows rather than mislabels
    -- them; leaving the filter on "all events" still shows everything.
    and (p_event_id is null or s.event_id = p_event_id)
  order by coalesce(m.confirmed_at, m.initiated_at) desc
  limit 500
$$;

grant execute on function mpesa_ledger(uuid, timestamptz, timestamptz) to authenticated;

comment on function mpesa_ledger is
  'Every M-Pesa transaction (any status, any channel) for a business, '
  'optionally scoped to one event. A browsing/audit view — distinct from '
  'mpesa_reconciliation(), which only surfaces rows needing a decision.';