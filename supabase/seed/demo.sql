-- ============================================================================
-- demo.sql — a complete, working business you can sell from in minutes.
--
-- Everything except the Supabase Auth users, which must be created in the
-- dashboard (Authentication → Users → Add user) and then linked with
-- link_till() at the bottom of this file.
--
-- Run AFTER the migrations:
--   supabase db push
--   psql "$DATABASE_URL" -f supabase/seed/demo.sql
--
-- ⚠️ The tax classifications below are PLACEHOLDERS chosen so the demo runs.
-- They are NOT the accountant's answer to Q7. Whole fruit is marked C
-- (zero-rated) and prepared drinks B (16%), which is the likely shape, but
-- cut fruit and fresh juice are genuinely contested and must be confirmed
-- before you invoice anyone for real.
-- ============================================================================

begin;

-- ── Business ────────────────────────────────────────────────────────────────
insert into businesses (
  business_id, legal_name, trading_name, kra_pin, etims_bhf_id,
  vat_registered, prices_include_vat, address, phone, email)
values (
  '00000000-0000-4000-8000-000000000001',
  'Nyota Fresh Limited', 'Nyota Juice Bar',
  'P051234567M', '00',
  true,          -- Q1: set to your real VAT status
  true,          -- Kenyan retail convention: shelf prices include VAT
  'Ngong Road, Nairobi', '0712345678', 'owner@example.co.ke')
on conflict (business_id) do nothing;

-- ── Devices (auth_user_id linked separately, see link_till below) ───────────
insert into devices (device_id, business_id, code, label) values
  ('00000000-0000-4000-8000-0000000000a1',
   '00000000-0000-4000-8000-000000000001', 'TILL-01', 'Left counter'),
  ('00000000-0000-4000-8000-0000000000a2',
   '00000000-0000-4000-8000-000000000001', 'TILL-02', 'Middle counter'),
  ('00000000-0000-4000-8000-0000000000a3',
   '00000000-0000-4000-8000-000000000001', 'TILL-03', 'Right counter')
on conflict (business_id, code) do nothing;

-- ── Staff ───────────────────────────────────────────────────────────────────
-- PINs are 6 digits, hashed with bcrypt. Change these before any real event.
--   Supervisor 999111 · cashiers 100100 / 200200 / 300300
--
-- max_discount_bp is 1000 (10%) for cashiers, not the 500 in the CSV. One
-- supervisor covers three tills; a 5% ceiling makes them the bottleneck at
-- peak trade for routine goodwill like a squashed cup.
insert into cashiers (
  cashier_id, business_id, full_name, pin_hash, role,
  max_discount_bp, can_void, can_override_price)
values
  ('00000000-0000-4000-8000-0000000000b0',
   '00000000-0000-4000-8000-000000000001', 'Mwangi (Supervisor)',
   extensions.crypt('999111', extensions.gen_salt('bf', 10)), 'SUPERVISOR', 5000, true, true),
  ('00000000-0000-4000-8000-0000000000b1',
   '00000000-0000-4000-8000-000000000001', 'Achieng',
   extensions.crypt('100100', extensions.gen_salt('bf', 10)), 'CASHIER', 1000, false, false),
  ('00000000-0000-4000-8000-0000000000b2',
   '00000000-0000-4000-8000-000000000001', 'Brian',
   extensions.crypt('200200', extensions.gen_salt('bf', 10)), 'CASHIER', 1000, false, false),
  ('00000000-0000-4000-8000-0000000000b3',
   '00000000-0000-4000-8000-000000000001', 'Fatuma',
   extensions.crypt('300300', extensions.gen_salt('bf', 10)), 'CASHIER', 1000, false, false)
on conflict (cashier_id) do nothing;

-- ── Event (ACTIVE — tills cannot open a shift without one) ─────────────────
insert into events (
  event_id, business_id, name, venue, county,
  start_date, end_date, status)
values (
  '00000000-0000-4000-8000-0000000000c1',
  '00000000-0000-4000-8000-000000000001',
  'Demo Event', 'Test Grounds', 'Nairobi',
  current_date, current_date + 2, 'ACTIVE')
on conflict (event_id) do nothing;

