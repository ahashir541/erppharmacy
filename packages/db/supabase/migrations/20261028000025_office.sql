-- 0025: what the back office reads, one named function per screen list, so the same screens work
-- against the cloud (PostgREST calls functions, never raw SQL). Every function runs as the caller
-- (security invoker): Row Level Security decides what each person sees, exactly as before.
-- Also: moving money between the drawer, the safe and bank / wallet accounts, a medicine's detail,
-- and the 7-day sales trend.

create or replace function app.rows(p jsonb) returns jsonb language sql immutable as $$ select coalesce(p, '[]'::jsonb) $$;

-- ---- Sales -----------------------------------------------------------------------------------
create or replace function public.office_invoices(p_from date, p_to date, p_status text, p_q text) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.sold_at desc)) from (
    select s.id, s.invoice_number, s.sold_at, s.status, s.grand_total, s.udhaar_amount, s.discount_total,
           (select full_name from users where id = s.created_by) cashier, (select name from customers where id = s.customer_id) customer
    from owner_sales s
    where s.business_date between p_from and p_to
      and (p_status = 'all' or (p_status = 'udhaar' and s.udhaar_amount > 0 and s.status = 'completed')
           or (p_status = 'paid' and s.udhaar_amount = 0 and s.status = 'completed') or s.status = p_status)
      and (coalesce(p_q, '') = '' or s.invoice_number ilike '%' || p_q || '%'
           or exists (select 1 from customers c where c.id = s.customer_id and (c.name ilike '%' || p_q || '%' or c.phone like '%' || p_q || '%')))
    order by s.sold_at desc limit 500) x
$$;

create or replace function public.office_shifts(p_from date, p_to date) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.opened_at desc)) from (
    select ds.id, d.name drawer, (select full_name from users where id = ds.opened_by) opened_by, (select full_name from users where id = ds.closed_by) closed_by,
           ds.opened_at, ds.closed_at, ds.status, ds.opening_float, ds.counted_cash, r.expected_cash, r.variance,
           case when ds.status = 'open' then (select balance from money_balances where account_kind = 'drawer_session' and account_id = ds.id) end in_drawer_now,
           (select count(distinct sale_id) from sale_payments sp where sp.drawer_session_id = ds.id)::int bills
    from drawer_sessions ds join cash_drawers d on d.id = ds.cash_drawer_id
    left join drawer_session_reconciliations r on r.drawer_session_id = ds.id
    where ds.opened_at::date between p_from and p_to) x
$$;

-- Sales per day for the last 7 days (the dashboard chart).
create or replace function public.office_sales_trend(p_today date) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(jsonb_build_object('day', d.day, 'sales', coalesce(t.sales, 0), 'bills', coalesce(t.bills, 0)) order by d.day))
  from generate_series(p_today - 6, p_today, interval '1 day') d(day)
  left join (select business_date, sum(grand_total) sales, count(*) bills from owner_sales where status = 'completed'
             and business_date between p_today - 6 and p_today group by business_date) t on t.business_date = d.day::date
$$;

-- ---- Stock -----------------------------------------------------------------------------------
create or replace function public.office_products(p_branch uuid, p_q text) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.brand_name)) from (
    select p.id, p.brand_name, p.strength, g.name generic, m.name company, p.rack_location, p.reorder_level, p.is_controlled, p.rx_required,
           coalesce(ps.qty_base, 0)::int stock, coalesce(ps.sellable_qty_base, 0)::int sellable, ps.nearest_expiry,
           (select string_agg(u.name || case when pu.factor_to_base > 1 then ' ' || pu.factor_to_base else '' end, ' · ' order by pu.factor_to_base)
              from product_units pu join units u on u.id = pu.unit_id where pu.product_id = p.id and pu.archived_at is null) packs,
           (select cp.amount from current_product_prices cp join product_units pu on pu.id = cp.product_unit_id
              where cp.product_id = p.id and cp.price_kind = 'retail' order by pu.factor_to_base desc limit 1) box_price,
           (select code from units where id = p.base_unit_id) base_unit
    from products p left join generics g on g.id = p.generic_id left join manufacturers m on m.id = p.manufacturer_id
    left join product_stock ps on ps.product_id = p.id and ps.branch_id = p_branch
    where p.archived_at is null and (coalesce(p_q, '') = '' or p.brand_name ilike '%' || p_q || '%' or g.name ilike '%' || p_q || '%')
    order by p.brand_name limit 1000) x
