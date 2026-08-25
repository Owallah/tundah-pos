-- ============================================================================
-- 0013_fix_pgcrypto_search_path.sql
--
-- Fixes "That PIN is not correct" for a correct PIN.
--
-- On Supabase, pgcrypto is installed into the `extensions` schema, not
-- `public`. Every function declared `set search_path = public` therefore
-- cannot resolve crypt(), gen_salt() or gen_random_bytes(), and raises
-- `function crypt(text, text) does not exist`.
--
-- Seeding still worked, because demo.sql runs in the SQL Editor as postgres
-- with `extensions` already on the path. The failure only appears at runtime,
-- inside the SECURITY DEFINER functions — which is the most confusing place
-- for it to appear.
--
-- The fix is to put `extensions` on the search_path of every function that
-- touches pgcrypto. Same root cause as the auth hook in 0012: a restricted
-- search_path that did not include what the function actually needs.
-- ============================================================================

-- ── PIN verification ────────────────────────────────────────────────────────
create or replace function verify_cashier_pin(p_cashier_id uuid, p_pin text)
returns table (
  cashier_id uuid, full_name text, role user_role,
  max_discount_bp int, can_void boolean, can_override_price boolean
)
language plpgsql
security definer
set search_path = public, extensions      -- ← crypt() lives in extensions
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

  -- Distinguish "no such cashier for this business" from "wrong PIN".
  -- The first almost always means the JWT has no business_id, i.e. the auth
  -- hook is not returning claims — a setup problem wearing a wrong-PIN mask.
  if not found then
    raise exception 'cashier_not_found_for_business' using errcode = '28000',
      hint = 'No active cashier with that id in this business. If the roster '
             'is visible but this fails, the JWT is missing business_id: '
             'check the Custom Access Token hook.';
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

-- ── Setting a PIN ───────────────────────────────────────────────────────────
create or replace function set_cashier_pin(p_cashier_id uuid, p_pin text)
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

-- ── Anything else that touches pgcrypto ─────────────────────────────────────
-- etims_write_invoice uses gen_random_bytes() for the public receipt token.
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

grant execute on function verify_cashier_pin(uuid, text) to authenticated;
grant execute on function set_cashier_pin(uuid, text)    to authenticated;
revoke execute on function etims_write_invoice(uuid, bigint, bigint, text, text,
  timestamptz, text, text, jsonb) from authenticated, anon;

-- ── Diagnostic ──────────────────────────────────────────────────────────────
-- Confirms pgcrypto resolves and that a specific PIN matches its stored hash,
-- without going through the app.
--
--   select * from test_pin('Achieng', '100100');
create or replace function test_pin(p_name text, p_pin text)
returns table (
  cashier text, pgcrypto_ok boolean, pin_matches boolean, note text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_crypto boolean := false;
begin
  begin
    perform extensions.crypt('x', extensions.gen_salt('bf', 4));
    v_crypto := true;
  exception when others then
    v_crypto := false;
  end;

  select pin_hash into v_hash from cashiers
   where full_name ilike '%' || p_name || '%' and is_active
   limit 1;

  if v_hash is null then
    return query select p_name, v_crypto, false,
      'No active cashier matching that name. Did demo.sql run?'::text;
    return;
  end if;

  return query select
    p_name,
    v_crypto,
    v_hash = extensions.crypt(p_pin, v_hash),
    case
      when not v_crypto then 'pgcrypto is not reachable — check the extensions schema'
      when v_hash = extensions.crypt(p_pin, v_hash) then 'PIN is correct'
      else 'PIN does not match the stored hash'
    end::text;
end $$;

grant execute on function test_pin(text, text) to authenticated;
