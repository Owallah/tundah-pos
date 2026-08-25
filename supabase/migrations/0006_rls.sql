-- ============================================================================
-- 0006_rls.sql
-- Row Level Security. Never rely on frontend authorisation. §20.
--
-- Model:
--   DEVICE role  -> may sell; sees its own device's operational data
--   SUPERVISOR   -> sees everything for the business; may resolve/void
--   OWNER        -> everything, plus catalogue and configuration
-- ============================================================================

alter table businesses      enable row level security;
alter table users           enable row level security;
alter table devices         enable row level security;
alter table cashiers        enable row level security;
alter table pin_attempts    enable row level security;
alter table events          enable row level security;
alter table event_costs     enable row level security;
alter table shifts          enable row level security;
alter table audit_logs      enable row level security;
alter table categories      enable row level security;
alter table products        enable row level security;
alter table product_barcodes enable row level security;
alter table suppliers       enable row level security;
alter table stock_locations enable row level security;
alter table stock_movements enable row level security;
alter table stock_balances  enable row level security;
alter table stock_variances enable row level security;
alter table stock_takes     enable row level security;
alter table stock_take_items enable row level security;
alter table sales           enable row level security;
alter table sale_items      enable row level security;
alter table payments        enable row level security;
alter table mpesa_transactions enable row level security;
alter table invoices        enable row level security;
alter table credit_notes    enable row level security;
alter table etims_submissions enable row level security;
alter table etims_code_list enable row level security;
alter table etims_item_classifications enable row level security;
alter table etims_device_state enable row level security;
alter table sales_in_doubt  enable row level security;
alter table parked_sales    enable row level security;

-- ── Hard privilege revokes (RLS is not the only control) ───────────────────

-- Ledger and fiscal records are append-only for EVERYONE except the service role.
revoke update, delete on stock_movements from authenticated, anon;
revoke update, delete on invoices        from authenticated, anon;
revoke update, delete on audit_logs      from authenticated, anon;
revoke insert, update, delete on credit_notes from authenticated, anon;

-- pin_hash must never reach a client. No SELECT on the base table at all.
revoke all on cashiers from authenticated, anon;
grant select (cashier_id, business_id, full_name, role, max_discount_bp,
              can_void, can_override_price, is_active)
  on cashiers to authenticated;

-- Sequences are allocated server-side only.
revoke all on sequence etims_invc_no_seq from authenticated, anon;
revoke all on sequence etims_sar_no_seq  from authenticated, anon;

-- KRA credentials never leave the server.
revoke all on etims_device_state from authenticated, anon;

-- ── businesses ─────────────────────────────────────────────────────────────
create policy businesses_select on businesses for select to authenticated
  using (business_id = auth_business_id());

create policy businesses_update on businesses for update to authenticated
  using (business_id = auth_business_id() and auth_role() = 'OWNER')
  with check (business_id = auth_business_id());

-- ── users / devices ────────────────────────────────────────────────────────
create policy users_select on users for select to authenticated
  using (business_id = auth_business_id());

create policy users_write on users for all to authenticated
  using (business_id = auth_business_id() and auth_role() = 'OWNER')
  with check (business_id = auth_business_id() and auth_role() = 'OWNER');

create policy devices_select on devices for select to authenticated
  using (business_id = auth_business_id());

create policy devices_write on devices for all to authenticated
  using (business_id = auth_business_id() and auth_role() = 'OWNER')
  with check (business_id = auth_business_id() and auth_role() = 'OWNER');

-- Tills may stamp their own heartbeat.
create policy devices_heartbeat on devices for update to authenticated
  using (business_id = auth_business_id() and device_id = auth_device_id())
  with check (business_id = auth_business_id() and device_id = auth_device_id());

-- ── cashiers (column-limited above) ────────────────────────────────────────
create policy cashiers_select on cashiers for select to authenticated
  using (business_id = auth_business_id() and is_active);

create policy cashiers_write on cashiers for all to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id() and auth_is_staff());

-- ── catalogue: read by all, written by owner only, ONLINE only ─────────────
create policy categories_select on categories for select to authenticated
  using (business_id = auth_business_id());
create policy categories_write on categories for all to authenticated
  using (business_id = auth_business_id() and auth_role() = 'OWNER')
  with check (business_id = auth_business_id() and auth_role() = 'OWNER');

create policy products_select on products for select to authenticated
  using (business_id = auth_business_id());
create policy products_write on products for all to authenticated
  using (business_id = auth_business_id() and auth_role() = 'OWNER')
  with check (business_id = auth_business_id() and auth_role() = 'OWNER');

create policy barcodes_select on product_barcodes for select to authenticated
  using (business_id = auth_business_id());
create policy barcodes_write on product_barcodes for all to authenticated
  using (business_id = auth_business_id() and auth_role() = 'OWNER')
  with check (business_id = auth_business_id() and auth_role() = 'OWNER');

create policy suppliers_all on suppliers for all to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id() and auth_is_staff());

-- ── events ─────────────────────────────────────────────────────────────────
create policy events_select on events for select to authenticated
  using (business_id = auth_business_id());
create policy events_write on events for all to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id() and auth_is_staff());

create policy event_costs_all on event_costs for all to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id() and auth_is_staff());

-- ── stock ──────────────────────────────────────────────────────────────────
create policy locations_select on stock_locations for select to authenticated
  using (business_id = auth_business_id());
create policy locations_write on stock_locations for all to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id() and auth_is_staff());

create policy movements_select on stock_movements for select to authenticated
  using (business_id = auth_business_id());

