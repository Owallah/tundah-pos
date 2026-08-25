-- ============================================================================
-- 0004_sales_and_fiscal.sql
-- Operational sales layer + immutable fiscal layer + integration queues.
-- ============================================================================

create table sales (
  sale_id     uuid primary key,                 -- client-generated UUIDv7
  business_id uuid not null references businesses on delete cascade,
  event_id    uuid not null references events,
  shift_id    uuid not null references shifts,
  device_id   uuid not null references devices,
  cashier_id  uuid not null references cashiers,

  status      sale_status not null default 'DRAFT',
  local_ref   text not null,                    -- 'TILL-01-000247'

  subtotal_cents       bigint not null default 0,
  discount_total_cents bigint not null default 0 check (discount_total_cents >= 0),
  tax_total_cents      bigint not null default 0,
  total_cents          bigint not null default 0 check (total_cents >= 0),

  customer_kra_pin text check (customer_kra_pin ~ '^[A-Z][0-9]{9}[A-Z]$'),
  customer_name    text,
  customer_phone   text,

  occurred_at       timestamptz not null,
  created_at_server timestamptz not null default now(),
  completed_at      timestamptz,
  idempotency_key   text not null unique,

  is_backfilled boolean not null default false,  -- entered from a paper slip §C.6
  backfill_ref  text,                            -- paper slip number
  void_reason   text,
  voided_by_cashier_id uuid references cashiers,

  unique (business_id, local_ref)
);

-- Totals must always reconcile. Cheap insurance against a bad client build.
alter table sales add constraint sales_totals_consistent
  check (total_cents = subtotal_cents - discount_total_cents + tax_total_cents);

create index sales_shift_idx on sales (shift_id, created_at_server desc);
create index sales_event_idx on sales (event_id, status, created_at_server desc);
create index sales_completed_idx on sales (business_id, completed_at desc)
  where status = 'COMPLETED';

-- resolve the circular FK from 0003
alter table stock_movements
  add constraint stock_movements_sale_fk
  foreign key (sale_id) references sales(sale_id);

alter table stock_variances
  add constraint stock_variances_sale_fk
  foreign key (sale_id) references sales(sale_id);

