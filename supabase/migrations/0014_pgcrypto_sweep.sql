-- ============================================================================
-- 0014_pgcrypto_sweep.sql
--
-- Fixes "function gen_random_bytes(integer) does not exist" and closes this
-- class of bug for good.
--
-- ROOT CAUSE (third time, so worth stating plainly):
-- Supabase installs pgcrypto into the `extensions` schema, not `public`.
-- Any function that either
--   (a) declares `set search_path = public`, or
--   (b) declares no search_path and is CALLED BY one that does
-- cannot resolve crypt(), gen_salt() or gen_random_bytes().
--
-- Case (b) is what bit us here. `uuid_generate_v7()` had no search_path, so
-- it inherited the caller's. It is the DEFAULT on roughly fifteen tables and
-- is called inside open_shift() and complete_sale(), so it blocked the entire
-- write path while looking like an unrelated failure.
--
-- FIX, applied belt-and-braces:
--   1. Every pgcrypto call is SCHEMA-QUALIFIED as extensions.foo().
--   2. Every function that uses one declares
--      `set search_path = public, extensions`.
--   3. A guard at the bottom fails loudly if pgcrypto is somewhere else.
--
-- Qualifying alone would be enough. Doing both means a future function that
-- forgets to qualify still works, and one that forgets the search_path also
-- still works.
-- ============================================================================

-- ── Guard: confirm where pgcrypto actually lives ───────────────────────────
do $$
declare v_schema text;
begin
  select n.nspname into v_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  if v_schema is null then
    raise exception
      'pgcrypto is not installed. Enable it: Database -> Extensions -> pgcrypto.';
  end if;

  if v_schema <> 'extensions' then
    raise warning
      'pgcrypto is in schema "%", not "extensions". This migration qualifies '
      'calls as extensions.foo() and will not work as written. Adjust the '
      'schema prefix throughout, or move the extension.', v_schema;
  end if;
end $$;

-- ── uuid_generate_v7: the one that broke the write path ────────────────────
create or replace function public.uuid_generate_v7()
returns uuid
language plpgsql
parallel safe
set search_path = public, extensions
as $$
declare
  unix_ts_ms bytea;
  uuid_bytes bytea;