-- ── Locations. The EVENT location is required before any sale. ─────────────
insert into stock_locations (location_id, business_id, code, name, kind, event_id)
values
  ('00000000-0000-4000-8000-0000000000d0',
   '00000000-0000-4000-8000-000000000001', 'BASE', 'Base store', 'BASE', null),
  ('00000000-0000-4000-8000-0000000000d1',
   '00000000-0000-4000-8000-000000000001', 'STALL', 'Event stall', 'EVENT',
   '00000000-0000-4000-8000-0000000000c1')
on conflict (business_id, code) do nothing;

-- ── Categories ──────────────────────────────────────────────────────────────
insert into categories (business_id, name, sort_order) values
  ('00000000-0000-4000-8000-000000000001', 'Smoothies', 1),
  ('00000000-0000-4000-8000-000000000001', 'Juices', 2),
  ('00000000-0000-4000-8000-000000000001', 'Fresh Fruit', 3),
  ('00000000-0000-4000-8000-000000000001', 'Cut Fruit', 4),
  ('00000000-0000-4000-8000-000000000001', 'Other', 5)
on conflict (business_id, name) do nothing;

-- ── Products ────────────────────────────────────────────────────────────────
-- Money is integer cents throughout. KES 250.00 is 25000.
insert into products (
  business_id, sku, name, short_name, category_id, uom,
  cost_price_cents, selling_price_cents,
  etims_tax_ty_cd, etims_item_cls_cd, etims_item_cd,
  etims_pkg_unit_cd, etims_qty_unit_cd, tile_order)
select
  '00000000-0000-4000-8000-000000000001',
  p.sku, p.name, p.short_name,
  (select category_id from categories
    where business_id = '00000000-0000-4000-8000-000000000001'
      and name = p.category),
  p.uom, p.cost, p.price, p.tax::tax_type_code,
  p.cls, p.item_cd, 'NT', p.qty_unit, p.tile
from (values
  ('SMO-MAN-L','Mango Smoothie (Large)','Mango L','Smoothies','EA', 8000, 25000,'B','50202301','KE2NTU0000001','U',10),
  ('SMO-MAN-S','Mango Smoothie (Small)','Mango S','Smoothies','EA', 5500, 18000,'B','50202301','KE2NTU0000002','U',11),
  ('SMO-TRO-L','Tropical Smoothie','Tropical','Smoothies','EA', 9000, 28000,'B','50202301','KE2NTU0000003','U',12),
  ('SMO-AVO-L','Avocado Smoothie','Avocado','Smoothies','EA', 9500, 30000,'B','50202301','KE2NTU0000004','U',13),
  ('JUI-ORA-500','Orange Juice 500ml','Orange','Juices','EA', 6000, 20000,'B','50202301','KE2NTU0000005','U',20),
  ('JUI-PAS-500','Passion Juice 500ml','Passion','Juices','EA', 6500, 20000,'B','50202301','KE2NTU0000006','U',21),
  ('JUI-SUG-500','Sugarcane Juice 500ml','Cane','Juices','EA', 4000, 15000,'B','50202301','KE2NTU0000007','U',22),
  ('FRU-MAN-EA','Whole Mango','Mango','Fresh Fruit','EA', 2500,  5000,'C','50131500','KE2NTU0000008','U',30),
  ('FRU-PIN-EA','Whole Pineapple','Pineapple','Fresh Fruit','EA', 8000, 15000,'C','50131500','KE2NTU0000009','U',31),
  ('FRU-WAT-KG','Watermelon per kg','Watermelon','Fresh Fruit','KG',3500,  8000,'C','50131500','KE2NTU0000010','KG',32),
  ('FRU-CUP-M','Cut Fruit Cup','Fruit Cup','Cut Fruit','EA', 4500, 12000,'C','50131500','KE2NTU0000011','U',40),
  ('FRU-SAL-L','Fruit Salad Large','Fruit Salad','Cut Fruit','EA', 7000, 20000,'C','50131500','KE2NTU0000012','U',41),
  ('WAT-500','Bottled Water 500ml','Water','Other','EA', 2500,  5000,'B','50202201','KE2NTU0000013','U',50)
) as p(sku, name, short_name, category, uom, cost, price, tax, cls, item_cd, qty_unit, tile)
on conflict (business_id, sku) do nothing;