$$;

create or replace function public.office_product_units(p_product uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(jsonb_build_object('id', pu.id, 'code', u.code, 'name', u.name, 'factor', pu.factor_to_base) order by pu.factor_to_base desc))
  from product_units pu join units u on u.id = pu.unit_id where pu.product_id = p_product and pu.archived_at is null
$$;

-- One medicine: its batches on the shelf, price history and latest movements.
create or replace function public.office_product_detail(p_product uuid, p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select jsonb_build_object(
    'batches', (select app.rows(jsonb_agg(jsonb_build_object('batch_number', b.batch_number, 'expiry_date', b.expiry_date, 'qty_base', sb.qty_base,
                  'days_left', b.expiry_date - current_date, 'mrp', b.mrp, 'retail_price', b.retail_price,
                  'blocked', exists (select 1 from batch_blocks bb where bb.batch_id = b.id and bb.lifted_at is null)) order by b.expiry_date))
                from stock_balances sb join batches b on b.id = sb.batch_id where sb.product_id = p_product and sb.branch_id = p_branch and sb.qty_base > 0),
    'prices', (select app.rows(jsonb_agg(jsonb_build_object('at', pp.effective_from, 'kind', pp.price_kind, 'unit', u.name, 'amount', pp.amount,
                 'by', (select full_name from users where id = pp.created_by)) order by pp.effective_from desc))
               from product_prices pp join product_units pu on pu.id = pp.product_unit_id join units u on u.id = pu.unit_id
               where pp.product_id = p_product and pp.price_kind = 'retail'),
    'movements', (select app.rows(jsonb_agg(to_jsonb(m) order by m.occurred_at desc)) from (
                    select m.occurred_at, m.movement_type, m.qty_base, b.batch_number, (select full_name from users where id = m.created_by) who
                    from stock_movements m join batches b on b.id = m.batch_id
                    where m.product_id = p_product and m.branch_id = p_branch order by m.occurred_at desc limit 40) m))
$$;

create or replace function public.office_expiry(p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.expiry_date)) from (
    select brand_name, strength, rack_location, batch_id, batch_number, expiry_date, qty_base::int, days_left, bucket, is_blocked
    from expiry_dashboard where branch_id = p_branch) x
$$;

create or replace function public.office_movements(p_branch uuid, p_q text) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.occurred_at desc)) from (
    select m.occurred_at, p.brand_name, b.batch_number, m.movement_type, m.qty_base::int, m.reason,
           (select full_name from users where id = m.created_by) who,
           coalesce((select invoice_number from sales where id = m.reference_id), (select grn_number from grns where id = m.reference_id)) ref
    from stock_movements m join products p on p.id = m.product_id join batches b on b.id = m.batch_id
    where m.branch_id = p_branch and (coalesce(p_q, '') = '' or p.brand_name ilike '%' || p_q || '%')
    order by m.occurred_at desc, m.id desc limit 500) x
$$;

create or replace function public.office_product_search(p_q text) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.brand_name)) from (
    select p.id, p.brand_name, (select json_agg(json_build_object('id', pu.id, 'name', u.name, 'factor', pu.factor_to_base) order by pu.factor_to_base desc)
                                from product_units pu join units u on u.id = pu.unit_id where pu.product_id = p.id and pu.archived_at is null) units
    from products p where p.archived_at is null and p.brand_name ilike '%' || p_q || '%' order by p.brand_name limit 12) x
$$;

-- ---- Customers, suppliers, money accounts ------------------------------------------------------
create or replace function public.office_money_accounts(p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x))) from (
    select 'drawer' kind, ds.id, d.name || ' (cash, open shift)' name from drawer_sessions ds join cash_drawers d on d.id = ds.cash_drawer_id
    where ds.status = 'open' and ds.branch_id = p_branch
    union all select 'bank', id, name from bank_accounts where archived_at is null) x
