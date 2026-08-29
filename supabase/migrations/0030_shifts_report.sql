-- 0029_shifts_report.sql
--
-- Items 5 and 9 from the gap-analysis list turned out to be one problem,
-- not two: `shifts` already has everything needed — opened_at, closed_at,
-- opening_float_cents, counted_cash_cents, expected_cash_cents, a generated
-- variance_cents, and close_notes (the cashier's explanation, captured by
-- ShiftClose.tsx already). None of it was ever exposed to the owner —
-- there was no admin screen that read any of these columns at all.
--
-- This is a read-only listing function; no new data capture needed.

create or replace function list_shifts(
  p_from  timestamptz default now() - interval '7 days',
  p_to    timestamptz default now(),
  p_event_id uuid default null
) returns table (
  shift_id uuid,
  cashier  text,
  device_code text,
  event_name  text,
  status   text,
  opened_at  timestamptz,
  closed_at  timestamptz,
  opening_float_cents bigint,
  counted_cash_cents  bigint,
  expected_cash_cents bigint,
  variance_cents      bigint,
  close_notes text,
  closed_with_unresolved_doubt boolean
)
language sql stable security definer set search_path = public
as $$
  select
    s.shift_id, c.full_name, d.code, e.name, s.status,
    s.opened_at, s.closed_at,
    s.opening_float_cents, s.counted_cash_cents, s.expected_cash_cents,
    s.variance_cents, s.close_notes, s.closed_with_unresolved_doubt
  from shifts s
  join cashiers c on c.cashier_id = s.cashier_id
  join devices  d on d.device_id  = s.device_id
  join events   e on e.event_id   = s.event_id
  where s.business_id = auth_business_id()
    and auth_is_staff()
    and s.opened_at between p_from and p_to
    and (p_event_id is null or s.event_id = p_event_id)
  order by s.opened_at desc
  limit 500
$$;

grant execute on function list_shifts(timestamptz, timestamptz, uuid) to authenticated;
