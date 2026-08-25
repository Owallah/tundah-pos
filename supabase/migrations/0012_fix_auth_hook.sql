-- ============================================================================
-- 0012_fix_auth_hook.sql
--
-- Fixes "Error running hook URI: pg-functions://postgres/public/
-- custom_access_token_hook".
--
-- The original definition in 0007 had two defects:
--
--   1. NO `set search_path`. Supabase Auth invokes the hook with a restricted
--      search path, so the bare table names `users` and `devices` did not
--      resolve and the function raised. This is the error you see at login.
--
--   2. NOT `security definer`. RLS is enabled on both tables (0006) and
--      `supabase_auth_admin` is not their owner, so RLS applies to it. Even
--      with the search path fixed it would read zero rows and hand back a
--      token with no claims — a silent failure that looks like an empty
--      catalogue rather than an error.
--
-- SECURITY DEFINER is safe here: the function reads exactly two rows, keyed
-- by the user_id Auth itself supplies, and returns only claims. It cannot be
-- called by anon or authenticated (revoked below).
-- ============================================================================

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer                 -- ← runs as owner, so RLS does not block it
set search_path = public         -- ← the actual cause of the login error
as $$
declare
  v_claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  v_user_id uuid;
  v_business_id uuid;
  v_role text;
  v_device_id uuid;
  v_device_code text;
begin
  -- Defensive: a malformed event must not take down every login.
  begin
    v_user_id := (event ->> 'user_id')::uuid;
  exception when others then
    return event;
  end;

  if v_user_id is null then
    return event;
  end if;

  select u.business_id, u.role::text
    into v_business_id, v_role
    from public.users u
   where u.user_id = v_user_id
     and u.is_active;

  -- Unknown or deactivated user: issue a token with no business claims.
  -- Every RLS policy then denies, which is the correct default.
  if v_business_id is null then
    return event;
  end if;

  v_claims := jsonb_set(v_claims, '{business_id}', to_jsonb(v_business_id));
  v_claims := jsonb_set(v_claims, '{user_role}',   to_jsonb(v_role));

  -- A till's auth account maps to exactly one device.
  select d.device_id, d.code
    into v_device_id, v_device_code
    from public.devices d
   where d.auth_user_id = v_user_id
     and d.is_active;

  if v_device_id is not null then
    v_claims := jsonb_set(v_claims, '{device_id}',   to_jsonb(v_device_id));
    v_claims := jsonb_set(v_claims, '{device_code}', to_jsonb(v_device_code));
  end if;

  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

-- ── Permissions ─────────────────────────────────────────────────────────────
-- Auth runs as supabase_auth_admin, which needs to reach the schema and the
-- function. Nobody else may call it.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb)
  to supabase_auth_admin;

revoke execute on function public.custom_access_token_hook(jsonb)
  from authenticated, anon, public;

-- Belt and braces: even with SECURITY DEFINER, keep the direct grants and add
-- read policies for supabase_auth_admin. If a later migration drops SECURITY
-- DEFINER, the hook degrades to returning no claims rather than erroring.
grant select on public.users   to supabase_auth_admin;
grant select on public.devices to supabase_auth_admin;

drop policy if exists users_auth_admin_read on public.users;
create policy users_auth_admin_read on public.users
  for select to supabase_auth_admin using (true);

drop policy if exists devices_auth_admin_read on public.devices;
create policy devices_auth_admin_read on public.devices
  for select to supabase_auth_admin using (true);

-- ── Diagnostic ──────────────────────────────────────────────────────────────
-- Exercises the hook exactly as Auth does, and shows the real error if it
-- still fails. Far more informative than the message the login screen gets.
--
--   select * from test_auth_hook('till01@nyota.local');
create or replace function public.test_auth_hook(p_email text)
returns table (result jsonb, has_business_id boolean, has_device_id boolean)
language plpgsql
security definer set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_out jsonb;
begin
  select id into v_user_id from auth.users where email = p_email;

  if v_user_id is null then
    raise exception 'No auth user with email %. Create it in Authentication → Users.', p_email;
  end if;

  v_out := public.custom_access_token_hook(
    jsonb_build_object('user_id', v_user_id, 'claims', '{}'::jsonb));

  return query select
    v_out,
    (v_out #>> '{claims,business_id}') is not null,
    (v_out #>> '{claims,device_id}')   is not null;
end;
$$;

comment on function public.test_auth_hook is
  'Runs the JWT hook for a given email and reports whether claims came out. '
  'has_business_id false means the users row is missing or inactive; '
  'has_device_id false on a till account means link_till() was not run.';