$$;

create or replace function public.office_customers(p_q text) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.balance desc, x.name)) from (
    select c.id customer_id, a.id account_id, a.account_number, c.name, c.phone, coalesce(pb.balance, 0)::bigint balance, a.udhaar_blocked,
           (select limit_amount from credit_limits cl where cl.account_id = a.id order by effective_from desc, created_at desc limit 1) credit_limit,
           coalesce(cs.status, 'no_limit_set') status
    from customers c join customer_accounts a on a.id = c.account_id
    left join party_balances pb on pb.party_type = 'customer_account' and pb.party_id = a.id
    left join customer_credit_status cs on cs.account_id = a.id
    where c.archived_at is null and (coalesce(p_q, '') = '' or c.name ilike '%' || p_q || '%' or c.phone like '%' || p_q || '%' or a.account_number ilike p_q)) x
$$;

create or replace function public.office_suppliers() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.balance desc, x.name)) from (
    select s.id, s.name, s.phone, coalesce(s.whatsapp, s.phone) whatsapp, s.payment_terms_days, coalesce(pb.balance, 0)::bigint balance
    from suppliers s left join party_balances pb on pb.party_type = 'supplier' and pb.party_id = s.id
    where s.archived_at is null) x
$$;

-- ---- Purchases -------------------------------------------------------------------------------
create or replace function public.office_deliveries(p_branch uuid) returns jsonb
language sql security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.received_at desc)) from (
    select g.id, g.grn_number, g.received_at, s.name supplier, coalesce(pi.supplier_invoice_number, g.supplier_invoice_number) invoice_no, pi.grand_total total,
           (select count(*) from grn_lines gl where gl.grn_id = g.id)::int lines,
           (select o.open_amount from public.open_bills('supplier', g.supplier_id) o where o.entry_id =
              (select le.id from ledger_entries le where le.reference_type = 'purchase_invoice' and le.reference_id = pi.id limit 1)) open
    from grns g join suppliers s on s.id = g.supplier_id left join purchase_invoices pi on pi.grn_id = g.id and pi.status = 'posted'
    where g.branch_id = p_branch order by g.received_at desc limit 300) x
$$;

create or replace function public.office_order_lines(p_order uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x))) from (
    select pl.id, pl.product_id, p.brand_name, pl.product_unit_id unit_id, pl.qty::int, pl.bonus_qty::int,
           (select json_agg(json_build_object('id', pu.id, 'name', u.name, 'factor', pu.factor_to_base) order by pu.factor_to_base desc)
              from product_units pu join units u on u.id = pu.unit_id where pu.product_id = p.id) units
    from po_lines pl join products p on p.id = pl.product_id where pl.purchase_order_id = p_order) x
$$;

create or replace function public.office_orders(p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.created_at desc)) from (
    select po.id, po.po_number, po.supplier_id, s.name supplier, coalesce(s.whatsapp, s.phone) supplier_whatsapp, po.order_date, po.status, po.created_at,
           (select count(*) from po_lines where purchase_order_id = po.id)::int lines
    from purchase_orders po join suppliers s on s.id = po.supplier_id where po.branch_id = p_branch order by po.created_at desc limit 200) x
$$;

create or replace function public.office_returns(p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.created_at desc)) from (
    select r.id, r.return_number, r.created_at, s.name supplier, r.reason, r.status, c.claimed_amount claimed, c.settled_amount settled
    from purchase_returns r join suppliers s on s.id = r.supplier_id
    left join supplier_claims c on c.reference_type = 'purchase_return' and c.reference_id = r.id
    where r.branch_id = p_branch) x
$$;

create or replace function public.office_shelf_batches(p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(jsonb_build_object('batch_id', batch_id, 'qty_base', qty_base,
           'label', brand_name || ' · ' || batch_number || ' · exp ' || to_char(expiry_date, 'DD Mon YY') || ' · ' || qty_base || ' in stock') order by expiry_date))
  from expiry_dashboard where branch_id = p_branch
