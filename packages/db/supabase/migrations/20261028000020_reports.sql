-- 0020: Phase 6 — owner dashboard and reports. Owner-only by default; every function checks its
-- own permission and only counts branches the caller may see. None of them answers a counter PC.
--
-- One set of facts feeds everything (app.sale_facts): each bill line, and each returned line as
-- a negative line, with its revenue (excluding tax), tax, discount and cost of goods. A return
-- gives back revenue in proportion to what was refunded and, when restocked, its cost; damaged
-- returns keep their cost (it is a loss).

create or replace function app.sale_facts(p_from date, p_to date, p_branches uuid[])
returns table (kind text, branch_id uuid, business_date date, at timestamptz, sale_id uuid, invoice_number text, staff_id uuid,
               product_id uuid, category_id uuid, manufacturer_id uuid, qty_base bigint, gross bigint, discount bigint, tax bigint,
               revenue bigint, cogs bigint)
language sql stable security definer set search_path = public, app as $$
  select 'sale', s.branch_id, s.business_date, s.sold_at, s.id, s.invoice_number, s.created_by,
         sl.product_id, p.category_id, p.manufacturer_id, sl.qty_base, sl.line_total, sl.discount_amount, sl.tax_amount,
         sl.line_total - sl.tax_amount, c.cogs
  from sales s
  join sale_lines sl on sl.sale_id = s.id
  join products p on p.id = sl.product_id
  left join sale_line_costs c on c.sale_line_id = sl.id
  where s.tenant_id = app.tenant_id() and s.status = 'completed' and s.branch_id = any (p_branches)
    and s.business_date between p_from and p_to
  union all
  select 'return', r.branch_id, app.business_date(r.branch_id, r.returned_at), r.returned_at, s.id, r.return_number, r.created_by,
         sl.product_id, p.category_id, p.manufacturer_id, -rl.qty_base, -rl.refund_amount, 0,
         -app.div_round(rl.refund_amount::numeric * sl.tax_amount, nullif(sl.line_total, 0))::bigint,
         -(rl.refund_amount - coalesce(app.div_round(rl.refund_amount::numeric * sl.tax_amount, nullif(sl.line_total, 0)), 0))::bigint,
         case when rl.restock then -app.div_round(c.cogs::numeric * rl.qty_base, sl.qty_base)::bigint else 0 end
  from sale_returns r
  join return_lines rl on rl.sale_return_id = r.id
  join sale_lines sl on sl.id = rl.sale_line_id
  join sales s on s.id = sl.sale_id
  join products p on p.id = sl.product_id
  left join sale_line_costs c on c.sale_line_id = sl.id
  where r.tenant_id = app.tenant_id() and r.status = 'completed' and r.branch_id = any (p_branches)
    and app.business_date(r.branch_id, r.returned_at) between p_from and p_to
$$;

-- Branches the caller may report on for a permission (optionally just one).
create or replace function app.report_branches(p_perm text, p_branch uuid) returns uuid[]
language plpgsql stable security definer set search_path = public, app as $$
declare b uuid[];
begin
  perform app.require_perm(p_perm);
  b := app.branches_with(p_perm);
  if p_branch is not null then
    if not p_branch = any (b) then raise exception 'Branch not found' using errcode = 'P0002'; end if;
    b := array[p_branch];
  end if;
  return b;
end $$;

