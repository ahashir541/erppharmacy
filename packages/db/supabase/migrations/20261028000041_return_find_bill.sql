-- 0041: returns at the counter find a bill from part of its number (e.g. just 12 for KHI1-C1-000012).

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
  -- Just the last digits ("12" finds ...-000012), or any part of the number: the newest bill that matches.
  if not found and trim(p_invoice) ~ '^[0-9]+$' then
    select * into s from sales where tenant_id = app.tenant_id() and branch_id = app.device_branch_id()
      and ltrim(substring(invoice_number from '([0-9]+)$'), '0') = ltrim(trim(p_invoice), '0')
    order by sold_at desc limit 1;
  end if;
  if not found and length(trim(p_invoice)) >= 2 then
    select * into s from sales where tenant_id = app.tenant_id() and branch_id = app.device_branch_id()
      and invoice_number ilike '%' || trim(p_invoice) || '%'
    order by sold_at desc limit 1;
  end if;
  if not found then raise exception 'No bill matching % at this branch', p_invoice using errcode = 'P0002'; end if;
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