$$;

-- ---- Money -----------------------------------------------------------------------------------
create or replace function public.office_expenses(p_branch uuid, p_from date, p_to date) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.expense_date desc, x.created_at desc)) from (
    select e.id, e.expense_date, e.created_at, c.name category, e.description, e.amount, e.paid_from, e.status, (select full_name from users where id = e.created_by) "by"
    from expenses e join expense_categories c on c.id = e.category_id
    where e.branch_id = p_branch and e.expense_date between p_from and p_to) x
$$;

create or replace function public.office_expense_categories() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)) from expense_categories where archived_at is null
$$;

create or replace function public.office_balances() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x))) from (
    select 'drawer' kind, ds.id, d.name || ' · ' || (select full_name from users where id = ds.opened_by) || ' (open)' name, coalesce(mb.balance, 0)::bigint balance
    from drawer_sessions ds join cash_drawers d on d.id = ds.cash_drawer_id
    left join money_balances mb on mb.account_kind = 'drawer_session' and mb.account_id = ds.id where ds.status = 'open'
    union all
    select 'bank', b.id, b.name, coalesce(mb.balance, 0)::bigint from bank_accounts b
    left join money_balances mb on mb.account_kind = 'bank_account' and mb.account_id = b.id where b.archived_at is null) x
$$;

create or replace function public.office_cash_moves(p_from date, p_to date, p_account text) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.occurred_at desc)) from (
    select m.occurred_at, coalesce(b.name, d.name || ' drawer') account, m.movement_type, m.memo, m.amount, (select full_name from users where id = m.created_by) who
    from cash_movements m left join bank_accounts b on b.id = m.bank_account_id
    left join drawer_sessions ds on ds.id = m.drawer_session_id left join cash_drawers d on d.id = ds.cash_drawer_id
    where m.occurred_at::date between p_from and p_to and (p_account = 'all' or m.bank_account_id::text = p_account or m.drawer_session_id::text = p_account)
    order by m.occurred_at desc limit 500) x
$$;

-- Moving money: drawer → safe or bank, wallet → bank, bank → drawer (change for the till).
-- p: from_kind 'drawer'|'bank', from_id, to_kind, to_id, amount, memo
create or replace function public.transfer_money(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('cash.view');
  tid uuid := app.tenant_id();
  amt bigint := app.try_bigint(p ->> 'amount');
  ref uuid := app.uuid_v7();
  fbr uuid;
  tbr uuid;
begin
  if amt is null or amt <= 0 then raise exception 'The amount must be above 0' using errcode = '22023'; end if;
  if (p ->> 'from_id') = (p ->> 'to_id') then raise exception 'Choose two different accounts' using errcode = '22023'; end if;
  if (p ->> 'from_kind') = 'drawer' then
    select branch_id into fbr from drawer_sessions where id = (p ->> 'from_id')::uuid and tenant_id = tid and status = 'open';
    if fbr is null then raise exception 'That drawer is not open' using errcode = 'P0001'; end if;
    if coalesce((select balance from money_balances where account_kind = 'drawer_session' and account_id = (p ->> 'from_id')::uuid), 0) < amt then
      raise exception 'There is not that much cash in the drawer' using errcode = 'P0001';
    end if;
  elsif not exists (select 1 from bank_accounts where id = (p ->> 'from_id')::uuid and tenant_id = tid) then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  if (p ->> 'to_kind') = 'drawer' then
    select branch_id into tbr from drawer_sessions where id = (p ->> 'to_id')::uuid and tenant_id = tid and status = 'open';
    if tbr is null then raise exception 'That drawer is not open' using errcode = 'P0001'; end if;
  elsif not exists (select 1 from bank_accounts where id = (p ->> 'to_id')::uuid and tenant_id = tid) then
    raise exception 'Account not found' using errcode = 'P0002';
  end if;
  insert into cash_movements (tenant_id, branch_id, drawer_session_id, bank_account_id, movement_type, amount, reference_type, reference_id, memo, occurred_at, created_by)
  values (tid, fbr, case when (p ->> 'from_kind') = 'drawer' then (p ->> 'from_id')::uuid end,
          case when (p ->> 'from_kind') = 'bank' then (p ->> 'from_id')::uuid end, 'account_transfer', -amt, 'transfer', ref, p ->> 'memo', now(), uid),
         (tid, tbr, case when (p ->> 'to_kind') = 'drawer' then (p ->> 'to_id')::uuid end,
          case when (p ->> 'to_kind') = 'bank' then (p ->> 'to_id')::uuid end, 'account_transfer', amt, 'transfer', ref, p ->> 'memo', now(), uid);
  perform app.log_event('money_transfer', 'cash_movements', ref, p, coalesce(fbr, tbr));
  return ref;
end $$;

-- Every pharmacy gets a "Cash in safe" account for money taken out of the drawers.
insert into bank_accounts (tenant_id, kind, name)
select t.id, 'other', 'Cash in safe' from tenants t
where not exists (select 1 from bank_accounts b where b.tenant_id = t.id and b.name = 'Cash in safe');
create or replace function app.safe_account_for_new_tenant() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  insert into bank_accounts (tenant_id, kind, name) values (new.id, 'other', 'Cash in safe');
  return null;
end $$;
create trigger trg_safe_account after insert on tenants for each row execute function app.safe_account_for_new_tenant();

-- ---- Admin -----------------------------------------------------------------------------------
create or replace function public.office_approvals() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.created_at desc)) from (
    select a.id, a.kind, a.permission_code, a.amount, a.details, a.created_at, a.expires_at, (select full_name from users where id = a.created_by) who
    from approval_requests a where a.status = 'pending' and (a.expires_at is null or a.expires_at > now())) x