-- ---- Owner dashboard -------------------------------------------------------------------
-- Today, this week and this month against the period before, per branch and in total, plus what
-- needs attention. Each part appears only with its own permission.
create or replace function public.owner_dashboard(p_date date default null, p_branch uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  b uuid[] := app.report_branches('sales.view_totals', p_branch);
  d date := coalesce(p_date, app.business_date(coalesce(p_branch, (select id from branches where id = any (b) order by code limit 1))));
  uid uuid := app.current_user_id();
  profit boolean := app.has_perm('sales.view_profit');
  periods jsonb := '{}';
  p record;
  cur record;
  prev record;
  result jsonb;
begin
  for p in select * from (values
      ('today', d, d, d - 1, d - 1),
      ('week', date_trunc('week', d)::date, d, date_trunc('week', d)::date - 7, d - 7),
      ('month', date_trunc('month', d)::date, d, (date_trunc('month', d) - interval '1 month')::date,
       least((date_trunc('month', d) - interval '1 month')::date + (d - date_trunc('month', d)::date), date_trunc('month', d)::date - 1))
    ) x(name, f, t, pf, pt) loop
    select coalesce(sum(gross), 0) sales, count(distinct sale_id) filter (where kind = 'sale') bills,
           coalesce(sum(revenue), 0) revenue, coalesce(sum(cogs), 0) cogs, count(*) filter (where cogs is null) pending
    into cur from app.sale_facts(p.f, p.t, b);
    select coalesce(sum(gross), 0) sales, coalesce(sum(revenue), 0) revenue, coalesce(sum(cogs), 0) cogs
    into prev from app.sale_facts(p.pf, p.pt, b);
    periods := periods || jsonb_build_object(p.name, jsonb_build_object(
      'from', p.f, 'to', p.t, 'sales', cur.sales, 'bills', cur.bills, 'previous_sales', prev.sales,
      'change_bp', case when prev.sales > 0 then app.div_round((cur.sales - prev.sales)::numeric * 10000, prev.sales) end)
      || case when profit then jsonb_build_object(
           'gross_profit', cur.revenue - cur.cogs, 'margin_bp', case when cur.revenue > 0 then app.div_round((cur.revenue - cur.cogs)::numeric * 10000, cur.revenue) end,
           'previous_gross_profit', prev.revenue - prev.cogs, 'lines_cost_pending', cur.pending) else '{}' end);
  end loop;

  result := jsonb_build_object('date', d, 'periods', periods,
    'branches', (select coalesce(jsonb_agg(jsonb_build_object('branch_id', br.id, 'name', br.name,
                   'sales_today', (select coalesce(sum(gross), 0) from app.sale_facts(d, d, array[br.id])),
                   'sales_month', (select coalesce(sum(gross), 0) from app.sale_facts(date_trunc('month', d)::date, d, array[br.id])))
                   order by br.code), '[]')
                 from branches br where br.id = any (b)),
    'top_products', (select coalesce(jsonb_agg(x order by x.sales desc), '[]') from (
                      select pr.brand_name as name, sum(f.gross) as sales, sum(f.qty_base) as qty
                      from app.sale_facts(date_trunc('month', d)::date, d, b) f join products pr on pr.id = f.product_id
                      group by pr.brand_name order by sum(f.gross) desc limit 10) x),
    'attention', jsonb_build_object(
      'voids_today', (select count(*) from sales where tenant_id = app.tenant_id() and branch_id = any (b) and status = 'voided'
                      and app.business_date(branch_id, voided_at) = d),
      'discounts_today', (select coalesce(sum(discount), 0) from app.sale_facts(d, d, b) where kind = 'sale'),
      'returns_today', (select count(distinct invoice_number) from app.sale_facts(d, d, b) where kind = 'return'),
      'open_flags', (select count(*) from sync_flags where tenant_id = app.tenant_id() and branch_id = any (b) and status = 'open'),
      'pending_approvals', (select count(*) from approval_requests where tenant_id = app.tenant_id() and branch_id = any (b)
                            and status = 'pending' and (expires_at is null or expires_at > now()))));
  if profit then
    result := result || jsonb_build_object('top_by_profit', (select coalesce(jsonb_agg(x order by x.profit desc), '[]') from (
                select pr.brand_name as name, sum(f.revenue - coalesce(f.cogs, 0)) as profit
                from app.sale_facts(date_trunc('month', d)::date, d, b) f join products pr on pr.id = f.product_id
                group by pr.brand_name order by 2 desc limit 10) x));
  end if;
  if app.has_perm('cash.view') then
    result := result || jsonb_build_object('cash_in_open_drawers', (select coalesce(sum(mb.balance), 0) from money_balances mb
                join drawer_sessions ds on ds.id = mb.account_id
                where mb.account_kind = 'drawer_session' and ds.status = 'open' and ds.branch_id = any (b)));
  end if;
  if app.has_perm('cash.view_variance') then
    result := result || jsonb_build_object('cash_short_over_month', (select coalesce(jsonb_agg(x), '[]') from (
                select u.full_name as staff, sum(r.variance) as variance, count(*) as closings
                from drawer_session_reconciliations r join drawer_sessions ds on ds.id = r.drawer_session_id
                join users u on u.id = coalesce(ds.closed_by, ds.opened_by)
                where ds.branch_id = any (b) and app.business_date(ds.branch_id, ds.closed_at) between date_trunc('month', d)::date and d
                group by u.full_name) x));
  end if;
  if app.has_perm('udhaar.view_balance') then
    result := result || jsonb_build_object(
      'udhaar_receivable', (select coalesce(sum(balance), 0) from party_balances where tenant_id = app.tenant_id()
                            and party_type = 'customer_account' and balance > 0),
      'udhaar_given_today', (select coalesce(sum(debit), 0) from ledger_entries where tenant_id = app.tenant_id()
                             and party_type = 'customer_account' and entry_type = 'credit_sale' and entry_date = d),
      'udhaar_collected_today', (select coalesce(sum(credit), 0) from ledger_entries where tenant_id = app.tenant_id()
                                 and party_type = 'customer_account' and entry_type = 'payment' and entry_date = d));
  end if;
  if app.has_perm('payables.view') then
    result := result || jsonb_build_object('supplier_payable', (select coalesce(sum(balance), 0) from party_balances
                where tenant_id = app.tenant_id() and party_type = 'supplier' and balance > 0));
  end if;
  if app.has_perm('reports.stock_value') then
    result := result || jsonb_build_object(
      'expiring_90_days_cost', (select coalesce(sum(v.cost_value), 0) from app.stock_values(b) v where v.expiry_date <= d + 90),
      'dead_stock_cost', (select coalesce(sum(v.cost_value), 0) from app.stock_values(b) v
                          where not exists (select 1 from stock_movements m where m.batch_id = v.batch_id and m.branch_id = v.branch_id
                                            and m.movement_type = 'sale' and m.occurred_at > d - 90)));
  end if;
  return result;
end $$;

-- ---- Stock value ---------------------------------------------------------------------------
-- Each batch on the shelf at cost (its weighted average, D14) and at its retail price.
create or replace function app.stock_values(p_branches uuid[])
returns table (branch_id uuid, product_id uuid, batch_id uuid, expiry_date date, qty_base bigint, cost_value bigint, retail_value bigint)
language sql stable security definer set search_path = public, app as $$
  select sb.branch_id, sb.product_id, sb.batch_id, b.expiry_date, sb.qty_base,
         app.batch_cogs(sb.batch_id, sb.qty_base),
         app.div_round(sb.qty_base::numeric * coalesce(app.unit_price(bu.id, b.id, sb.branch_id, 'retail'), 0), 1)::bigint
  from stock_balances sb
  join batches b on b.id = sb.batch_id
  join products p on p.id = sb.product_id
  join product_units bu on bu.product_id = p.id and bu.unit_id = p.base_unit_id and bu.archived_at is null
  where sb.tenant_id = app.tenant_id() and sb.branch_id = any (p_branches) and sb.qty_base > 0
$$;

create or replace function public.report_stock_valuation(p_branch uuid default null)
returns table (product_id uuid, product text, qty_base bigint, cost_value bigint, retail_value bigint, cost_unknown boolean)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare b uuid[] := app.report_branches('reports.stock_value', p_branch);
begin
  return query
  select v.product_id, pr.brand_name, sum(v.qty_base)::bigint, coalesce(sum(v.cost_value), 0)::bigint, sum(v.retail_value)::bigint,
         bool_or(v.cost_value is null)
  from app.stock_values(b) v join products pr on pr.id = v.product_id
  group by v.product_id, pr.brand_name order by 4 desc;
end $$;

-- Stock that has not sold for p_days (default 90), with its value at cost.
create or replace function public.report_dead_stock(p_days int default 90, p_branch uuid default null)
returns table (product_id uuid, product text, batch_number text, expiry_date date, qty_base bigint, cost_value bigint, last_sold_at timestamptz)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare b uuid[] := app.report_branches('reports.stock_value', p_branch);
begin
  return query
  select v.product_id, pr.brand_name, bt.batch_number, v.expiry_date, v.qty_base, v.cost_value, ls.at
  from app.stock_values(b) v
  join products pr on pr.id = v.product_id
  join batches bt on bt.id = v.batch_id
  left join lateral (select max(m.occurred_at) at from stock_movements m where m.product_id = v.product_id and m.branch_id = v.branch_id
                     and m.movement_type = 'sale') ls on true
  where ls.at is null or ls.at < now() - make_interval(days => p_days)
  order by v.cost_value desc nulls last;
end $$;

-- ---- Sales and profit ------------------------------------------------------------------------
-- p_group: day | hour | product | category | manufacturer | staff | branch | bill
create or replace function app.fact_key(p_group text, f record) returns text
language plpgsql stable as $$
begin
  return case p_group
    when 'day' then f.business_date::text
    when 'hour' then lpad(extract(hour from f.at at time zone 'Asia/Karachi')::text, 2, '0') || ':00'
    when 'product' then f.product_id::text
    when 'category' then coalesce(f.category_id::text, '-')
    when 'manufacturer' then coalesce(f.manufacturer_id::text, '-')
    when 'staff' then f.staff_id::text
    when 'branch' then f.branch_id::text
    when 'bill' then f.sale_id::text
    else null end;
end $$;

create or replace function app.key_label(p_group text, p_key text) returns text
language sql stable security definer set search_path = public, app as $$
  select case p_group
    when 'product' then (select brand_name from products where id = p_key::uuid)
    when 'category' then coalesce((select name from categories where id = nullif(p_key, '-')::uuid), 'No category')
    when 'manufacturer' then coalesce((select name from manufacturers where id = nullif(p_key, '-')::uuid), 'No company')
    when 'staff' then (select full_name from users where id = p_key::uuid)
    when 'branch' then (select name from branches where id = p_key::uuid)
    when 'bill' then (select invoice_number from sales where id = p_key::uuid)
    else p_key end
$$;

create or replace function public.report_sales(p_from date, p_to date, p_group text default 'day', p_branch uuid default null)
returns table (key text, label text, bills bigint, qty_base bigint, sales bigint, discounts bigint, tax bigint, returns bigint)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare b uuid[] := app.report_branches('reports.sales', p_branch);
begin
  if p_group not in ('day', 'hour', 'product', 'category', 'manufacturer', 'staff', 'branch', 'bill') then
    raise exception 'Unknown grouping %', p_group using errcode = '22023';
  end if;
  return query
  select k.key, app.key_label(p_group, k.key), count(distinct f.sale_id) filter (where f.kind = 'sale'),
         sum(f.qty_base)::bigint, sum(f.gross)::bigint, sum(f.discount)::bigint, sum(f.tax)::bigint,
         coalesce(-sum(f.gross) filter (where f.kind = 'return'), 0)::bigint
  from app.sale_facts(p_from, p_to, b) f
  cross join lateral (select app.fact_key(p_group, f) as key) k
  group by k.key order by 5 desc;
end $$;

-- Sales by how they were paid (cash, card, wallets) and how much went on udhaar.
create or replace function public.report_payments(p_from date, p_to date, p_branch uuid default null)
returns table (method text, bills bigint, amount bigint)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare b uuid[] := app.report_branches('reports.sales', p_branch);
begin
  return query
  select sp.method, count(distinct s.id), sum(sp.amount)::bigint
  from sales s join sale_payments sp on sp.sale_id = s.id
  where s.tenant_id = app.tenant_id() and s.status = 'completed' and s.branch_id = any (b) and s.business_date between p_from and p_to
  group by sp.method
  union all
  select 'udhaar', count(*), coalesce(sum(s.udhaar_amount), 0)::bigint
  from sales s
  where s.tenant_id = app.tenant_id() and s.status = 'completed' and s.branch_id = any (b) and s.business_date between p_from and p_to
    and s.udhaar_amount > 0
  order by 3 desc;
end $$;

create or replace function public.report_profit(p_from date, p_to date, p_group text default 'product', p_branch uuid default null)
returns table (key text, label text, revenue bigint, cogs bigint, gross_profit bigint, margin_bp bigint, lines_cost_pending bigint)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare b uuid[] := app.report_branches('reports.profit', p_branch);
begin
  perform app.require_perm('sales.view_profit');
  if p_group not in ('day', 'product', 'category', 'manufacturer', 'staff', 'branch', 'bill') then
    raise exception 'Unknown grouping %', p_group using errcode = '22023';
  end if;
  return query
  select k.key, app.key_label(p_group, k.key), sum(f.revenue)::bigint, coalesce(sum(f.cogs), 0)::bigint,
         (sum(f.revenue) - coalesce(sum(f.cogs), 0))::bigint,
         case when sum(f.revenue) > 0 then app.div_round((sum(f.revenue) - coalesce(sum(f.cogs), 0)) * 10000, sum(f.revenue))::bigint end,
         count(*) filter (where f.cogs is null)
  from app.sale_facts(p_from, p_to, b) f
  cross join lateral (select app.fact_key(p_group, f) as key) k
  group by k.key order by 5 desc;
end $$;

-- Profit and loss: what was sold, what it cost, what the pharmacy spent.
create or replace function public.report_profit_and_loss(p_from date, p_to date, p_branch uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  b uuid[] := app.report_branches('reports.profit', p_branch);
  f record;
  exp jsonb;
  exp_total bigint;
  sal bigint;
begin
  perform app.require_perm('sales.view_profit');
  select coalesce(sum(revenue) filter (where kind = 'sale'), 0) sales_rev, coalesce(-sum(revenue) filter (where kind = 'return'), 0) ret_rev,
         coalesce(sum(cogs), 0) cogs, count(*) filter (where cogs is null) pending
  into f from app.sale_facts(p_from, p_to, b);
  select coalesce(jsonb_agg(jsonb_build_object('category', x.name, 'amount', x.amount) order by x.amount desc), '[]'),
         coalesce(sum(x.amount), 0)
  into exp, exp_total
  from (select c.name, sum(e.amount)::bigint amount from expenses e join expense_categories c on c.id = e.category_id
        where e.tenant_id = app.tenant_id() and e.status = 'posted' and e.branch_id = any (b) and e.expense_date between p_from and p_to
        group by c.name) x;
  -- Salaries are not per branch; they count when looking at the whole pharmacy.
  select coalesce(sum(gross_amount), 0) into sal from salaries
  where tenant_id = app.tenant_id() and status = 'paid' and p_branch is null
    and period_month between date_trunc('month', p_from)::date and p_to;
  return jsonb_build_object('from', p_from, 'to', p_to,
    'sales', f.sales_rev, 'returns', f.ret_rev, 'net_sales', f.sales_rev - f.ret_rev, 'cost_of_goods', f.cogs,
    'gross_profit', f.sales_rev - f.ret_rev - f.cogs, 'expenses', exp, 'expenses_total', exp_total, 'salaries', sal,
    'net_profit', f.sales_rev - f.ret_rev - f.cogs - exp_total - sal, 'lines_cost_pending', f.pending);
end $$;

-- ---- Purchases -------------------------------------------------------------------------------
create or replace function public.report_purchases(p_from date, p_to date, p_group text default 'supplier', p_branch uuid default null)
returns table (key text, label text, deliveries bigint, qty_base bigint, bonus_qty_base bigint, gross bigint, discounts bigint,
               tax bigint, net bigint, bonus_value bigint)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare b uuid[] := app.report_branches('reports.purchases', p_branch);
begin
  perform app.require_perm('purchases.view_cost');
  if p_group not in ('supplier', 'product') then raise exception 'Unknown grouping %', p_group using errcode = '22023'; end if;
  return query
  select case p_group when 'supplier' then g.supplier_id else gl.product_id end::text,
         case p_group when 'supplier' then (select name from suppliers where id = g.supplier_id)
                      else (select brand_name from products where id = gl.product_id) end,
         count(distinct g.id), sum(gl.qty_base)::bigint, sum(gl.bonus_qty_base)::bigint, coalesce(sum(gl.qty * c.unit_cost), 0)::bigint,
         coalesce(sum(c.discount_amount + c.scheme_discount), 0)::bigint, coalesce(sum(c.tax_amount), 0)::bigint,
         coalesce(sum(c.line_net), 0)::bigint, coalesce(sum(gl.bonus_qty * c.unit_cost), 0)::bigint
  from grns g join grn_lines gl on gl.grn_id = g.id left join grn_line_costs c on c.grn_line_id = gl.id
  where g.tenant_id = app.tenant_id() and g.status = 'posted' and g.branch_id = any (b)
    and app.business_date(g.branch_id, g.received_at) between p_from and p_to
  group by 1, 2 order by 9 desc;
end $$;

-- ---- Udhaar collections -----------------------------------------------------------------------
create or replace function public.report_collections(p_from date, p_to date)
returns table (entry_date date, method text, payments bigint, amount bigint)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_perm('reports.udhaar');
  perform app.require_perm('udhaar.view_balance');
  return query
  select e.entry_date, e.payment_method, count(*), sum(e.credit)::bigint
  from ledger_entries e
  where e.tenant_id = app.tenant_id() and e.party_type = 'customer_account' and e.entry_type = 'payment'
    and e.entry_date between p_from and p_to
    and not exists (select 1 from ledger_entries r where r.reverses_entry_id = e.id)
  group by 1, 2 order by 1, 2;
end $$;

-- ---- Staff ------------------------------------------------------------------------------------
create or replace function public.report_staff(p_from date, p_to date, p_branch uuid default null)
returns table (user_id uuid, name text, bills bigint, sales bigint, discounts bigint, voids bigint, returns bigint,
               cash_short_over bigint, hours_signed_in numeric)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
declare b uuid[] := app.report_branches('reports.staff', p_branch);
begin
  return query
  with f as (select * from app.sale_facts(p_from, p_to, b))
  select u.id, u.full_name,
         (select count(distinct f.sale_id) from f where f.staff_id = u.id and f.kind = 'sale'),
         (select coalesce(sum(f.gross), 0) from f where f.staff_id = u.id)::bigint,
         (select coalesce(sum(f.discount), 0) from f where f.staff_id = u.id)::bigint,
         (select count(*) from sales s where s.voided_by = u.id and s.branch_id = any (b)
            and app.business_date(s.branch_id, s.voided_at) between p_from and p_to),
         (select count(distinct f.invoice_number) from f where f.staff_id = u.id and f.kind = 'return'),
         case when app.has_perm('cash.view_variance') then
           (select coalesce(sum(r.variance), 0) from drawer_session_reconciliations r join drawer_sessions ds on ds.id = r.drawer_session_id
            where coalesce(ds.closed_by, ds.opened_by) = u.id and ds.branch_id = any (b)
              and app.business_date(ds.branch_id, ds.closed_at) between p_from and p_to)::bigint end,
         (select round(coalesce(sum(extract(epoch from (coalesce(us.ended_at, us.last_active_at) - us.started_at))), 0) / 3600.0, 1)
          from user_sessions us where us.user_id = u.id and us.branch_id = any (b)
            and app.business_date(us.branch_id, us.started_at) between p_from and p_to)
  from users u
  where u.tenant_id = app.tenant_id() and u.archived_at is null
  order by 4 desc;
end $$;

-- What staff did, newest first: sales, discounts, voids, returns, drawer and sign-in events.
create or replace function public.activity_feed(p_since timestamptz default now() - interval '1 day', p_limit int default 200)
returns table (at timestamptz, who text, branch text, action text, details jsonb)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_perm('reports.staff');
  return query
  select a.occurred_at, u.full_name, br.name, a.action, coalesce(a.context, '{}')
  from audit_log a
  left join users u on u.id = a.user_id
  left join branches br on br.id = a.branch_id
  where a.tenant_id = app.tenant_id() and a.occurred_at >= p_since
    and (a.branch_id is null or a.branch_id = any (app.branches_with('reports.staff')))
  order by a.occurred_at desc
  limit least(coalesce(p_limit, 200), 1000);
end $$;

-- ---- Trial balance --------------------------------------------------------------------------
-- The accountant's view, built from the books underneath (cash and bank movements, stock at cost,
-- udhaar and supplier ledgers, sales, tax, expenses, salaries). Owner's capital and opening
-- balances is what makes it balance: the money and stock the owner put in (D44).
create or replace function public.trial_balance(p_as_of date default current_date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  tid uuid := app.tenant_id();
  b uuid[];
  lines jsonb;
  cash bigint; bank bigint; stock bigint; recv bigint; pay bigint; claims bigint;
  sales bigint; tax bigint; cogs bigint; exp bigint; sal bigint; adv bigint; writeoff bigint;
  tot_debit bigint; tot_credit bigint;
begin
  perform app.require_perm('reports.profit');
  perform app.require_perm('sales.view_profit');
  b := array(select id from branches where tenant_id = tid);
  select coalesce(sum(m.amount) filter (where m.drawer_session_id is not null), 0),
         coalesce(sum(m.amount) filter (where m.bank_account_id is not null), 0)
  into cash, bank from cash_movements m where m.tenant_id = tid and m.occurred_at < p_as_of + 1;
  select coalesce(sum(v.cost_value), 0) into stock from app.stock_values(b) v;
  select coalesce(sum(case when party_type = 'customer_account' then debit - credit else 0 end), 0),
         coalesce(sum(case when party_type = 'supplier' then credit - debit else 0 end), 0)
  into recv, pay from ledger_entries where tenant_id = tid and entry_date <= p_as_of;
  -- Cheques received but not cleared sit between the khata and the bank.
  recv := recv + coalesce((select sum(amount) from cheques where tenant_id = tid and direction = 'received'
                           and status in ('pending', 'deposited')), 0);
  pay := pay + coalesce((select sum(amount) from cheques where tenant_id = tid and direction = 'issued'
                         and status in ('pending', 'deposited')), 0);
  select coalesce(sum(claimed_amount - settled_amount) filter (where status in ('open', 'partially_settled') and settled_amount = 0), 0)
  into claims from supplier_claims where tenant_id = tid;
  select coalesce(sum(f.revenue), 0), coalesce(sum(f.tax), 0), coalesce(sum(f.cogs), 0)
  into sales, tax, cogs from app.sale_facts('2000-01-01', p_as_of, b) f;
  select coalesce(sum(amount), 0) into exp from expenses where tenant_id = tid and status = 'posted' and expense_date <= p_as_of;
  select coalesce(sum(gross_amount - advance_recovery), 0) into sal from salaries where tenant_id = tid and status = 'paid'
    and period_month <= p_as_of;
  select coalesce(sum(a.amount), 0) - coalesce((select sum(r.amount) from salary_advance_recoveries r
                                                join salaries s on s.id = r.salary_id and s.status = 'paid'
                                                where r.tenant_id = tid), 0)
  into adv from staff_advances a where a.tenant_id = tid and a.status <> 'written_off' and a.given_on <= p_as_of;
  select coalesce(sum(credit), 0) into writeoff from ledger_entries where tenant_id = tid and party_type = 'customer_account'
    and entry_type = 'write_off' and entry_date <= p_as_of;
  lines := jsonb_build_array(
    jsonb_build_object('account', 'Cash in drawers', 'type', 'asset', 'debit', greatest(cash, 0), 'credit', greatest(-cash, 0)),
    jsonb_build_object('account', 'Bank and wallets', 'type', 'asset', 'debit', greatest(bank, 0), 'credit', greatest(-bank, 0)),
    jsonb_build_object('account', 'Stock (at cost)', 'type', 'asset', 'debit', stock, 'credit', 0),
    jsonb_build_object('account', 'Udhaar receivable', 'type', 'asset', 'debit', greatest(recv, 0), 'credit', greatest(-recv, 0)),
    jsonb_build_object('account', 'Supplier claims', 'type', 'asset', 'debit', claims, 'credit', 0),
    jsonb_build_object('account', 'Staff advances', 'type', 'asset', 'debit', greatest(adv, 0), 'credit', 0),
    jsonb_build_object('account', 'Supplier payable', 'type', 'liability', 'debit', greatest(-pay, 0), 'credit', greatest(pay, 0)),
    jsonb_build_object('account', 'Sales tax payable', 'type', 'liability', 'debit', 0, 'credit', tax),
    jsonb_build_object('account', 'Sales', 'type', 'income', 'debit', 0, 'credit', sales),
    jsonb_build_object('account', 'Cost of goods sold', 'type', 'expense', 'debit', cogs, 'credit', 0),
    jsonb_build_object('account', 'Expenses', 'type', 'expense', 'debit', exp, 'credit', 0),
    jsonb_build_object('account', 'Salaries', 'type', 'expense', 'debit', sal, 'credit', 0),
    jsonb_build_object('account', 'Udhaar written off', 'type', 'expense', 'debit', writeoff, 'credit', 0));
  select sum((x ->> 'debit')::bigint), sum((x ->> 'credit')::bigint) into tot_debit, tot_credit from jsonb_array_elements(lines) x;
  lines := lines || jsonb_build_object('account', 'Owner''s capital and opening balances', 'type', 'equity',
                                       'debit', greatest(tot_credit - tot_debit, 0), 'credit', greatest(tot_debit - tot_credit, 0));
  return jsonb_build_object('as_of', p_as_of, 'lines', lines, 'total', greatest(tot_debit, tot_credit));
end $$;

-- ---- Grants ---------------------------------------------------------------------------------
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
grant execute on function
  public.owner_dashboard(date, uuid), public.report_stock_valuation(uuid), public.report_dead_stock(int, uuid),
  public.report_sales(date, date, text, uuid), public.report_payments(date, date, uuid),
  public.report_profit(date, date, text, uuid), public.report_profit_and_loss(date, date, uuid),
  public.report_purchases(date, date, text, uuid), public.report_collections(date, date),
  public.report_staff(date, date, uuid), public.activity_feed(timestamptz, int), public.trial_balance(date),
  public.get_receipt(uuid), app.receipt_data(uuid)
  to authenticated;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;
select app.assert_rls_everywhere();
