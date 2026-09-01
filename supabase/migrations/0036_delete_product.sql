-- 0036_delete_product.sql
--
-- Adds delete_product() for the admin Products screen.
--
-- A hard DELETE is only safe for a product that has never actually been
-- sold or moved -- e.g. a duplicate or a test entry created by mistake. If
-- it has any sale_items or stock_movements history, deleting it would
-- either be silently blocked by the existing (intentionally un-cascaded)
-- foreign keys, or -- worse -- if those FKs are ever loosened later,
-- quietly corrupt a real financial record. Rather than let that fail as a
-- raw constraint-violation message, this checks first and returns a clear,
-- actionable error: deactivate instead (the existing is_active flag already
-- hides a product from the till without touching any history).
--
-- event_prices has `on delete cascade` for product_id (0008), so a genuine,
-- history-free delete correctly cleans up any leftover event-pricing rows
-- for it automatically.

create or replace function delete_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_id uuid := auth_business_id();
  v_product products%rowtype;
  v_sale_count bigint;
  v_movement_count bigint;
begin
  if not auth_is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_product from products
   where product_id = p_product_id and business_id = v_business_id;
  if not found then
    raise exception 'unknown_product' using errcode = '23503';
  end if;

  select count(*) into v_sale_count
    from sale_items where product_id = p_product_id;
  select count(*) into v_movement_count
    from stock_movements where product_id = p_product_id;

  if v_sale_count > 0 or v_movement_count > 0 then
    raise exception 'product_has_history: % sale line(s), % stock movement(s)',
      v_sale_count, v_movement_count
      using errcode = '23514',
      hint = 'This product has real sales or stock history and cannot be '
             'deleted without corrupting that record. Set it to inactive '
             'instead -- it will disappear from the till but the history '
             'stays intact.';
  end if;

  delete from products
   where product_id = p_product_id and business_id = v_business_id;

  insert into audit_logs (
    business_id, actor_user_id, action, entity_type, entity_id, before_state)
  values (
    v_business_id, auth.uid(), 'PRODUCT_DELETED', 'product', p_product_id,
    jsonb_build_object('sku', v_product.sku, 'name', v_product.name));

  return jsonb_build_object('deleted', true, 'product_id', p_product_id);
end
$$;

grant execute on function delete_product(uuid) to authenticated;

comment on function delete_product is
  'Hard-deletes a product with no sale or stock history. Refuses, with a '
  'clear hint to deactivate instead, if the product has ever actually been '
  'sold or moved -- deleting that would corrupt real financial records.';