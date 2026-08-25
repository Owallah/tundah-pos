-- ============================================================================
-- 0001_foundation.sql
-- Extensions, enums, immutability guard, JWT claim helpers.
-- ============================================================================

create extension if not exists pgcrypto;      -- gen_random_uuid, crypt, gen_salt
create extension if not exists pg_cron;       -- scheduled workers (no external service)
create extension if not exists pg_net;        -- HTTP from Postgres -> Edge Functions

-- ── UUIDv7 ──────────────────────────────────────────────────────────────────
-- Time-sortable UUIDs. Client-generated so that v2 offline records can be
-- created without a round-trip. See ARCHITECTURE §C.7.
create or replace function uuid_generate_v7()
returns uuid
language plpgsql
parallel safe
as $$
declare
  unix_ts_ms bytea;
  uuid_bytes bytea;
begin
  unix_ts_ms := substring(int8send((extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  uuid_bytes := unix_ts_ms || gen_random_bytes(10);
  -- version 7
  uuid_bytes := set_byte(uuid_bytes, 6, (b'0111' || get_byte(uuid_bytes, 6)::bit(4))::bit(8)::int);
  -- variant 10xx
  uuid_bytes := set_byte(uuid_bytes, 8, (b'10'   || get_byte(uuid_bytes, 8)::bit(6))::bit(8)::int);
  return encode(uuid_bytes, 'hex')::uuid;
end $$;

-- ── Enums ───────────────────────────────────────────────────────────────────

create type user_role as enum ('OWNER','SUPERVISOR','CASHIER','DEVICE');

create type sale_status as enum ('DRAFT','PARKED','COMPLETED','VOIDED');

create type payment_method as enum ('CASH','MPESA_C2B','MPESA_STK','MPESA_MANUAL','CARD','OTHER');

create type payment_status as enum
  ('PENDING','VERIFIED','FAILED','MISMATCH','DUPLICATE','CANCELLED','UNMATCHED');

create type movement_type as enum (
  'PURCHASE',     -- goods received from supplier
  'LOAD_OUT',     -- base store -> van/event
  'LOAD_BACK',    -- van/event -> base store
  'SALE',
  'RETURN',
  'ADJUSTMENT',
  'STOCK_TAKE',
  'SHRINKAGE',
  'WASTAGE',      -- perishable spoilage. First-class for fresh produce.
  'SAMPLE',       -- free samples / staff consumption
  'TRANSFER'
);

-- v1: only ALLOW is used (no pre-orders -> nothing is fulfilled later).
-- Retained as an enum so v2 can extend without a type migration.
create type stock_policy as enum ('ALLOW','BLOCK_IF_UNAVAILABLE');

create type etims_status as enum
  ('PENDING','SUBMITTING','SUBMITTED','FAILED','REJECTED','SKIPPED');

-- KRA tax type codes. Values are fixed by KRA; RATES are fetched at runtime
-- from /selectCodeList and stored in etims_code_list -- never hardcoded.
--   A = Exempt   B = Standard (16%)   C = Zero-rated   D = Non-VAT   E = 8%
create type tax_type_code as enum ('A','B','C','D','E');

-- ── Immutability guard ──────────────────────────────────────────────────────
-- Used on append-only tables. Privilege REVOKE is the primary control;
-- this trigger catches anything running as a superuser/service role.
create or replace function forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Table % is append-only; % is not permitted (row %)',
    tg_table_name, tg_op, coalesce(old::text, 'n/a')
    using errcode = 'restrict_violation';
end $$;

-- ── JWT claim helpers ───────────────────────────────────────────────────────
-- Claims are injected by the Custom Access Token Hook (see 0007_auth_hook.sql).
-- STABLE so the planner can inline them inside RLS policies.

create or replace function auth_business_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'business_id', '')::uuid
$$;

create or replace function auth_role()
returns text
language sql stable
as $$
  select coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'user_role', '')
$$;

create or replace function auth_device_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'device_id', '')::uuid
$$;

create or replace function auth_is_staff()
returns boolean
language sql stable
as $$
  select auth_role() in ('OWNER','SUPERVISOR')
$$;

comment on function auth_business_id is
  'Tenant id from JWT. Every RLS policy filters on this. Returns NULL for anon.';
