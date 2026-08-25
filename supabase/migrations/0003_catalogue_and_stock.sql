-- ============================================================================
-- 0003_catalogue_and_stock.sql
-- Products, barcodes, locations, the append-only ledger, derived balances.
-- ============================================================================

create table categories (
  category_id uuid primary key default uuid_generate_v7(),
  business_id uuid not null references businesses on delete cascade,
  name        text not null,
  sort_order  int  not null default 0,
  colour      text,                       -- touch-grid tile tint
  is_active   boolean not null default true,
  unique (business_id, name)
);

create table products (
  product_id  uuid primary key default uuid_generate_v7(),
  business_id uuid not null references businesses on delete cascade,
  sku         text not null,
  name        text not null,
  short_name  text,                       -- for the touch tile (<= ~18 chars)
  category_id uuid references categories on delete set null,
  uom         text not null default 'EA',

  cost_price_cents    bigint not null default 0 check (cost_price_cents >= 0),
  selling_price_cents bigint not null      check (selling_price_cents >= 0),

  -- ── KRA classification (INV-02) ──────────────────────────────────────────
  -- Populated from the accountant's classification (Q7) + /selectItemClsList.
  -- NOTE: fresh fruit and blended smoothies differ. Unprocessed produce is
  -- typically A/C; prepared drinks are B (16%). Classification is the
  -- accountant's call, not a default -- hence nullable until seeded.
  etims_item_cls_cd text,                  -- UNSPSC, 10 char
  etims_item_cd     text,                  -- KE<type><pkg><qty><7-digit seq>
  etims_tax_ty_cd   tax_type_code,
  etims_pkg_unit_cd text,
  etims_qty_unit_cd text,
  etims_registered_at timestamptz,         -- set after successful /saveItem

  stock_policy  stock_policy not null default 'ALLOW',
  track_stock   boolean not null default true,
  reorder_point numeric(13,3),
  reorder_qty   numeric(13,3),
  lead_time_days int,

  image_path  text,                        -- Supabase Storage key
  tile_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (business_id, sku)
);

-- INV-02: a product cannot be SOLD without tax classification.
-- Enforced at sale time in complete_sale() rather than as a CHECK, so that
-- products can be created before the accountant has classified them.
create index products_sellable_idx
  on products (business_id, is_active)
  where is_active and etims_tax_ty_cd is not null;

create index products_tile_idx on products (business_id, category_id, tile_order)
  where is_active;

create table product_barcodes (            -- INV-03 (optional for fresh produce)
  barcode     text primary key,
  product_id  uuid not null references products on delete cascade,
  business_id uuid not null references businesses on delete cascade
);
create index product_barcodes_product_idx on product_barcodes (product_id);

-- ── Suppliers & purchasing ──────────────────────────────────────────────────
create table suppliers (
  supplier_id uuid primary key default uuid_generate_v7(),
  business_id uuid not null references businesses on delete cascade,
  name        text not null,
  kra_pin     text,
  phone       text,
  email       text,
  is_active   boolean not null default true,
  unique (business_id, name)
);

-- ── Locations ───────────────────────────────────────────────────────────────
create table stock_locations (
  location_id uuid primary key default uuid_generate_v7(),
  business_id uuid not null references businesses on delete cascade,
  code        text not null,
  name        text not null,
  kind        text not null check (kind in ('BASE','VAN','EVENT')),
  event_id    uuid references events on delete cascade,
  is_active   boolean not null default true,
  unique (business_id, code)
);

-- ── THE LEDGER (INV-04) ─────────────────────────────────────────────────────
-- Stock is a ledger, not an editable number. ARCHITECTURE Principle 9.
create table stock_movements (
  movement_id   uuid primary key,            -- client-generated UUIDv7
  business_id   uuid not null references businesses on delete cascade,
  product_id    uuid not null references products,
  location_id   uuid not null references stock_locations,
  event_id      uuid references events,
  movement_type movement_type not null,

  qty_delta     numeric(13,3) not null check (qty_delta <> 0),   -- signed
  unit_cost_cents bigint,                     -- for COGS / valuation

  sale_id       uuid,                         -- FK added in 0004 (circular)
  stock_take_id uuid,
  source_ref    text,

  device_id     uuid references devices,
  cashier_id    uuid references cashiers,
  user_id       uuid references users,
  reason        text,

  occurred_at            timestamptz not null,  -- client clock (v2 forward-compat)
  created_at_server      timestamptz not null default now(),  -- authoritative in v1
  idempotency_key text not null unique,

  etims_sar_no  bigint,                       -- cloud-allocated on submission
  etims_status  etims_status not null default 'PENDING'
);