-- Tills insert movements ONLY via complete_sale (SECURITY DEFINER).
-- Direct inserts are limited to staff doing load-out/load-back/wastage.
create policy movements_insert on stock_movements for insert to authenticated
  with check (
    business_id = auth_business_id()
    and (
      auth_is_staff()
      or (device_id = auth_device_id()
          and movement_type in ('SALE','WASTAGE','SAMPLE','RETURN'))
    )
  );

create policy balances_select on stock_balances for select to authenticated
  using (business_id = auth_business_id());

create policy variances_select on stock_variances for select to authenticated
  using (business_id = auth_business_id());
create policy variances_resolve on stock_variances for update to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id());

create policy stock_takes_all on stock_takes for all to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id() and auth_is_staff());

create policy stock_take_items_all on stock_take_items for all to authenticated
  using (exists (select 1 from stock_takes t
                  where t.stock_take_id = stock_take_items.stock_take_id
                    and t.business_id = auth_business_id())
         and auth_is_staff())
  with check (auth_is_staff());

-- ── shifts ─────────────────────────────────────────────────────────────────
create policy shifts_select on shifts for select to authenticated
  using (business_id = auth_business_id()
         and (auth_is_staff() or device_id = auth_device_id()));

create policy shifts_open on shifts for insert to authenticated
  with check (business_id = auth_business_id()
              and device_id = auth_device_id()
              and status = 'OPEN');

create policy shifts_update on shifts for update to authenticated
  using (business_id = auth_business_id()
         and (auth_is_staff() or device_id = auth_device_id()))
  with check (business_id = auth_business_id());

-- ── sales ──────────────────────────────────────────────────────────────────
create policy sales_select on sales for select to authenticated
  using (business_id = auth_business_id()
         and (auth_is_staff() or device_id = auth_device_id()));

create policy sales_insert on sales for insert to authenticated
  with check (business_id = auth_business_id()
              and device_id = auth_device_id()
              and status in ('DRAFT','PARKED'));

-- A COMPLETED sale is frozen. Corrections go through credit notes (SAL-06).
create policy sales_update on sales for update to authenticated
  using (business_id = auth_business_id()
         and status in ('DRAFT','PARKED')
         and (auth_is_staff() or device_id = auth_device_id()))
  with check (business_id = auth_business_id());

create policy sale_items_select on sale_items for select to authenticated
  using (business_id = auth_business_id());

create policy sale_items_insert on sale_items for insert to authenticated
  with check (business_id = auth_business_id()
              and exists (select 1 from sales s
                           where s.sale_id = sale_items.sale_id
                             and s.status in ('DRAFT','PARKED')));

-- ── payments & M-Pesa ──────────────────────────────────────────────────────
create policy payments_select on payments for select to authenticated
  using (business_id = auth_business_id());

create policy payments_insert on payments for insert to authenticated
  with check (business_id = auth_business_id());

create policy payments_update on payments for update to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id());

-- Tills need to SEE unmatched C2B payments to claim them, but must not
-- fabricate them -- only the Daraja webhook (service role) inserts.
create policy mpesa_select on mpesa_transactions for select to authenticated
  using (business_id = auth_business_id());

create policy mpesa_match on mpesa_transactions for update to authenticated
  using (business_id = auth_business_id() and payment_id is null)
  with check (business_id = auth_business_id());

-- ── fiscal (read-only to everyone; written by the service role worker) ─────
create policy invoices_select on invoices for select to authenticated
  using (business_id = auth_business_id());

create policy credit_notes_select on credit_notes for select to authenticated
  using (business_id = auth_business_id());

create policy etims_submissions_select on etims_submissions for select to authenticated
  using (business_id = auth_business_id() and auth_is_staff());

create policy etims_codes_select on etims_code_list for select to authenticated
  using (true);
create policy etims_item_cls_select on etims_item_classifications for select to authenticated
  using (true);

-- ── sale-in-doubt & parked ─────────────────────────────────────────────────
create policy doubt_select on sales_in_doubt for select to authenticated
  using (business_id = auth_business_id());
create policy doubt_insert on sales_in_doubt for insert to authenticated
  with check (business_id = auth_business_id() and device_id = auth_device_id());
create policy doubt_resolve on sales_in_doubt for update to authenticated
  using (business_id = auth_business_id() and auth_is_staff())
  with check (business_id = auth_business_id());

create policy parked_all on parked_sales for all to authenticated
  using (business_id = auth_business_id()
         and (auth_is_staff() or device_id = auth_device_id()))
  with check (business_id = auth_business_id() and device_id = auth_device_id());

-- ── audit ──────────────────────────────────────────────────────────────────
create policy audit_select on audit_logs for select to authenticated
  using (business_id = auth_business_id() and auth_is_staff());
create policy audit_insert on audit_logs for insert to authenticated
  with check (business_id = auth_business_id());

-- ── Safe roster view (no pin_hash, ever) ───────────────────────────────────
create view cashier_roster with (security_invoker = true) as
  select cashier_id, business_id, full_name, role,
         max_discount_bp, can_void, can_override_price
    from cashiers
   where is_active;

grant select on cashier_roster to authenticated;

-- ── Function grants ────────────────────────────────────────────────────────
grant execute on function complete_sale(jsonb)                  to authenticated;
grant execute on function resolve_sale(uuid, text)              to authenticated;
grant execute on function close_shift(uuid, bigint, text)       to authenticated;
grant execute on function verify_cashier_pin(uuid, text)        to authenticated;
grant execute on function set_cashier_pin(uuid, text)           to authenticated;
grant execute on function tax_rate_bp(text)                     to authenticated;

revoke execute on function rebuild_stock_balances(uuid) from authenticated, anon;
