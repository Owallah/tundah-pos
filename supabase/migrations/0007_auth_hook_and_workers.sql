-- ============================================================================
-- 0007_auth_hook_and_workers.sql
-- Custom JWT claims, the strictly-ordered eTIMS queue claim, the fiscal
-- invoice writer, and pg_cron schedules.
--
-- pg_cron + pg_net replace a worker service entirely. No Redis, no queue
-- service, no container. ARCHITECTURE §A.
-- ============================================================================

-- ── Custom Access Token Hook ────────────────────────────────────────────────
-- Injects business_id / user_role / device_id into every JWT so RLS policies
-- can read them without a per-query join.
--
-- Enable in the Supabase dashboard:
--   Authentication -> Hooks -> Customize Access Token (JWT) Claims
create or replace function custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable
as $$
declare
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_user   record;
  v_device record;
begin
  select u.business_id, u.role::text as role
    into v_user
    from users u
   where u.user_id = (event ->> 'user_id')::uuid
     and u.is_active;

  if v_user.business_id is null then
    return event;   -- unknown or deactivated user: no claims, RLS denies all
  end if;

  v_claims := jsonb_set(v_claims, '{business_id}', to_jsonb(v_user.business_id));
  v_claims := jsonb_set(v_claims, '{user_role}',   to_jsonb(v_user.role));

  -- A till's auth account maps to exactly one device.
  select d.device_id, d.code
    into v_device
    from devices d
   where d.auth_user_id = (event ->> 'user_id')::uuid
     and d.is_active;

  if v_device.device_id is not null then
    v_claims := jsonb_set(v_claims, '{device_id}',   to_jsonb(v_device.device_id));
    v_claims := jsonb_set(v_claims, '{device_code}', to_jsonb(v_device.code));
  end if;

  return jsonb_set(event, '{claims}', v_claims);
end $$;

grant execute on function custom_access_token_hook(jsonb) to supabase_auth_admin;
grant usage on schema public to supabase_auth_admin;
grant select on users, devices to supabase_auth_admin;
revoke execute on function custom_access_token_hook(jsonb) from authenticated, anon, public;

-- ============================================================================
-- eTIMS queue: claim exactly ONE submission, in order.
--
-- ⚠️ SINGLE WORKER BY DESIGN. KRA requires sale -> stockIO -> stockMaster and
-- returns 921/922 if that order is broken (ARCHITECTURE §0.3). Do NOT raise
-- the limit, and do NOT run two workers. A backlog drains serially.
-- ============================================================================
create or replace function etims_claim_next(p_business_id uuid)
returns setof etims_submissions
language plpgsql
security definer set search_path = public
as $$
declare v_row etims_submissions%rowtype;
begin
  -- A halted queue must not be drained until a human clears it.
  if exists (
    select 1 from etims_submissions
     where business_id = p_business_id and status = 'REJECTED'
  ) then
    return;
  end if;

  select * into v_row
    from etims_submissions
   where business_id = p_business_id
     and status in ('PENDING','FAILED')
     and next_attempt_at <= now()
   order by seq
   limit 1
   for update skip locked;

  if not found then
    return;
  end if;

  update etims_submissions
     set status = 'SUBMITTING', attempts = attempts + 1
   where submission_id = v_row.submission_id
  returning * into v_row;

  return next v_row;
end $$;

comment on function etims_claim_next is
  'Claims ONE submission in seq order. FOR UPDATE SKIP LOCKED makes concurrent '
  'invocations safe, but ordering means only one may usefully run at a time.';