$$;

create or replace function public.office_notifications() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.created_at desc)) from (
    select id, kind, title, body, created_at, read_at from notifications order by created_at desc limit 200) x
$$;

create or replace function public.office_team() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.kind desc, x.full_name)) from (
    select u.id, u.full_name, u.kind, u.status, u.phone,
           (select string_agg(r.name || coalesce(' @ ' || b.name, ' (all branches)'), ', ') from user_roles ur join roles r on r.id = ur.role_id
              left join branches b on b.id = ur.branch_id where ur.user_id = u.id and ur.archived_at is null) roles,
           u.id in (select public.staff_with_pin()) has_pin,
           (select max(coalesce(last_active_at, started_at)) from user_sessions s where s.user_id = u.id) last_seen
    from users u where u.archived_at is null) x
$$;

create or replace function public.office_roles() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name)) from roles where archived_at is null and template_code is distinct from 'owner'
$$;

create or replace function public.office_settings(p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select jsonb_build_object(
    'business', (select to_jsonb(x) from (
       select t.name, t.owner_name, t.owner_phone, t.city, t.status, t.trial_ends_at, b.name branch, b.address, b.phone,
              (select value #>> '{}' from settings where key = 'pos.receipt_footer' and branch_id is null limit 1) footer,
              (select (value #>> '{}')::int from settings where key = 'pos.receipt_width' and branch_id is null limit 1) width,
              (select (value #>> '{}')::int from settings where key = 'pos.bill_rounding_minor' and branch_id is null limit 1) rounding
       from tenants t join branches b on b.tenant_id = t.id where b.id = p_branch) x),
    'rules', (select app.rows(jsonb_agg(jsonb_build_object('kind', kind, 'enabled', enabled, 'threshold', threshold))) from alert_rules),
    'devices', (select app.rows(jsonb_agg(jsonb_build_object('name', name, 'last_seen_at', last_seen_at, 'last_sync_at', last_sync_at,
                  'app_version', app_version, 'status', status) order by name)) from devices where archived_at is null))
$$;

do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'office\_%' or (n.nspname = 'public' and p.proname = 'transfer_money')
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
grant execute on function app.rows(jsonb) to authenticated;
select app.assert_rls_everywhere();