-- ── Event pricing: a couple of overrides so the feature is visible ─────────
insert into event_prices (business_id, event_id, product_id, price_cents, note)
select '00000000-0000-4000-8000-000000000001',
       '00000000-0000-4000-8000-0000000000c1',
       product_id,
       case sku when 'SMO-MAN-L' then 28000 else 22000 end,
       'demo event pricing'
  from products
 where business_id = '00000000-0000-4000-8000-000000000001'
   and sku in ('SMO-MAN-L','JUI-ORA-500')
on conflict (event_id, product_id) do nothing;

-- ── Stock: load out to the stall ───────────────────────────────────────────
-- Written as LOAD_OUT ledger movements, not as a quantity column. The
-- balance cache is derived by trigger, exactly as it will be in production.
insert into stock_movements (
  movement_id, business_id, product_id, location_id, event_id,
  movement_type, qty_delta, unit_cost_cents, occurred_at, idempotency_key)
select
  uuid_generate_v7(),
  '00000000-0000-4000-8000-000000000001',
  product_id,
  '00000000-0000-4000-8000-0000000000d1',
  '00000000-0000-4000-8000-0000000000c1',
  'LOAD_OUT',
  case when uom = 'KG' then 60 else 80 end,
  cost_price_cents,
  now(),
  'demo:loadout:' || sku
from products
where business_id = '00000000-0000-4000-8000-000000000001'
on conflict (idempotency_key) do nothing;

-- ── Event costs, so the P&L has something in it ────────────────────────────
insert into event_costs (event_id, business_id, category, description,
                         amount_cents, incurred_on)
values
  ('00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000001', 'STALL', 'Stall fee',
   1500000, current_date),
  ('00000000-0000-4000-8000-0000000000c1',
   '00000000-0000-4000-8000-000000000001', 'TRANSPORT', 'Van hire',
   800000, current_date)
on conflict do nothing;

commit;

-- ============================================================================
-- Linking Auth users
-- ============================================================================
-- Create these in the dashboard first (Authentication → Users → Add user,
-- "Auto Confirm User" ticked):
--
--   till01@nyota.local   till02@nyota.local   till03@nyota.local
--   owner@nyota.local
--
-- Then run the calls at the bottom of this file.

create or replace function link_till(p_email text, p_device_code text)
returns text
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_business uuid := '00000000-0000-4000-8000-000000000001';
begin
  select id into v_user_id from auth.users where email = p_email;
  if v_user_id is null then
    return format('No auth user %s. Create it in the dashboard first.', p_email);
  end if;

  insert into users (user_id, business_id, role, full_name, email)
  values (v_user_id, v_business, 'DEVICE', p_device_code, p_email)
  on conflict (user_id) do update
    set business_id = excluded.business_id, role = excluded.role;

  update devices set auth_user_id = v_user_id
   where business_id = v_business and code = p_device_code;

  return format('Linked %s to %s', p_email, p_device_code);
end $$;

create or replace function link_staff(p_email text, p_name text, p_role text)
returns text
language plpgsql security definer set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_business uuid := '00000000-0000-4000-8000-000000000001';
begin
  select id into v_user_id from auth.users where email = p_email;
  if v_user_id is null then
    return format('No auth user %s. Create it in the dashboard first.', p_email);
  end if;

  insert into users (user_id, business_id, role, full_name, email)
  values (v_user_id, v_business, p_role::user_role, p_name, p_email)
  on conflict (user_id) do update
    set role = excluded.role, full_name = excluded.full_name;

  return format('Linked %s as %s', p_email, p_role);
end $$;

-- Run these once the auth users exist:
--
--   select link_till('till01@nyota.local', 'TILL-01');
--   select link_till('till02@nyota.local', 'TILL-02');
--   select link_till('till03@nyota.local', 'TILL-03');
--   select link_staff('owner@nyota.local', 'Owner', 'OWNER');
--
-- Then, in the dashboard:
--   Authentication → Hooks → Customize Access Token (JWT) Claims
--     → custom_access_token_hook
--
-- Nothing works until that hook is enabled. Every RLS policy reads
-- business_id from the JWT, so before it is on, every query returns zero rows
-- and the app looks broken rather than unconfigured.