create index stock_movements_product_idx
  on stock_movements (product_id, location_id, created_at_server desc);
create index stock_movements_event_idx on stock_movements (event_id, movement_type);
create index stock_movements_sale_idx  on stock_movements (sale_id);

-- Append-only, enforced two ways.
create trigger stock_movements_immutable
  before update or delete on stock_movements
  for each row execute function forbid_mutation();

-- ── Derived balance cache (rebuildable from the ledger at any time) ─────────
create table stock_balances (
  business_id uuid not null references businesses on delete cascade,
  product_id  uuid not null references products on delete cascade,
  location_id uuid not null references stock_locations on delete cascade,
  qty_on_hand numeric(13,3) not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (product_id, location_id)
);

create index stock_balances_business_idx on stock_balances (business_id, location_id);

-- ── Stock variances (§D.2: negative stock is flagged, never blocked) ────────
create table stock_variances (
  variance_id  uuid primary key default uuid_generate_v7(),
  business_id  uuid not null references businesses on delete cascade,
  product_id   uuid not null references products,
  location_id  uuid not null references stock_locations,
  movement_id  uuid references stock_movements,
  sale_id      uuid,
  qty_before   numeric(13,3),
  qty_after    numeric(13,3),
  status       text not null default 'OPEN'
               check (status in ('OPEN','RESOLVED','IGNORED')),
  resolution_movement_id uuid references stock_movements,
  resolution_note text,
  resolved_by  uuid references users,
  detected_at  timestamptz not null default now(),
  resolved_at  timestamptz
);

create index stock_variances_open_idx
  on stock_variances (business_id, detected_at desc) where status = 'OPEN';

-- ── Balance maintenance ─────────────────────────────────────────────────────
create or replace function apply_movement_to_balance()
returns trigger
language plpgsql
as $$
declare
  v_before numeric(13,3);
  v_after  numeric(13,3);
begin
  select qty_on_hand into v_before
    from stock_balances
   where product_id = new.product_id and location_id = new.location_id;

  insert into stock_balances (business_id, product_id, location_id, qty_on_hand)
  values (new.business_id, new.product_id, new.location_id, new.qty_delta)
  on conflict (product_id, location_id) do update
    set qty_on_hand = stock_balances.qty_on_hand + excluded.qty_on_hand,
        updated_at  = now()
  returning qty_on_hand into v_after;

  -- Flag, never block. The physical shelf is the real constraint.
  if v_after < 0 and coalesce(v_before, 0) >= 0 then
    insert into stock_variances
      (business_id, product_id, location_id, movement_id, sale_id, qty_before, qty_after)
    values
      (new.business_id, new.product_id, new.location_id, new.movement_id,
       new.sale_id, coalesce(v_before, 0), v_after);
  end if;

  return new;
end $$;

create trigger stock_movements_balance
  after insert on stock_movements
  for each row execute function apply_movement_to_balance();

-- ── Rebuild balances from the ledger (disaster recovery / verification) ─────
create or replace function rebuild_stock_balances(p_business_id uuid)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare v_rows bigint;
begin
  delete from stock_balances where business_id = p_business_id;

  insert into stock_balances (business_id, product_id, location_id, qty_on_hand, updated_at)
  select business_id, product_id, location_id, sum(qty_delta), now()
    from stock_movements
   where business_id = p_business_id
   group by business_id, product_id, location_id;

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

comment on function rebuild_stock_balances is
  'stock_balances is a cache. If it ever drifts, this recomputes it from the '
  'append-only ledger. Safe to run at any time; results must be identical.';

-- ── Stock takes (INV-06) ────────────────────────────────────────────────────
create table stock_takes (
  stock_take_id uuid primary key default uuid_generate_v7(),
  business_id   uuid not null references businesses on delete cascade,
  location_id   uuid not null references stock_locations,
  event_id      uuid references events,
  status        text not null default 'OPEN' check (status in ('OPEN','APPLIED','CANCELLED')),
  started_by    uuid references users,
  started_at    timestamptz not null default now(),
  applied_at    timestamptz,
  notes         text
);

create table stock_take_items (
  stock_take_item_id uuid primary key default uuid_generate_v7(),
  stock_take_id uuid not null references stock_takes on delete cascade,
  product_id    uuid not null references products,
  expected_qty  numeric(13,3) not null,
  counted_qty   numeric(13,3) not null,
  variance_qty  numeric(13,3) generated always as (counted_qty - expected_qty) stored,
  note          text,
  unique (stock_take_id, product_id)
);