-- ── Line items ──────────────────────────────────────────────────────────────
-- Tax fields are SNAPSHOTS. A reclassification next month must not alter a
-- historic invoice.
create table sale_items (
  line_id     uuid primary key,
  sale_id     uuid not null references sales on delete cascade,
  business_id uuid not null references businesses on delete cascade,
  product_id  uuid not null references products,
  line_no     int  not null check (line_no > 0),

  qty              numeric(13,3) not null check (qty > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  discount_cents   bigint not null default 0 check (discount_cents >= 0),

  gross_cents          bigint not null,   -- qty * unit_price - discount
  taxable_amount_cents bigint not null,   -- see ARCHITECTURE §0.4 (K3)
  tax_amount_cents     bigint not null,
  line_total_cents     bigint not null,

  -- snapshots
  product_name text not null,
  tax_ty_cd    tax_type_code not null,
  tax_rate_bp  int not null check (tax_rate_bp >= 0),   -- 1600 = 16.00%
  item_cls_cd  text,
  item_cd      text,

  price_overridden boolean not null default false,
  override_reason  text,
  approved_by_cashier_id uuid references cashiers,
  sold_below_recorded_stock boolean not null default false,   -- §D.2

  unique (sale_id, line_no)
);

create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_product_idx on sale_items (product_id, business_id);

-- ── Payments (multi-tender; collapsed to one pmtTyCd at the eTIMS boundary) ─
create table payments (
  payment_id  uuid primary key,
  sale_id     uuid not null references sales on delete cascade,
  business_id uuid not null references businesses on delete cascade,
  method      payment_method not null,
  amount_cents bigint not null check (amount_cents > 0),
  status      payment_status not null default 'PENDING',

  tendered_cents bigint check (tendered_cents >= 0),   -- cash only
  change_cents   bigint check (change_cents >= 0),

  occurred_at timestamptz not null,
  created_at_server timestamptz not null default now(),
  idempotency_key text not null unique
);

create index payments_sale_idx on payments (sale_id);
create index payments_status_idx on payments (business_id, status, occurred_at desc);

-- ── M-Pesa ──────────────────────────────────────────────────────────────────
-- C2B is the PRIMARY path for this business: low ticket value, long queues,
-- STK Push round-trip (30-60s) is too slow. Customer pays the Till directly;
-- Safaricom posts to our Confirmation URL; the cashier taps to match.
create table mpesa_transactions (
  mpesa_txn_id uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references businesses on delete cascade,
  payment_id   uuid references payments on delete set null,

  channel   text not null check (channel in ('C2B','STK')),
  direction text not null default 'C2B',

  -- STK correlation
  checkout_request_id text,
  merchant_request_id text,

  -- Confirmed transaction detail
  mpesa_receipt_number text,
  phone_number         text,
  payer_name           text,
  bill_ref_number      text,
  amount_cents         bigint not null check (amount_cents > 0),

  status      payment_status not null default 'PENDING',
  result_code int,
  result_desc text,
  raw_callback jsonb,

  initiated_at  timestamptz,
  confirmed_at  timestamptz,
  matched_at    timestamptz,
  matched_by_cashier_id uuid references cashiers,
  reconciled_at timestamptz
);

-- PAY-07: one M-Pesa code can never settle two sales.
create unique index mpesa_receipt_unique
  on mpesa_transactions (business_id, mpesa_receipt_number)
  where mpesa_receipt_number is not null;

create unique index mpesa_checkout_unique
  on mpesa_transactions (checkout_request_id)
  where checkout_request_id is not null;

-- Unmatched C2B payments waiting for a cashier to claim them.
create index mpesa_unmatched_idx
  on mpesa_transactions (business_id, confirmed_at desc)
  where payment_id is null and status = 'VERIFIED';

-- ── FISCAL LAYER (immutable) ────────────────────────────────────────────────
-- invcNo is a sequential integer per branch, allocated ONLY here, ONLY after
-- a successful OSCU response. Never client-side. See ARCHITECTURE §0.2.
create sequence etims_invc_no_seq start 1;
create sequence etims_sar_no_seq  start 1;

create table invoices (
  invoice_id  uuid primary key default uuid_generate_v7(),
  sale_id     uuid not null unique references sales,
  business_id uuid not null references businesses on delete cascade,

  invc_no     bigint not null,
  trd_invc_no text   not null,

  -- Returned by KRA. These five ARE the fiscalisation.
  cur_rcpt_no   bigint not null,
  tot_rcpt_no   bigint not null,
  intrl_data    text   not null,
  rcpt_sign     text   not null,
  sdc_date_time timestamptz not null,

  rcpt_ty_cd  text not null default 'S' check (rcpt_ty_cd in ('S','R')),
  pmt_ty_cd   text not null,                 -- collapsed. See §0.5 / K4
  qr_payload  text,

  receipt_payload jsonb not null,            -- full immutable snapshot
  public_token text not null unique,         -- 32-byte base64url -> /r/{token}

  issued_at timestamptz not null default now(),
  unique (business_id, invc_no)
);

create index invoices_issued_idx on invoices (business_id, issued_at desc);

create trigger invoices_immutable
  before update or delete on invoices
  for each row execute function forbid_mutation();

-- SAL-06/SAL-09: corrections are credit notes, never edits.
create table credit_notes (
  credit_note_id uuid primary key default uuid_generate_v7(),
  business_id    uuid not null references businesses on delete cascade,
  original_invoice_id uuid not null references invoices,
  sale_id        uuid references sales,

  invc_no     bigint not null,
  org_invc_no bigint not null,
  rfd_rsn_cd  text not null check (rfd_rsn_cd in ('01','02','03','04','05','06')),
  reason_text text,

  total_cents bigint not null check (total_cents > 0),
  tax_total_cents bigint not null default 0,

  cur_rcpt_no bigint, intrl_data text, rcpt_sign text, sdc_date_time timestamptz,
  receipt_payload jsonb,
  public_token text unique,

  created_by_cashier_id uuid references cashiers,
  approved_by_cashier_id uuid references cashiers,
  issued_at timestamptz not null default now(),
  unique (business_id, invc_no)
);

-- ── eTIMS SUBMISSION QUEUE ──────────────────────────────────────────────────
-- STRICTLY ORDERED, SINGLE WORKER. KRA requires sale -> stockIO -> stockMaster
-- and returns 921/922 if that order is broken. Do not parallelise. §0.3
create table etims_submissions (
  submission_id uuid primary key default uuid_generate_v7(),
  business_id   uuid not null references businesses on delete cascade,
  seq           bigserial not null,

  kind text not null check (kind in
       ('SALE','CREDIT_NOTE','STOCK_IO','STOCK_MASTER','ITEM','PURCHASE')),

  sale_id        uuid references sales,
  credit_note_id uuid references credit_notes,
  movement_id    uuid references stock_movements,
  product_id     uuid references products,

  request_body  jsonb not null,
  response_body jsonb,
  result_cd     text,

  status   etims_status not null default 'PENDING',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,

  created_at   timestamptz not null default now(),
  submitted_at timestamptz
);

-- The drain index. Single-row FOR UPDATE SKIP LOCKED against this.
create index etims_queue_drain
  on etims_submissions (business_id, seq)
  where status in ('PENDING','FAILED');

create index etims_queue_status on etims_submissions (business_id, status, created_at desc);

-- KRA reference data, refreshed from /selectCodeList and /selectItemClsList.
-- RATES LIVE HERE, NOT IN CODE.
create table etims_code_list (
  code_class  text not null,
  code        text not null,
  code_name   text,
  user_dfn_cd1 text,                -- carries the rate for tax types
  sort_order  int,
  is_active   boolean not null default true,
  fetched_at  timestamptz not null default now(),
  primary key (code_class, code)
);

create table etims_item_classifications (
  item_cls_cd  text primary key,
  item_cls_nm  text,
  item_cls_lvl int,
  tax_ty_cd    text,
  is_active    boolean not null default true,
  fetched_at   timestamptz not null default now()
);

create table etims_device_state (
  business_id uuid primary key references businesses on delete cascade,
  dvc_srl_no  text not null,
  dvc_id      text,
  sdc_id      text,
  mrc_no      text,
  cmc_key_encrypted text,           -- never leaves the server
  last_code_sync_at  timestamptz,
  last_item_cls_sync_at timestamptz,
  initialised_at timestamptz,
  environment text not null default 'SANDBOX' check (environment in ('SANDBOX','PRODUCTION'))
);

-- ── Sale-in-doubt (§C.5) ────────────────────────────────────────────────────
create table sales_in_doubt (
  sale_id      uuid primary key,
  business_id  uuid not null references businesses on delete cascade,
  device_id    uuid not null references devices,
  shift_id     uuid not null references shifts,
  amount_cents bigint not null,
  payload      jsonb not null,
  status       text not null default 'OPEN' check (status in
               ('OPEN','RESOLVED_COMMITTED','RESOLVED_REPLAYED','RESOLVED_VOID')),
  raised_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid references users,
  resolution_note text
);

create index sales_in_doubt_open on sales_in_doubt (business_id, raised_at)
  where status = 'OPEN';

-- ── Parked sales (SAL-03) ───────────────────────────────────────────────────
create table parked_sales (
  parked_id   uuid primary key default uuid_generate_v7(),
  business_id uuid not null references businesses on delete cascade,
  device_id   uuid not null references devices,
  shift_id    uuid not null references shifts,
  cashier_id  uuid not null references cashiers,
  label       text,
  cart        jsonb not null,
  parked_at   timestamptz not null default now(),
  recalled_at timestamptz
);
