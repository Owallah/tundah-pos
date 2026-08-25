-- ============================================================================
-- 0011_webhook_log.sql
--
-- Every inbound webhook is stored VERBATIM before any parsing.
--
-- This is the cheapest debugging insurance in the system. When a payment
-- "didn't arrive", the first question is always whether Safaricom sent it.
-- Without this table that question is unanswerable; with it, it takes ten
-- seconds. It has also caught payload shape changes that would otherwise
-- have looked like random data loss.
-- ============================================================================

create table webhook_log (
  log_id     bigserial primary key,
  kind       text not null,
  source_ip  text,
  payload    jsonb not null,
  received_at timestamptz not null default now()
);

create index webhook_log_kind_idx on webhook_log (kind, received_at desc);
create index webhook_log_recent   on webhook_log (received_at desc);

-- Written only by Edge Functions (service role). Read only by staff.
alter table webhook_log enable row level security;
revoke insert, update, delete on webhook_log from authenticated, anon;

create policy webhook_log_select on webhook_log for select to authenticated
  using (auth_is_staff());

-- Append-only: a debugging record that can be edited is not a debugging record.
create trigger webhook_log_immutable
  before update or delete on webhook_log
  for each row execute function forbid_mutation();

-- Retain 90 days. Raw callbacks contain phone numbers and payer names, so
-- keeping them indefinitely is a privacy liability rather than an asset.
select cron.schedule(
  'webhook-log-prune',
  '30 3 * * *',
  $cron$
    delete from webhook_log where received_at < now() - interval '90 days';
  $cron$
);

-- ── Did Safaricom actually send it? ────────────────────────────────────────
create or replace function find_webhook(p_search text)
returns table (log_id bigint, kind text, source_ip text,
               payload jsonb, received_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select w.log_id, w.kind, w.source_ip, w.payload, w.received_at
    from webhook_log w
   where auth_is_staff()
     and w.payload::text ilike '%' || p_search || '%'
   order by w.received_at desc
   limit 50
$$;

grant execute on function find_webhook(text) to authenticated;
