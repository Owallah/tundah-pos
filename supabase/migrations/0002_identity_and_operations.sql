-- ============================================================================
-- 0002_identity_and_operations.sql
-- Tenant, staff, devices, events, shifts.
-- ============================================================================

create table businesses (
  business_id     uuid primary key default uuid_generate_v7(),
  legal_name      text not null,
  trading_name    text,
  kra_pin         text not null check (kra_pin ~ '^[A-Z][0-9]{9}[A-Z]$'),
  etims_bhf_id    text not null default '00' check (etims_bhf_id ~ '^[0-9]{2}$'),
  vat_registered  boolean not null default false,
  -- Retail prices in Kenya are quoted VAT-inclusive. This drives the money module.
  prices_include_vat boolean not null default true,
  address         text,
  phone           text,
  email           text,
  created_at      timestamptz not null default now()
);

comment on column businesses.prices_include_vat is
  'TRUE: selling_price_cents is gross and VAT is extracted. FALSE: VAT is added. '
  'Kenyan retail is normally TRUE. Changing this after go-live changes every price.';

-- ── Staff with Supabase Auth accounts (owner, supervisor, and the 3 tills) ──
create table users (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  business_id uuid not null references businesses on delete cascade,
  role        user_role not null,
  full_name   text not null,
  email       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index users_business_idx on users (business_id) where is_active;

-- ── Tills ───────────────────────────────────────────────────────────────────
create table devices (
  device_id    uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references businesses on delete cascade,
  code         text not null,                       -- 'TILL-01'
  label        text,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  user_agent   text,
  last_seen_at timestamptz,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (business_id, code)
);

-- ── Cashiers (PIN identities; may have no auth account at all) ──────────────
create table cashiers (
  cashier_id      uuid primary key default uuid_generate_v7(),
  business_id     uuid not null references businesses on delete cascade,
  user_id         uuid references users on delete set null,
  full_name       text not null,
  pin_hash        text not null,          -- bcrypt. REVOKEd from authenticated.
  role            user_role not null default 'CASHIER',
  max_discount_bp int  not null default 0 check (max_discount_bp between 0 and 10000),
  can_void        boolean not null default false,
  can_override_price boolean not null default false,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

comment on column cashiers.max_discount_bp is 'Basis points. 500 = 5%. Enforced in complete_sale.';

-- PIN brute-force tracking
create table pin_attempts (
  attempt_id  bigserial primary key,
  cashier_id  uuid not null references cashiers on delete cascade,
  device_id   uuid references devices,
  succeeded   boolean not null,
  attempted_at timestamptz not null default now()
);
create index pin_attempts_recent_idx on pin_attempts (cashier_id, attempted_at desc);

-- ── Events ──────────────────────────────────────────────────────────────────
create table events (
  event_id    uuid primary key default uuid_generate_v7(),
  business_id uuid not null references businesses on delete cascade,
  name        text not null,
  venue       text,
  county      text,
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'PLANNED'
              check (status in ('PLANNED','ACTIVE','CLOSED')),
  notes       text,
  created_at  timestamptz not null default now(),
  closed_at   timestamptz,
  check (end_date >= start_date)
);

-- Only one ACTIVE event at a time -- tills bind to it implicitly.
create unique index events_single_active
  on events (business_id) where status = 'ACTIVE';

create table event_costs (
  cost_id      uuid primary key default uuid_generate_v7(),
  event_id     uuid not null references events on delete cascade,
  business_id  uuid not null references businesses on delete cascade,
  category     text not null check (category in
               ('STALL','TRANSPORT','STAFF','ACCOMMODATION','LICENCE','OTHER')),
  description  text,
  amount_cents bigint not null check (amount_cents >= 0),
  incurred_on  date not null,
  recorded_by  uuid references users,
  created_at   timestamptz not null default now()
);

-- ── Shifts ──────────────────────────────────────────────────────────────────
create table shifts (
  shift_id    uuid primary key default uuid_generate_v7(),
  business_id uuid not null references businesses on delete cascade,
  event_id    uuid not null references events,
  device_id   uuid not null references devices,
  cashier_id  uuid not null references cashiers,

  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,

  opening_float_cents bigint not null default 0 check (opening_float_cents >= 0),
  counted_cash_cents  bigint check (counted_cash_cents >= 0),
  expected_cash_cents bigint,
  variance_cents      bigint generated always as
                      (counted_cash_cents - expected_cash_cents) stored,

  catalogue_snapshot_at timestamptz,   -- when this till last loaded prices
  closed_with_unresolved_doubt boolean not null default false,  -- §C.5
  close_notes text,

  status text not null default 'OPEN' check (status in ('OPEN','CLOSED'))
);

-- A device can only have one open shift.
create unique index shifts_one_open_per_device
  on shifts (device_id) where status = 'OPEN';

create index shifts_event_idx on shifts (event_id, opened_at desc);

-- ── Audit ───────────────────────────────────────────────────────────────────
create table audit_logs (
  audit_id     uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references businesses on delete cascade,
  actor_cashier_id uuid references cashiers,
  actor_user_id    uuid references users,
  device_id    uuid references devices,
  shift_id     uuid references shifts,
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  before_state jsonb,
  after_state  jsonb,
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index audit_logs_lookup on audit_logs (business_id, occurred_at desc);
create index audit_logs_entity on audit_logs (entity_type, entity_id);

create trigger audit_logs_immutable
  before update or delete on audit_logs
  for each row execute function forbid_mutation();