-- ── Record the outcome of a submission ──────────────────────────────────────
create or replace function etims_record_result(
  p_submission_id uuid,
  p_result_cd     text,
  p_response      jsonb,
  p_error         text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_attempts int;
  v_backoff  interval;
begin
  select attempts into v_attempts
    from etims_submissions where submission_id = p_submission_id;

  if p_result_cd = '000' or p_result_cd = '994' then
    -- 994 = duplicate data. KRA already has it; treat as success (idempotent).
    update etims_submissions
       set status = 'SUBMITTED', result_cd = p_result_cd,
           response_body = p_response, submitted_at = now(), last_error = null
     where submission_id = p_submission_id;

  elsif p_result_cd in ('921','922') then
    -- Ordering violation. HALT. Pushing more requests makes reconciliation worse.
    update etims_submissions
       set status = 'REJECTED', result_cd = p_result_cd,
           response_body = p_response, last_error = coalesce(p_error, 'ordering violation')
     where submission_id = p_submission_id;

    insert into audit_logs (business_id, action, entity_type, entity_id, after_state)
    select business_id, 'ETIMS_QUEUE_HALTED', 'etims_submission', submission_id,
           jsonb_build_object('result_cd', p_result_cd, 'response', p_response)
      from etims_submissions where submission_id = p_submission_id;

  else
    -- Retryable. 1m -> 5m -> 15m -> 1h -> 6h (cap).
    v_backoff := case
      when v_attempts <= 1 then interval '1 minute'
      when v_attempts = 2  then interval '5 minutes'
      when v_attempts = 3  then interval '15 minutes'
      when v_attempts = 4  then interval '1 hour'
      else interval '6 hours'
    end;

    update etims_submissions
       set status = 'FAILED', result_cd = p_result_cd,
           response_body = p_response, last_error = p_error,
           next_attempt_at = now() + v_backoff
     where submission_id = p_submission_id;
  end if;
end $$;

-- ── Write the fiscal invoice. The ONLY place invcNo is allocated. ──────────
create or replace function etims_write_invoice(
  p_sale_id       uuid,
  p_cur_rcpt_no   bigint,
  p_tot_rcpt_no   bigint,
  p_intrl_data    text,
  p_rcpt_sign     text,
  p_sdc_date_time timestamptz,
  p_pmt_ty_cd     text,
  p_qr_payload    text,
  p_receipt_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_sale    sales%rowtype;
  v_invc_no bigint;
  v_token   text;
begin
  select * into v_sale from sales where sale_id = p_sale_id;
  if not found then
    raise exception 'unknown_sale %', p_sale_id;
  end if;

  -- Already fiscalised: idempotent no-op.
  if exists (select 1 from invoices where sale_id = p_sale_id) then
    return (select jsonb_build_object('status','ALREADY_FISCALISED','invc_no',invc_no)
              from invoices where sale_id = p_sale_id);
  end if;

  v_invc_no := nextval('etims_invc_no_seq');
  v_token   := encode(gen_random_bytes(32), 'base64');
  v_token   := replace(replace(replace(v_token, '+', '-'), '/', '_'), '=', '');

  insert into invoices (
    sale_id, business_id, invc_no, trd_invc_no,
    cur_rcpt_no, tot_rcpt_no, intrl_data, rcpt_sign, sdc_date_time,
    rcpt_ty_cd, pmt_ty_cd, qr_payload, receipt_payload, public_token)
  values (
    p_sale_id, v_sale.business_id, v_invc_no, v_sale.local_ref,
    p_cur_rcpt_no, p_tot_rcpt_no, p_intrl_data, p_rcpt_sign, p_sdc_date_time,
    'S', p_pmt_ty_cd, p_qr_payload, p_receipt_payload, v_token);

  -- Now that the sale is accepted, the stock movements may be sent. §0.3
  insert into etims_submissions (business_id, kind, movement_id, sale_id, request_body)
  select v_sale.business_id, 'STOCK_IO', m.movement_id, p_sale_id,
         jsonb_build_object('movement_id', m.movement_id)
    from stock_movements m
   where m.sale_id = p_sale_id and m.etims_status = 'PENDING';

  return jsonb_build_object(
    'status', 'FISCALISED', 'invc_no', v_invc_no, 'public_token', v_token);
end $$;

revoke execute on function etims_claim_next(uuid)      from authenticated, anon;
revoke execute on function etims_record_result(uuid, text, jsonb, text) from authenticated, anon;
revoke execute on function etims_write_invoice(uuid, bigint, bigint, text, text,
       timestamptz, text, text, jsonb) from authenticated, anon;

-- ── Queue health, for the owner dashboard ───────────────────────────────────
create or replace function etims_queue_health(p_business_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'pending',       count(*) filter (where status in ('PENDING','FAILED')),
    'submitted',     count(*) filter (where status = 'SUBMITTED'),
    'halted',        count(*) filter (where status = 'REJECTED') > 0,
    'oldest_pending_at', min(created_at) filter (where status in ('PENDING','FAILED')),
    'oldest_pending_age_minutes',
      extract(epoch from (now() - min(created_at)
        filter (where status in ('PENDING','FAILED')))) / 60)
  from etims_submissions
  where business_id = p_business_id
$$;
grant execute on function etims_queue_health(uuid) to authenticated;

-- ============================================================================
-- Scheduled workers. Replace the URL and key placeholders after deploy.
-- ============================================================================

-- eTIMS submission worker: every minute.
select cron.schedule(
  'etims-drain',
  '* * * * *',
  $cron$
  select net.http_post(
    url     := current_setting('app.edge_base_url', true) || '/etims-worker',
    headers := jsonb_build_object(
                 'Content-Type','application/json',
                 'Authorization','Bearer ' || current_setting('app.edge_service_key', true)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);
  $cron$
);

-- M-Pesa status reconciler: every 5 minutes, for STK payments with no callback.
select cron.schedule(
  'mpesa-reconcile',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url     := current_setting('app.edge_base_url', true) || '/mpesa-reconcile',
    headers := jsonb_build_object(
                 'Content-Type','application/json',
                 'Authorization','Bearer ' || current_setting('app.edge_service_key', true)),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000);
  $cron$
);

-- Nightly integrity check: the balance cache must equal the ledger.
select cron.schedule(
  'stock-integrity-check',
  '15 2 * * *',
  $cron$
  insert into audit_logs (business_id, action, entity_type, after_state)
  select b.business_id, 'STOCK_INTEGRITY_CHECK', 'stock_balances',
         jsonb_build_object('drifted_rows', (
           select count(*) from (
             select sb.product_id, sb.location_id, sb.qty_on_hand,
                    coalesce(sum(sm.qty_delta), 0) as ledger_qty
               from stock_balances sb
               left join stock_movements sm
                 on sm.product_id = sb.product_id
                and sm.location_id = sb.location_id
              where sb.business_id = b.business_id
              group by sb.product_id, sb.location_id, sb.qty_on_hand
             having sb.qty_on_hand <> coalesce(sum(sm.qty_delta), 0)
           ) d))
    from businesses b;
  $cron$
);
