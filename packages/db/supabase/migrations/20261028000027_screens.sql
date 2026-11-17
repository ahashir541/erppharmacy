-- 0027: reads for the last screens: a bill for a return at the counter, the stock count sheet and
-- the counts list, and a role's permissions for the owner's permission editor.

-- A bill the counter may take a return against (its branch, within the "recent bills" days):
-- every line with how much is still returnable.
create or replace function public.pos_bill_for_return(p_invoice text) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  s sales;
  days int;
begin
  if app.current_device_id() is null then raise exception 'Returns are taken on a registered counter PC' using errcode = '42501'; end if;
  days := coalesce((app.setting(app.tenant_id(), app.device_branch_id(), 'pos.recent_bills_days') #>> '{}')::int, 7);
  select * into s from sales where tenant_id = app.tenant_id() and upper(invoice_number) = upper(trim(p_invoice))
    and branch_id = app.device_branch_id();
  if not found then raise exception 'Bill % not found at this branch', p_invoice using errcode = 'P0002'; end if;
  if s.status = 'voided' then raise exception 'That bill was voided' using errcode = 'P0001'; end if;
  if s.sold_at < now() - make_interval(days => days) then
    raise exception 'Bills older than % days cannot be returned at the counter', days using errcode = 'P0001';
  end if;
  return jsonb_build_object('sale_id', s.id, 'invoice_number', s.invoice_number, 'sold_at', s.sold_at, 'grand_total', s.grand_total,
    'customer', (select name from customers where id = s.customer_id), 'on_khata', s.udhaar_amount > 0,
    'lines', (select app.rows(jsonb_agg(jsonb_build_object(
        'sale_line_id', sl.id, 'name', p.brand_name, 'unit', u.name, 'factor', pu.factor_to_base, 'qty', sl.qty, 'qty_base', sl.qty_base,
        'unit_price', sl.unit_price, 'line_total', sl.line_total, 'batch', b.batch_number,
        'returned_base', coalesce((select sum(rl.qty_base) from return_lines rl join sale_returns r on r.id = rl.sale_return_id
                                   where rl.sale_line_id = sl.id and r.status = 'completed'), 0)) order by sl.line_no))
      from sale_lines sl join products p on p.id = sl.product_id join product_units pu on pu.id = sl.product_unit_id
      join units u on u.id = pu.unit_id join batches b on b.id = sl.batch_id where sl.sale_id = s.id));
end $$;
revoke all on function public.pos_bill_for_return(text) from public, anon;
grant execute on function public.pos_bill_for_return(text) to authenticated;

-- Stock counts (owner): the list, and one count's sheet with what the system expects.
create or replace function public.office_stock_counts(p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.started_at desc)) from (
    select sc.id, sc.kind, sc.rack_filter, sc.status, sc.started_at, sc.submitted_at, sc.approved_at,
           (select count(*) from stock_count_lines l where l.stock_count_id = sc.id)::int lines,
           (select coalesce(sum(r.variance_qty), 0) from stock_count_lines l join stock_count_results r on r.stock_count_line_id = l.id
            where l.stock_count_id = sc.id)::int variance
    from stock_counts sc where sc.branch_id = p_branch limit 100) x
$$;

create or replace function public.office_stock_count_sheet(p_count uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.rack_location nulls last, x.brand_name, x.expiry_date)) from (
    select b.id batch_id, p.brand_name, p.rack_location, b.batch_number, b.expiry_date, sb.qty_base::int system_qty,
           (select l.counted_qty from stock_count_lines l where l.stock_count_id = sc.id and l.batch_id = b.id
            order by l.counted_at desc limit 1)::int counted,
           (select r.variance_qty from stock_count_lines l join stock_count_results r on r.stock_count_line_id = l.id
            where l.stock_count_id = sc.id and l.batch_id = b.id order by l.counted_at desc limit 1)::int variance
    from stock_counts sc
    join stock_balances sb on sb.branch_id = sc.branch_id
    join batches b on b.id = sb.batch_id join products p on p.id = sb.product_id
    where sc.id = p_count and (sb.qty_base > 0 or exists (select 1 from stock_count_lines l where l.stock_count_id = sc.id and l.batch_id = b.id))
      and (sc.rack_filter is null or p.rack_location ilike sc.rack_filter || '%')) x
$$;

-- A role's permissions, every switch with its group, limit kind and current setting.
create or replace function public.office_role_permissions(p_role uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(jsonb_build_object(
      'code', p.code, 'module', p.module, 'name', p.name, 'limit_kind', p.limit_kind, 'is_sensitive', p.is_sensitive,
      'allowed', coalesce(rp.allowed, false), 'needs_approval', coalesce(rp.needs_approval, false), 'limit_value', rp.limit_value)
      order by p.sort_order, p.code))
  from permissions p left join role_permissions rp on rp.role_id = p_role and rp.permission_code = p.code
$$;

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('office_stock_counts', 'office_stock_count_sheet', 'office_role_permissions')
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
select app.assert_rls_everywhere();