begin
  unix_ts_ms := substring(
    int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);

  -- Schema-qualified: this function is called from contexts whose
  -- search_path we do not control (table DEFAULTs, other SECURITY DEFINER
  -- functions, PostgREST).
  uuid_bytes := unix_ts_ms || extensions.gen_random_bytes(10);

  uuid_bytes := set_byte(uuid_bytes, 6,
    (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  uuid_bytes := set_byte(uuid_bytes, 8,
    (b'10'   || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);

  return encode(uuid_bytes, 'hex')::uuid;
end $$;

comment on function public.uuid_generate_v7 is
  'Time-sortable UUID. Client-generatable, so offline records in v2 can be '
  'created without a round-trip. search_path is pinned because this runs as '
  'a column DEFAULT under whatever path the caller happens to have.';

-- ── Receipt tokens ──────────────────────────────────────────────────────────
create or replace function public.etims_write_invoice(
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
language plpgsql
security definer
set search_path = public, extensions
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

  if exists (select 1 from invoices where sale_id = p_sale_id) then
    return (select jsonb_build_object('status','ALREADY_FISCALISED','invc_no',invc_no)
              from invoices where sale_id = p_sale_id);
  end if;

  v_invc_no := nextval('etims_invc_no_seq');
  v_token   := encode(extensions.gen_random_bytes(32), 'base64');
  v_token   := replace(replace(replace(v_token, '+', '-'), '/', '_'), '=', '');

  insert into invoices (
    sale_id, business_id, invc_no, trd_invc_no,
    cur_rcpt_no, tot_rcpt_no, intrl_data, rcpt_sign, sdc_date_time,
    rcpt_ty_cd, pmt_ty_cd, qr_payload, receipt_payload, public_token)
  values (
    p_sale_id, v_sale.business_id, v_invc_no, v_sale.local_ref,
    p_cur_rcpt_no, p_tot_rcpt_no, p_intrl_data, p_rcpt_sign, p_sdc_date_time,
    'S', p_pmt_ty_cd, p_qr_payload, p_receipt_payload, v_token);

  insert into etims_submissions (business_id, kind, movement_id, sale_id, request_body)
  select v_sale.business_id, 'STOCK_IO', m.movement_id, p_sale_id,
         jsonb_build_object('movement_id', m.movement_id)
    from stock_movements m
   where m.sale_id = p_sale_id and m.etims_status = 'PENDING';

  return jsonb_build_object(
    'status', 'FISCALISED', 'invc_no', v_invc_no, 'public_token', v_token);
end $$;

revoke execute on function public.etims_write_invoice(uuid, bigint, bigint,
  text, text, timestamptz, text, text, jsonb) from authenticated, anon;

-- ── PIN functions (qualified, superseding 0013) ────────────────────────────
create or replace function public.verify_cashier_pin(p_cashier_id uuid, p_pin text)
returns table (
  cashier_id uuid, full_name text, role user_role,
  max_discount_bp int, can_void boolean, can_override_price boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v record;
  v_recent_failures int;
begin
  select count(*) into v_recent_failures
    from pin_attempts
   where pin_attempts.cashier_id = p_cashier_id
     and not succeeded
     and attempted_at > now() - interval '5 minutes';

  if v_recent_failures >= 5 then
    raise exception 'pin_locked' using errcode = '28000',
      hint = 'Too many failed attempts. A supervisor must unlock this cashier.';
  end if;

  select * into v from cashiers c
   where c.cashier_id = p_cashier_id
     and c.business_id = auth_business_id()
     and c.is_active;

  if not found then
    raise exception 'cashier_not_found_for_business' using errcode = '28000',
      hint = 'No active cashier with that id in this business. If the roster '
             'is visible but this fails, the JWT is missing business_id.';
  end if;

  if v.pin_hash <> extensions.crypt(p_pin, v.pin_hash) then
    insert into pin_attempts (cashier_id, device_id, succeeded)
    values (p_cashier_id, auth_device_id(), false);

    insert into audit_logs (business_id, action, entity_type, entity_id, device_id)
    values (auth_business_id(), 'PIN_FAILURE', 'cashier', p_cashier_id, auth_device_id());

    raise exception 'invalid_pin' using errcode = '28000';
  end if;

  insert into pin_attempts (cashier_id, device_id, succeeded)
  values (p_cashier_id, auth_device_id(), true);

  return query
    select v.cashier_id, v.full_name, v.role,
           v.max_discount_bp, v.can_void, v.can_override_price;
end $$;

create or replace function public.set_cashier_pin(p_cashier_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'PIN must be 4 to 6 digits' using errcode = '22023';
  end if;

  update cashiers
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10))
   where cashier_id = p_cashier_id and business_id = auth_business_id();

  if not found then
    raise exception 'unknown_cashier' using errcode = '23503';
  end if;
end $$;

grant execute on function public.verify_cashier_pin(uuid, text) to authenticated;
grant execute on function public.set_cashier_pin(uuid, text)    to authenticated;

-- ── Self-test ───────────────────────────────────────────────────────────────
-- Exercises every pgcrypto path the app uses, in one call:
--
--   select * from test_crypto();
create or replace function public.test_crypto()
returns table (check_name text, ok boolean, detail text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_schema text;
  v_uuid uuid;
  v_hash text;
begin
  select n.nspname into v_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  return query select 'pgcrypto installed'::text, v_schema is not null,
    coalesce('schema: ' || v_schema, 'NOT INSTALLED')::text;

  begin
    v_uuid := public.uuid_generate_v7();
    return query select 'uuid_generate_v7'::text, true, v_uuid::text;
  exception when others then
    return query select 'uuid_generate_v7'::text, false, sqlerrm::text;
  end;

  begin
    v_hash := extensions.crypt('test', extensions.gen_salt('bf', 4));
    return query select 'crypt / gen_salt'::text,
      v_hash = extensions.crypt('test', v_hash), 'round-trip'::text;
  exception when others then
    return query select 'crypt / gen_salt'::text, false, sqlerrm::text;
  end;

  begin
    perform encode(extensions.gen_random_bytes(32), 'base64');
    return query select 'gen_random_bytes'::text, true, 'receipt tokens'::text;
  exception when others then
    return query select 'gen_random_bytes'::text, false, sqlerrm::text;
  end;
end $$;

grant execute on function public.test_crypto() to authenticated;
