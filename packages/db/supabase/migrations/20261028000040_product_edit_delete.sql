-- 0040: Edit or delete one product from Products & stock (a wrong entry is fixed in place).
--   * set_product_stock: "the shelf really has N" — the difference is posted as a stock adjustment
--     (newest batch first when lowering; the newest batch when raising), with the reason, in the
--     stock movements, so the history stays true.
--   * remove_product: delete a product even if it has stock: the stock goes to 0 by adjustment first,
--     then the product is archived (old bills and reports still show its name).
--   * office_product_edit: what the edit form shows.

create or replace function public.set_product_stock(p_branch uuid, p_product uuid, p_qty_base bigint, p_reason text, p_session uuid default null)
returns bigint
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  cur bigint;
  diff bigint;
  r record;
  take bigint;
  bid uuid;
begin
  perform app.assert_branch(p_branch);
  perform app.require_decision(uid, 'product.manage', p_branch, null, null, 'other');
  if p_qty_base is null or p_qty_base < 0 then raise exception 'Stock cannot be below 0' using errcode = '22023'; end if;
  if not exists (select 1 from products where id = p_product and tenant_id = tid and archived_at is null) then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  select coalesce(sum(qty_base), 0) into cur from stock_balances where branch_id = p_branch and product_id = p_product;
  diff := p_qty_base - cur;
  if diff = 0 then return 0; end if;
  if diff < 0 then
    for r in select sb.batch_id, sb.qty_base from stock_balances sb join batches b on b.id = sb.batch_id
             where sb.branch_id = p_branch and sb.product_id = p_product and sb.qty_base > 0
             order by b.created_at desc loop
      exit when diff = 0;
      take := least(r.qty_base, -diff);
      insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type, reason,
                                   occurred_at, created_by, device_id)
      values (tid, p_branch, p_product, r.batch_id, 'adjust', -take, 'adjustment', coalesce(nullif(trim(p_reason), ''), 'Stock corrected'),
              now(), uid, app.ctx_device_id());
      diff := diff + take;
    end loop;
  else
    select b.id into bid from batches b where b.product_id = p_product and b.tenant_id = tid and b.archived_at is null order by b.created_at desc limit 1;
    if bid is null then bid := app.get_or_create_batch(tid, p_product, '-', null, uid); end if;
    insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type, reason,
                                 occurred_at, created_by, device_id)
    values (tid, p_branch, p_product, bid, 'adjust', diff, 'adjustment', coalesce(nullif(trim(p_reason), ''), 'Stock corrected'),
            now(), uid, app.ctx_device_id());
  end if;
  perform app.log_event('product.stock_set', 'products', p_product, jsonb_build_object('from', cur, 'to', p_qty_base, 'reason', p_reason), p_branch);
  return p_qty_base - cur;
end $$;

create or replace function public.remove_product(p_product uuid, p_reason text, p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  r record;
begin
  perform app.require_decision(uid, 'product.manage', (select id from branches where tenant_id = tid order by created_at limit 1), null, null, 'other');
  if not exists (select 1 from products where id = p_product and tenant_id = tid and archived_at is null) then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  for r in select branch_id, batch_id, qty_base from stock_balances where product_id = p_product and qty_base <> 0 loop
    insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type, reason,
                                 occurred_at, created_by, device_id)
    values (tid, r.branch_id, p_product, r.batch_id, 'adjust', -r.qty_base, 'adjustment',
            'Product deleted: ' || coalesce(nullif(trim(p_reason), ''), 'entered by mistake'), now(), uid, app.ctx_device_id());
  end loop;
  update products set archived_at = now(), is_active = false where id = p_product and tenant_id = tid;
  update barcodes set archived_at = now() where product_id = p_product and archived_at is null;
  perform app.log_event('product.archived', 'products', p_product, jsonb_build_object('reason', p_reason));
end $$;

-- The edit form: the product, its pack sizes with today's selling price, and the stock here.
create or replace function public.office_product_edit(p_product uuid, p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select jsonb_build_object(
    'id', p.id, 'brand_name', p.brand_name, 'strength', p.strength, 'rack_location', p.rack_location,
    'reorder_level', p.reorder_level, 'rx_required', p.rx_required, 'is_controlled', p.is_controlled,
    'stock', (select coalesce(sum(qty_base), 0) from stock_balances where branch_id = p_branch and product_id = p.id),
    'base_unit', (select u.name from product_units pu join units u on u.id = pu.unit_id where pu.product_id = p.id and pu.factor_to_base = 1 and pu.archived_at is null limit 1),
    'units', (select coalesce(jsonb_agg(jsonb_build_object('id', pu.id, 'name', u.name, 'factor', pu.factor_to_base,
                'price', (select amount from current_product_prices cp where cp.product_unit_id = pu.id and cp.price_kind = 'retail' and cp.branch_id is null limit 1))
                order by pu.factor_to_base), '[]')
              from product_units pu join units u on u.id = pu.unit_id where pu.product_id = p.id and pu.archived_at is null))
  from products p where p.id = p_product and p.archived_at is null
$$;

do $$
declare f text;
begin
  foreach f in array array['public.set_product_stock(uuid, uuid, bigint, text, uuid)', 'public.remove_product(uuid, text, uuid)',
                           'public.office_product_edit(uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
