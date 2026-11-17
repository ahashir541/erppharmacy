-- 0024: what the POS screen reads. One call each for: who and where (the counter's context), finding
-- a medicine (by name, generic or barcode), the batches of a medicine on this branch's shelf (first
-- expiry first), and finding a customer. Never any cost; a customer shows only "allowed / not" and
-- the headroom (D13), never the balance.

-- The counter: pharmacy, branch, this PC, its drawers and open shift, staff who may sign in here
-- (with their PIN hashes, checked on the PC: D34), and the counter settings.
create or replace function public.pos_context() returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  dev devices;
  br branches;
begin
  select * into dev from devices where id = app.current_device_id();
  if dev.id is null then raise exception 'A registered pharmacy PC is required' using errcode = '42501'; end if;
  select * into br from branches where id = dev.branch_id;
  return jsonb_build_object(
    'pharmacy', (select name from tenants where id = dev.tenant_id),
    'language', (select default_language from tenants where id = dev.tenant_id),
    'branch', jsonb_build_object('id', br.id, 'code', br.code, 'name', br.name, 'address', br.address, 'phone', br.phone),
    'device', jsonb_build_object('id', dev.id, 'code', dev.code, 'name', dev.name, 'invoice_prefix', dev.invoice_prefix),
    'drawers', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name) order by d.name), '[]')
                from cash_drawers d where d.device_id = dev.id and d.archived_at is null),
    'open_shift', (select jsonb_build_object('drawer_session_id', ds.id, 'opened_by', ds.opened_by, 'opened_at', ds.opened_at,
                                             'opened_by_name', (select full_name from users where id = ds.opened_by))
                   from drawer_sessions ds join cash_drawers d on d.id = ds.cash_drawer_id
                   where d.device_id = dev.id and ds.status = 'open' order by ds.opened_at desc limit 1),
    'next_invoice_seq', coalesce((select max(local_seq) from sales where device_id = dev.id), 0) + 1,
    'next_return_seq', coalesce((select max(local_seq) from sale_returns where device_id = dev.id), 0) + 1,
    'staff', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.full_name, 'kind', u.kind,
                'pin_hash', p.pin_hash, 'locked_until', p.locked_until, 'idle_lock_seconds', u.idle_lock_seconds,
                'roles', (select coalesce(jsonb_agg(distinct r.name), '[]') from user_roles ur join roles r on r.id = ur.role_id
                          where ur.user_id = u.id and ur.archived_at is null and (ur.branch_id is null or ur.branch_id = br.id)),
                'can_approve', app.permission_decision(u.id, 'approvals.decide', br.id) = 'allow')
                order by u.kind desc, u.full_name), '[]')
              from users u join user_pins p on p.user_id = u.id
              where u.tenant_id = dev.tenant_id and u.status = 'active' and u.archived_at is null
                and (u.is_primary_owner or u.kind = 'owner'
                     or exists (select 1 from user_roles ur where ur.user_id = u.id and ur.archived_at is null
                                and (ur.branch_id is null or ur.branch_id = br.id)))),
    'settings', jsonb_build_object(
      'rounding_step', coalesce((app.setting(dev.tenant_id, br.id, 'pos.bill_rounding_minor') #>> '{}')::int, 100),
      'receipt_width', coalesce((app.setting(dev.tenant_id, br.id, 'pos.receipt_width') #>> '{}')::int, 80),
      'receipt_footer', app.setting(dev.tenant_id, br.id, 'pos.receipt_footer') #>> '{}'),
    'today', app.business_date(br.id));
end $$;

-- What may be sold from each batch of a product at this branch: not expired, not frozen, in stock.
create or replace function app.pos_stock(p_product uuid, p_branch uuid)
returns table (batch_id uuid, batch_number text, expiry_date date, qty_base bigint)
language sql stable security definer set search_path = public, app as $$
  select b.id, b.batch_number, b.expiry_date, sb.qty_base
  from stock_balances sb join batches b on b.id = sb.batch_id
  where sb.product_id = p_product and sb.branch_id = p_branch and sb.qty_base > 0
    and b.expiry_date >= app.business_date(p_branch)
    and not exists (select 1 from batch_blocks bb where bb.batch_id = b.id and bb.lifted_at is null
                    and (bb.branch_id is null or bb.branch_id = p_branch))
$$;

-- Finding a medicine: a barcode (exact), or words in the brand or generic name. Each result carries
-- its pack sizes with the selling price of each (from the batch that sells first), the stock on the
-- shelf in the smallest unit, and the nearest expiry.
create or replace function public.pos_search(p_query text, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  br uuid := app.device_branch_id();
  q text := trim(coalesce(p_query, ''));
  tid uuid := app.tenant_id();
begin
  if br is null then raise exception 'A registered pharmacy PC is required' using errcode = '42501'; end if;
  if length(q) = 0 then return '[]'; end if;
  return (select coalesce(jsonb_agg(r.j order by r.rank, r.name), '[]') from (
    select p.brand_name as name,
           case when bc.code is not null then 0 when p.brand_name ilike q || '%' then 1 else 2 end as rank,
           jsonb_build_object(
             'product_id', p.id, 'name', p.brand_name, 'name_ur', p.brand_name_ur, 'strength', p.strength,
             'dosage_form', p.dosage_form, 'generic', g.name, 'manufacturer', m.name, 'rack', p.rack_location,
             'is_controlled', p.is_controlled, 'rx_required', p.rx_required, 'max_qty_per_sale', p.max_qty_per_sale,
             'barcode_unit_id', bc.product_unit_id,
             'stock_base', coalesce((select sum(s.qty_base) from app.pos_stock(p.id, br) s), 0),
             'nearest_expiry', (select min(s.expiry_date) from app.pos_stock(p.id, br) s),
             'units', (select coalesce(jsonb_agg(jsonb_build_object(
                          'product_unit_id', pu.id, 'unit', u.code, 'unit_name', u.name, 'unit_name_ur', u.name_ur,
                          'factor', pu.factor_to_base,
                          'price', app.unit_price(pu.id, (select s.batch_id from app.pos_stock(p.id, br) s order by s.expiry_date, s.batch_id limit 1), br, 'retail'))
                          order by pu.factor_to_base desc), '[]')
                       from product_units pu join units u on u.id = pu.unit_id
                       where pu.product_id = p.id and pu.archived_at is null and pu.is_sellable)) as j
    from products p
    left join generics g on g.id = p.generic_id
    left join manufacturers m on m.id = p.manufacturer_id
    left join lateral (select x.code, x.product_unit_id from barcodes x where x.product_id = p.id and x.code = q and x.archived_at is null limit 1) bc on true
    where p.tenant_id = tid and p.archived_at is null and p.is_active
      and (bc.code is not null or p.brand_name ilike '%' || q || '%' or g.name ilike '%' || q || '%')
    order by 2, p.brand_name
    limit least(greatest(coalesce(p_limit, 20), 1), 50)) r);
end $$;

-- The batches of one medicine on this branch's shelf, first expiry first, with the price of each
-- pack size from that batch (a batch's printed price wins, D18).
create or replace function public.pos_batches(p_product uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare br uuid := app.device_branch_id();
begin
  if br is null then raise exception 'A registered pharmacy PC is required' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'batch_id', s.batch_id, 'batch_number', s.batch_number, 'expiry_date', s.expiry_date, 'qty_base', s.qty_base,
      'prices', (select coalesce(jsonb_object_agg(pu.id, app.unit_price(pu.id, s.batch_id, br, 'retail')), '{}')
                 from product_units pu where pu.product_id = p_product and pu.archived_at is null))
      order by s.expiry_date, s.batch_id), '[]')
    from app.pos_stock(p_product, br) s
    where exists (select 1 from products where id = p_product and tenant_id = app.tenant_id()));
end $$;

-- Finding a customer by name, phone or account number: whether udhaar is allowed and how much more
-- can go on the khata (D13), never the balance.
create or replace function public.pos_customers(p_query text, p_limit int default 10) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare q text := trim(coalesce(p_query, ''));
begin
  if app.tenant_id() is null then raise exception 'Sign-in required' using errcode = '42501'; end if;
  if length(q) < 2 then return '[]'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'customer_id', c.id, 'account_id', a.id, 'account_number', a.account_number, 'name', c.name, 'name_ur', c.name_ur,
      'phone', c.phone, 'can_buy_on_account', c.can_buy_on_account and not a.udhaar_blocked,
      'udhaar_status', coalesce(cs.status, 'no_limit_set'), 'available_credit', cs.available_credit)
      order by c.name), '[]')
    from (select * from customers where tenant_id = app.tenant_id() and archived_at is null
            and (name ilike '%' || q || '%' or phone like '%' || regexp_replace(q, '\D', '', 'g') || '%' and length(regexp_replace(q, '\D', '', 'g')) >= 4
                 or account_id in (select id from customer_accounts where account_number ilike q))
          order by name limit least(greatest(coalesce(p_limit, 10), 1), 30)) c
    join customer_accounts a on a.id = c.account_id
    left join customer_credit_status cs on cs.account_id = a.id);
end $$;

-- Bills held at this branch and not yet resumed or discarded.
create or replace function public.pos_held_bills() returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'label', h.label, 'cart', h.cart, 'held_at', h.held_at,
                                               'by', (select full_name from users where id = h.created_by)) order by h.held_at desc), '[]')
  from held_bills h
  where h.branch_id = app.device_branch_id() and h.resumed_at is null and h.discarded_at is null
$$;

-- Who has a counter PIN (for the Team page). Never the hash itself.
create or replace function public.staff_with_pin() returns setof uuid
language sql stable security definer set search_path = public, app as $$
  select user_id from user_pins
  where tenant_id = app.tenant_id() and app.current_user_id() is not null and app.has_perm('staff.manage')
$$;

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon', f);
  end loop;
end $$;
revoke all on all functions in schema app from public;
grant execute on function public.pos_context(), public.pos_search(text, int), public.pos_batches(uuid),
  public.pos_customers(text, int), public.pos_held_bills(), public.staff_with_pin() to authenticated;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;
select app.assert_rls_everywhere();
