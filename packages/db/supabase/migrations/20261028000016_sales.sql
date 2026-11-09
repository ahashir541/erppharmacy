-- 0016 (Phase 3): the counter sale — bill maths, prices, FEFO checks,
-- payments, udhaar, drawers, voids, returns, receipts.
--
-- app.record_sale / app.record_return serve both paths:
--   'online'  (public.post_sale, counter connected): any problem rejects.
--   'offline' (Phase 4 upload of a sale made without internet): the medicine
--             has already left the shop, so problems become sync_flags for
--             the owner instead of rejecting (brief, sync rule 5).

-- ---- Bill maths (same as packages/core/src/bill.ts) ------------------------
-- round(numeric) rounds half away from zero, like divRoundHalfUp in core.
create or replace function app.div_round(n numeric, d numeric) returns bigint
language sql immutable as $$ select round(n / d)::bigint $$;

-- p_lines: [{qty, unit_price, line_discount, tax_rate_bp}]
create or replace function app.price_bill(p_lines jsonb, p_bill_discount bigint, p_inclusive boolean, p_step bigint)
returns jsonb
language plpgsql immutable as $$
declare
  n int := jsonb_array_length(p_lines);
  gross bigint[] := '{}';
  after bigint[] := '{}';
  share bigint[] := '{}';
  ord int[];
  base bigint := 0;
  left_over bigint;
  q bigint; up bigint; d bigint; r int;
  i int;
  out_lines jsonb := '[]';
  net bigint; tax bigint; lt bigint;
  sum_lines bigint := 0; sum_disc bigint := 0; sum_tax bigint := 0; sum_gross bigint := 0;
  grand bigint;
begin
  if coalesce(p_bill_discount, 0) < 0 then
    raise exception 'bill discount cannot be negative' using errcode = '22023';
  end if;
  for i in 1 .. n loop
    q := (p_lines -> (i - 1) ->> 'qty')::bigint;
    up := (p_lines -> (i - 1) ->> 'unit_price')::bigint;
    d := coalesce((p_lines -> (i - 1) ->> 'line_discount')::bigint, 0);
    if q is null or q <= 0 then raise exception 'quantity must be a whole number above 0' using errcode = '22023'; end if;
    if up is null or up < 0 then raise exception 'unit price cannot be negative' using errcode = '22023'; end if;
    if d < 0 or d > q * up then
      raise exception 'line discount must be between 0 and the line amount' using errcode = '22023';
    end if;
    gross[i] := q * up;
    after[i] := q * up - d;
    base := base + after[i];
  end loop;
  if coalesce(p_bill_discount, 0) > base then
    raise exception 'bill discount is more than the bill' using errcode = '22023';
  end if;
  for i in 1 .. n loop
    share[i] := case when base = 0 then 0 else floor(coalesce(p_bill_discount, 0)::numeric * after[i] / base)::bigint end;
  end loop;
  left_over := coalesce(p_bill_discount, 0) - coalesce((select sum(s) from unnest(share) s), 0);
  select array_agg(o::int order by a desc, o) into ord from unnest(after) with ordinality as u(a, o);
  while left_over > 0 loop
    foreach i in array ord loop
      exit when left_over = 0;
      if share[i] < after[i] then
        share[i] := share[i] + 1;
        left_over := left_over - 1;
      end if;
    end loop;
  end loop;
  for i in 1 .. n loop
    r := coalesce((p_lines -> (i - 1) ->> 'tax_rate_bp')::int, 0);
    if r < 0 or r > 10000 then raise exception 'tax rate out of range' using errcode = '22023'; end if;
    d := coalesce((p_lines -> (i - 1) ->> 'line_discount')::bigint, 0) + share[i];
    net := gross[i] - d;
    tax := case when p_inclusive then app.div_round(net::numeric * r, 10000 + r)
                else app.div_round(net::numeric * r, 10000) end;
    lt := case when p_inclusive then net else net + tax end;
    out_lines := out_lines || jsonb_build_object('gross', gross[i], 'discount', d, 'net', net, 'tax', tax, 'line_total', lt);
    sum_lines := sum_lines + lt;
    sum_disc := sum_disc + d;
    sum_tax := sum_tax + tax;
    sum_gross := sum_gross + gross[i];
  end loop;
  grand := case when coalesce(p_step, 0) <= 1 then sum_lines else app.div_round(sum_lines, p_step) * p_step end;
  return jsonb_build_object(
    'lines', out_lines,
    'gross_total', sum_gross,
    'subtotal', grand - (grand - sum_lines) + sum_disc - sum_tax,
    'discount_total', sum_disc,
    'discount_bp', case when sum_gross = 0 then 0 else app.div_round(sum_disc::numeric * 10000, sum_gross) end,
    'tax_total', sum_tax,
    'rounding', grand - sum_lines,
    'grand_total', grand);
end $$;

-- p_payments: [{method, amount}] for card/wallets, [{method:'cash', tendered}]
create or replace function app.settle_payments(p_grand bigint, p_payments jsonb) returns jsonb
language plpgsql immutable as $$
declare
  p jsonb;
  non_cash bigint := 0;
  tendered bigint := 0;
  n_cash int := 0;
  out_payments jsonb := '[]';
  due bigint;
  applied bigint;
begin
  for p in select * from jsonb_array_elements(coalesce(p_payments, '[]')) loop
    if p ->> 'method' = 'cash' then
      n_cash := n_cash + 1;
      tendered := coalesce((p ->> 'tendered')::bigint, 0);
      if tendered < 0 then raise exception 'cash cannot be negative' using errcode = '22023'; end if;
    elsif p ->> 'method' in ('card', 'jazzcash', 'easypaisa', 'bank_transfer', 'loyalty') then
      if (p ->> 'amount')::bigint is null or (p ->> 'amount')::bigint <= 0 then
        raise exception '% amount must be above 0', p ->> 'method' using errcode = '22023';
      end if;
      non_cash := non_cash + (p ->> 'amount')::bigint;
      out_payments := out_payments || jsonb_build_object('method', p ->> 'method', 'amount', (p ->> 'amount')::bigint,
                                                         'tendered', null, 'reference', p ->> 'reference',
                                                         'bank_account_id', p ->> 'bank_account_id');
    else
      raise exception 'unknown payment method %', p ->> 'method' using errcode = '22023';
    end if;
  end loop;
  if n_cash > 1 then raise exception 'one cash payment per bill' using errcode = '22023'; end if;
  if non_cash > p_grand then
    raise exception 'card / wallet payments are more than the bill' using errcode = '22023';
  end if;
  due := p_grand - non_cash;
  applied := least(tendered, due);
  if applied > 0 then
    out_payments := out_payments || jsonb_build_object('method', 'cash', 'amount', applied, 'tendered', tendered);
  end if;
  return jsonb_build_object('payments', out_payments, 'paid_total', non_cash + applied, 'cash_applied', applied,
                            'change', tendered - applied, 'udhaar', due - applied);
end $$;

-- ---- Prices, tax, settings --------------------------------------------------
create or replace function app.setting(p_tenant uuid, p_branch uuid, p_key text) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select value from settings
  where tenant_id = p_tenant and key = p_key and (branch_id = p_branch or branch_id is null)
  order by branch_id nulls last limit 1
$$;

-- Price of one product unit: the batch's own printed price wins (D18), then
-- the branch / all-branch price list. A price set for another pack size is
-- converted (pack price x factor ratio, rounded half-up, D17).
create or replace function app.unit_price(p_product_unit uuid, p_batch uuid, p_branch uuid, p_kind text)
returns bigint
language sql stable security definer set search_path = public, app as $$
  with pu as (select * from product_units where id = p_product_unit),
  batch_price as (
    select app.div_round(b.retail_price::numeric * pu.factor_to_base, bu.factor_to_base) as amount
    from batches b
    join product_units bu on bu.id = b.price_unit_id
    cross join pu
    where p_kind = 'retail' and b.id = p_batch and b.retail_price is not null
  ),
  list_price as (
    select app.div_round(pp.amount::numeric * pu.factor_to_base, x.factor_to_base) as amount
    from product_prices pp
    join product_units x on x.id = pp.product_unit_id
    cross join pu
    where pp.product_id = pu.product_id and pp.price_kind = p_kind
      and (pp.branch_id = p_branch or pp.branch_id is null) and pp.effective_from <= clock_timestamp()
    order by (pp.product_unit_id = pu.id) desc, pp.branch_id nulls last, pp.effective_from desc, pp.created_at desc, pp.id desc
    limit 1
  )
  select coalesce((select amount from batch_price), (select amount from list_price))
$$;

-- Sales tax rate (bp) for a product on a date: its tax category, else its
-- category's; exempt or unset = 0. Goods tax is federal (FBR) in Phase 3;
-- Phase 7 adds provincial rules.
create or replace function app.tax_rate_bp(p_product uuid, p_date date) returns int
language sql stable security definer set search_path = public, app as $$
  select coalesce((
    select case when tc.is_exempt then 0 else r.rate_bp end
    from products p
    left join categories c on c.id = p.category_id
    join tax_categories tc on tc.id = coalesce(p.tax_category_id, c.tax_category_id)
    left join lateral (
      select rate_bp from tax_category_rates
      where tax_category_id = tc.id and authority = 'FBR' and effective_from <= p_date
      order by effective_from desc limit 1) r on true
    where p.id = p_product), 0)
$$;

-- Weighted average cost within the batch (D14) for qty_base units.
create or replace function app.batch_cogs(p_batch uuid, p_qty_base bigint) returns bigint
language sql stable security definer set search_path = public, app as $$
  select case when sum(qty_base) > 0 then app.div_round(p_qty_base::numeric * sum(total_cost), sum(qty_base)) end
  from batch_cost_layers where batch_id = p_batch
$$;

-- ---- Problems: reject online, flag offline ---------------------------------
create or replace function app.problem(p_mode text, p_kind text, p_message text, p_details jsonb default '{}')
returns jsonb
language plpgsql immutable as $$
begin
  if p_mode = 'online' then
    raise exception '%', p_message using errcode = 'P0001', hint = p_kind;
  end if;
  return jsonb_build_array(jsonb_build_object('kind', p_kind, 'message', p_message, 'details', p_details));
end $$;

create or replace function app.decision_or_flag(p_mode text, p_user uuid, p_code text, p_branch uuid, p_amount bigint,
                                                p_approval uuid, p_kind text, p_reference uuid)
returns jsonb
language plpgsql security definer set search_path = public, app as $$
begin
  if p_mode = 'online' then
    perform app.require_decision(p_user, p_code, p_branch, p_amount, p_approval, p_kind, p_reference);
    return '[]';
  end if;
  begin
    perform app.require_decision(p_user, p_code, p_branch, p_amount, p_approval, p_kind, p_reference);
    return '[]';
  exception when others then
    return app.problem('offline', 'permission_exceeded', sqlerrm,
                       jsonb_build_object('permission', p_code, 'amount', p_amount));
  end;
end $$;

-- ---- Recording a sale ----------------------------------------------------------
-- p_sale (built by the counter app with packages/core):
--   id, local_seq, sold_at, device_id (owner selling on a PC), customer_id,
--   customer_account_id, doctor_id, prescription_id, bill_discount,
--   grand_total (as printed), drawer_session_id,
--   lines [{id, product_unit_id, batch_id, qty, unit_price, line_discount}],
--   payments [{method, amount | tendered, reference, bank_account_id}],
--   approvals {discount, price, negative_stock, udhaar, below_min}
create or replace function app.record_sale(p_sale jsonb, p_actor uuid, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  tid uuid := app.tenant_id();
  sid uuid := (p_sale ->> 'id')::uuid;
  seq bigint := (p_sale ->> 'local_seq')::bigint;
  dev devices;
  br branches;
  tz text;
  sold timestamptz := coalesce((p_sale ->> 'sold_at')::timestamptz, now());
  bdate date;
  existing sales;
  flags jsonb := '[]';
  approvals jsonb := coalesce(p_sale -> 'approvals', '{}');
  l jsonb;
  pu product_units;
  prod products;
  b batches;
  qty_base bigint;
  list bigint;
  min_price bigint;
  bal bigint;
  used_before bigint;
  rx prescriptions;
  priced jsonb := '[]';
  line_meta jsonb := '[]';
  bill jsonb;
  settle jsonb;
  acct customer_accounts;
  credit customer_credit_status;
  udhaar bigint;
  drawer drawer_sessions;
  i int := 0;
  lid uuid;
  bl jsonb;
  pay jsonb;
  due_days int;
  invoice text;
  inclusive boolean;
  step bigint;
  cogs bigint;
  tax_on boolean;
begin
  if sid is null or seq is null or seq <= 0 then
    raise exception 'Sale id and local_seq are required' using errcode = '22023';
  end if;
  select * into existing from sales where id = sid;
  if found then
    if existing.tenant_id <> tid then raise exception 'Sale id clash' using errcode = 'P0001'; end if;
    return jsonb_build_object('sale_id', existing.id, 'invoice_number', existing.invoice_number,
                              'grand_total', existing.grand_total, 'duplicate', true, 'flags', '[]'::jsonb);
  end if;

  select * into dev from devices
  where id = coalesce(app.current_device_id(), (p_sale ->> 'device_id')::uuid) and tenant_id = tid
    and kind = 'counter' and status = 'active';
  if not found then raise exception 'Sales are made on a registered counter PC' using errcode = '42501'; end if;
  select * into br from branches where id = dev.branch_id;
  tz := coalesce(br.time_zone, (select time_zone from tenants where id = tid));
  bdate := (sold at time zone tz)::date;
  invoice := dev.invoice_prefix || '-' || lpad(seq::text, 6, '0');
  if exists (select 1 from sales where device_id = dev.id and local_seq = seq) then
    raise exception 'Invoice number % is already used on this PC', invoice using errcode = 'P0001';
  end if;
  perform set_config('app.device_id', dev.id::text, true);
  -- Offline, the sale already happened: a person no longer allowed to sell is flagged, not lost.
  flags := flags || app.decision_or_flag(p_mode, p_actor, 'sales.create', br.id, null, null, 'other', sid);
  inclusive := coalesce((app.setting(tid, br.id, 'tax.prices_include_tax') #>> '{}')::boolean, true);
  step := coalesce((app.setting(tid, br.id, 'pos.bill_rounding_minor') #>> '{}')::bigint, 100);

  if jsonb_array_length(coalesce(p_sale -> 'lines', '[]')) = 0 then
    raise exception 'A bill needs at least one item' using errcode = '22023';
  end if;
  if (p_sale ->> 'prescription_id') is not null then
    select * into rx from prescriptions where id = (p_sale ->> 'prescription_id')::uuid and tenant_id = tid;
    if not found then raise exception 'Prescription not found' using errcode = 'P0002'; end if;
  end if;

  -- lines: price, batch, stock and drug-rule checks
  for l in select * from jsonb_array_elements(p_sale -> 'lines') loop
    select * into pu from product_units where id = (l ->> 'product_unit_id')::uuid and tenant_id = tid;
    if not found then raise exception 'Unknown item on the bill' using errcode = 'P0002'; end if;
    select * into prod from products where id = pu.product_id;
    select * into b from batches where id = (l ->> 'batch_id')::uuid and tenant_id = tid and product_id = prod.id;
    if not found then raise exception 'Batch does not belong to %', prod.brand_name using errcode = '22023'; end if;
    qty_base := (l ->> 'qty')::bigint * pu.factor_to_base;

    list := app.unit_price(pu.id, b.id, br.id, 'retail');
    if list is null or (l ->> 'unit_price')::bigint <> list then
      flags := flags || app.decision_or_flag(p_mode, p_actor, 'sales.edit_price', br.id, null,
                                             (approvals ->> 'price')::uuid, 'price_change', sid);
    end if;
    min_price := app.unit_price(pu.id, b.id, br.id, 'min_sale');
    if min_price is not null and (l ->> 'unit_price')::bigint < min_price then
      flags := flags || app.decision_or_flag(p_mode, p_actor, 'sales.sell_below_min', br.id, null,
                                             (approvals ->> 'below_min')::uuid, 'price_change', sid);
      if p_mode = 'offline' then
        flags := flags || app.problem(p_mode, 'below_min_price', prod.brand_name || ' sold below minimum price',
                                      jsonb_build_object('product_id', prod.id, 'price', l ->> 'unit_price', 'min', min_price));
      end if;
    end if;
    if b.expiry_date < bdate then
      flags := flags || app.problem(p_mode, 'expired_batch', prod.brand_name || ' batch ' || b.batch_number || ' is expired',
                                    jsonb_build_object('batch_id', b.id));
    end if;
    if exists (select 1 from batch_blocks bb where bb.batch_id = b.id and bb.lifted_at is null
               and (bb.branch_id is null or bb.branch_id = br.id)) then
      flags := flags || app.problem(p_mode, 'blocked_batch', prod.brand_name || ' batch ' || b.batch_number || ' is blocked',
                                    jsonb_build_object('batch_id', b.id));
    end if;
    select coalesce(sb.qty_base, 0) into bal from stock_balances sb where sb.branch_id = br.id and sb.batch_id = b.id;
    used_before := coalesce((select sum((x ->> 'qty_base')::bigint) from jsonb_array_elements(line_meta) x
                             where x ->> 'batch_id' = b.id::text), 0);
    if coalesce(bal, 0) - used_before < qty_base then
      if p_mode = 'online' then
        perform app.require_decision(p_actor, 'sales.negative_stock', br.id, null,
                                     (approvals ->> 'negative_stock')::uuid, 'negative_stock', sid);
      else
        flags := flags || app.problem(p_mode, 'negative_stock', prod.brand_name || ' sold beyond recorded stock',
                                      jsonb_build_object('batch_id', b.id, 'in_stock', coalesce(bal, 0) - used_before,
                                                         'sold', qty_base));
      end if;
    end if;
    if (prod.rx_required or prod.is_controlled) and rx.id is null then
      flags := flags || app.problem(p_mode, 'controlled_without_prescription',
                                    prod.brand_name || ' needs a prescription', jsonb_build_object('product_id', prod.id));
    end if;
    if prod.is_controlled and rx.id is not null and rx.pharmacist_confirmed_by is null then
      flags := flags || app.problem(p_mode, 'controlled_without_prescription',
                                    prod.brand_name || ' needs the pharmacist''s confirmation', jsonb_build_object('product_id', prod.id));
    end if;
    if prod.max_qty_per_sale is not null and qty_base > prod.max_qty_per_sale then
      flags := flags || app.problem(p_mode, 'permission_exceeded',
                                    prod.brand_name || ': at most ' || prod.max_qty_per_sale || ' per sale',
                                    jsonb_build_object('product_id', prod.id, 'qty_base', qty_base));
    end if;

    priced := priced || jsonb_build_object('qty', (l ->> 'qty')::bigint, 'unit_price', (l ->> 'unit_price')::bigint,
                                           'line_discount', coalesce((l ->> 'line_discount')::bigint, 0),
                                           'tax_rate_bp', app.tax_rate_bp(prod.id, bdate));
    line_meta := line_meta || jsonb_build_object('id', coalesce(l ->> 'id', app.uuid_v7()::text), 'product_id', prod.id,
                                                 'product_unit_id', pu.id, 'batch_id', b.id, 'qty_base', qty_base,
                                                 'list_unit_price', coalesce(list, (l ->> 'unit_price')::bigint),
                                                 'tax_category_id', coalesce(prod.tax_category_id,
                                                    (select tax_category_id from categories where id = prod.category_id)));
  end loop;

  bill := app.price_bill(priced, coalesce((p_sale ->> 'bill_discount')::bigint, 0), inclusive, step);
  if (p_sale ->> 'grand_total') is not null and (p_sale ->> 'grand_total')::bigint <> (bill ->> 'grand_total')::bigint then
    flags := flags || app.problem(p_mode, 'total_mismatch',
                                  'Bill total differs: counter ' || (p_sale ->> 'grand_total') || ', server ' || (bill ->> 'grand_total'),
                                  jsonb_build_object('counter', p_sale ->> 'grand_total', 'server', bill ->> 'grand_total'));
  end if;
  if (bill ->> 'discount_total')::bigint > 0 then
    flags := flags || app.decision_or_flag(p_mode, p_actor, 'sales.discount', br.id, (bill ->> 'discount_bp')::bigint,
                                           (approvals ->> 'discount')::uuid, 'discount', sid);
  end if;

  -- payments and udhaar
  settle := app.settle_payments((bill ->> 'grand_total')::bigint, p_sale -> 'payments');
  udhaar := (settle ->> 'udhaar')::bigint;
  if udhaar > 0 then
    select * into acct from customer_accounts
    where tenant_id = tid and archived_at is null
      and id = coalesce((p_sale ->> 'customer_account_id')::uuid,
                        (select account_id from customers where id = (p_sale ->> 'customer_id')::uuid and tenant_id = tid));
    if not found then
      raise exception 'Choose the customer to put Rs % on their khata', to_char(udhaar / 100.0, 'FM999,999,999,990.00') using errcode = '22023';
    end if;
    if (p_sale ->> 'customer_id') is not null and exists (
         select 1 from customers where id = (p_sale ->> 'customer_id')::uuid and not can_buy_on_account) then
      flags := flags || app.problem(p_mode, 'udhaar_blocked', 'This person may not buy on the account', '{}');
    end if;
    flags := flags || app.decision_or_flag(p_mode, p_actor, 'udhaar.give', br.id, udhaar,
                                           (approvals ->> 'udhaar')::uuid, 'udhaar_over_limit', sid);
    select * into credit from customer_credit_status where account_id = acct.id;
    if acct.udhaar_blocked then
      flags := flags || app.problem(p_mode, 'udhaar_blocked', acct.name || ' is blocked from udhaar', '{}');
    elsif coalesce(credit.available_credit, 0) < udhaar then
      if p_mode = 'online' then
        perform app.require_decision(p_actor, 'udhaar.limit_override', br.id, udhaar,
                                     (approvals ->> 'udhaar_limit')::uuid, 'udhaar_over_limit', sid);
      else
        flags := flags || app.problem(p_mode, 'over_credit_limit', acct.name || ' is over the credit limit',
                                      jsonb_build_object('udhaar', udhaar, 'available', credit.available_credit));
      end if;
    end if;
  end if;
  if (settle ->> 'cash_applied')::bigint > 0 then
    select * into drawer from drawer_sessions where id = (p_sale ->> 'drawer_session_id')::uuid and tenant_id = tid;
    if not found or not exists (select 1 from cash_drawers where id = drawer.cash_drawer_id and device_id = dev.id) then
      raise exception 'Open the cash drawer on this PC first' using errcode = 'P0001';
    end if;
    if drawer.status <> 'open' then
      flags := flags || app.problem(p_mode, 'drawer_closed', 'Cash taken after the drawer was closed',
                                    jsonb_build_object('drawer_session_id', drawer.id));
    end if;
  end if;

  tax_on := exists (select 1 from tax_profiles where tenant_id = tid and is_enabled
                    and (branch_id is null or branch_id = br.id));

  insert into sales (id, tenant_id, branch_id, device_id, local_seq, invoice_number, customer_id, customer_account_id,
                     doctor_id, prescription_id, subtotal, discount_total, tax_total, rounding_adjustment, grand_total,
                     paid_total, udhaar_amount, change_given, sold_at, business_date, tax_status, validation_status,
                     created_by)
  values (sid, tid, br.id, dev.id, seq, invoice, (p_sale ->> 'customer_id')::uuid, acct.id,
          (p_sale ->> 'doctor_id')::uuid, rx.id, (bill ->> 'subtotal')::bigint, (bill ->> 'discount_total')::bigint,
          (bill ->> 'tax_total')::bigint, (bill ->> 'rounding')::bigint, (bill ->> 'grand_total')::bigint,
          (settle ->> 'paid_total')::bigint, udhaar, (settle ->> 'change')::bigint, sold, bdate,
          case when tax_on then 'pending' else 'not_applicable' end,
          case when jsonb_array_length(flags) > 0 then 'flagged' else 'ok' end, p_actor);

  for i in 0 .. jsonb_array_length(line_meta) - 1 loop
    l := line_meta -> i;
    bl := bill -> 'lines' -> i;
    lid := (l ->> 'id')::uuid;
    insert into sale_lines (id, tenant_id, sale_id, line_no, product_id, product_unit_id, batch_id, qty, qty_base,
                            list_unit_price, unit_price, discount_amount, tax_category_id, tax_rate_bp, tax_amount,
                            line_total, approval_id, created_by, device_id)
    values (lid, tid, sid, i + 1, (l ->> 'product_id')::uuid, (l ->> 'product_unit_id')::uuid, (l ->> 'batch_id')::uuid,
            (priced -> i ->> 'qty')::bigint, (l ->> 'qty_base')::bigint, (l ->> 'list_unit_price')::bigint,
            (priced -> i ->> 'unit_price')::bigint, (bl ->> 'discount')::bigint, (l ->> 'tax_category_id')::uuid,
            (priced -> i ->> 'tax_rate_bp')::int, (bl ->> 'tax')::bigint, (bl ->> 'line_total')::bigint,
            null, p_actor, dev.id);
    insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type,
                                 reference_id, reference_line_id, occurred_at, created_by, device_id)
    values (tid, br.id, (l ->> 'product_id')::uuid, (l ->> 'batch_id')::uuid, 'sale', -(l ->> 'qty_base')::bigint,
            'sale', sid, lid, sold, p_actor, dev.id);
    cogs := app.batch_cogs((l ->> 'batch_id')::uuid, (l ->> 'qty_base')::bigint);
    if cogs is not null then
      insert into sale_line_costs (sale_line_id, tenant_id, cogs) values (lid, tid, cogs);
    end if;
  end loop;

  for pay in select * from jsonb_array_elements(settle -> 'payments') loop
    insert into sale_payments (tenant_id, sale_id, method, amount, tendered, reference, bank_account_id,
                               drawer_session_id, created_by, device_id)
    values (tid, sid, pay ->> 'method', (pay ->> 'amount')::bigint, (pay ->> 'tendered')::bigint, pay ->> 'reference',
            (pay ->> 'bank_account_id')::uuid, case when pay ->> 'method' = 'cash' then drawer.id end, p_actor, dev.id);
  end loop;
  if (settle ->> 'cash_applied')::bigint > 0 then
    insert into cash_movements (tenant_id, branch_id, drawer_session_id, movement_type, amount, reference_type,
                                reference_id, occurred_at, created_by, device_id)
    values (tid, br.id, drawer.id, 'cash_sale', (settle ->> 'cash_applied')::bigint, 'sale', sid, sold, p_actor, dev.id);
  end if;
  if udhaar > 0 then
    due_days := coalesce(acct.default_due_days, (app.setting(tid, br.id, 'udhaar.default_due_days') #>> '{}')::int, 30);
    insert into ledger_entries (tenant_id, branch_id, party_type, customer_account_id, entry_type, debit, entry_date,
                                due_date, reference_type, reference_id, occurred_at, created_by, device_id)
    values (tid, br.id, 'customer_account', acct.id, 'credit_sale', udhaar, bdate, bdate + due_days,
            'sale', sid, sold, p_actor, dev.id);
  end if;
  insert into sync_flags (tenant_id, branch_id, device_id, kind, reference_type, reference_id, details)
  select tid, br.id, dev.id, f ->> 'kind', 'sale', sid,
         jsonb_build_object('message', f ->> 'message') || coalesce(f -> 'details', '{}')
  from jsonb_array_elements(flags) f;

  return jsonb_build_object('sale_id', sid, 'invoice_number', invoice, 'grand_total', (bill ->> 'grand_total')::bigint,
                            'change', (settle ->> 'change')::bigint, 'udhaar', udhaar, 'duplicate', false,
                            'flags', flags);
end $$;

create or replace function public.post_sale(p_sale jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
begin
  return app.record_sale(p_sale, uid, 'online');
end $$;

-- ---- Void --------------------------------------------------------------------
create or replace function public.void_sale(p_sale uuid, p_reason text, p_approval uuid default null,
                                            p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  s sales;
  m cash_movements;
  e ledger_entries;
begin
  select * into s from sales where id = p_sale and tenant_id = app.tenant_id() for update;
  if not found then raise exception 'Bill not found' using errcode = 'P0002'; end if;
  if s.status = 'voided' then raise exception 'This bill is already void' using errcode = 'P0001'; end if;
  if exists (select 1 from sale_returns where original_sale_id = s.id and status = 'completed') then
    raise exception 'Items on this bill were returned; it cannot be voided' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  if app.current_user_id() is null then perform app.assert_branch(s.branch_id); end if;
  perform app.require_decision(uid, 'sales.void', s.branch_id, 1, p_approval, 'void', s.id);

  insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type,
                               reference_id, reference_line_id, reason, occurred_at, created_by, device_id)
  select tenant_id, s.branch_id, product_id, batch_id, 'sale_return', qty_base, 'sale_void', s.id, id, p_reason, now(),
         uid, app.ctx_device_id()
  from sale_lines where sale_id = s.id;
  for m in select * from cash_movements where reference_type = 'sale' and reference_id = s.id loop
    insert into cash_movements (tenant_id, branch_id, drawer_session_id, movement_type, amount, reference_type,
                                reference_id, reverses_movement_id, memo, occurred_at, created_by, device_id)
    values (m.tenant_id, m.branch_id, m.drawer_session_id, 'reversal', -m.amount, 'sale_void', s.id, m.id, p_reason,
            now(), uid, app.ctx_device_id());
  end loop;
  for e in select * from ledger_entries where reference_type = 'sale' and reference_id = s.id loop
    insert into ledger_entries (tenant_id, branch_id, party_type, customer_account_id, entry_type, credit, entry_date,
                                reference_type, reference_id, reverses_entry_id, memo, occurred_at, created_by, device_id)
    values (e.tenant_id, e.branch_id, e.party_type, e.customer_account_id, 'reversal', e.debit, current_date,
            'sale_void', s.id, e.id, p_reason, now(), uid, app.ctx_device_id());
  end loop;
  update sales set status = 'voided', voided_at = now(), voided_by = uid, void_reason = p_reason,
                   void_approval_id = p_approval
  where id = s.id;
end $$;

-- ---- Returns -------------------------------------------------------------------
-- p_return: id, local_seq, original_sale_id, refund_method, reason,
--   drawer_session_id, returned_at, approval,
--   lines [{sale_line_id, qty_base, restock, condition}]
-- Refund per line = line total x returned / sold, rounded half-up.
create or replace function app.record_return(p_return jsonb, p_actor uuid, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  tid uuid := app.tenant_id();
  rid uuid := (p_return ->> 'id')::uuid;
  seq bigint := (p_return ->> 'local_seq')::bigint;
  dev devices;
  s sales;
  l jsonb;
  sl sale_lines;
  already bigint;
  refund bigint;
  total bigint := 0;
  method text := p_return ->> 'refund_method';
  returned timestamptz := coalesce((p_return ->> 'returned_at')::timestamptz, now());
  drawer drawer_sessions;
  number text;
  flags jsonb := '[]';
begin
  if exists (select 1 from sale_returns where id = rid) then
    return jsonb_build_object('return_id', rid, 'duplicate', true);
  end if;
  select * into dev from devices
  where id = coalesce(app.current_device_id(), (p_return ->> 'device_id')::uuid) and tenant_id = tid
    and kind = 'counter' and status = 'active';
  if not found then raise exception 'Returns are taken on a registered counter PC' using errcode = '42501'; end if;
  select * into s from sales where id = (p_return ->> 'original_sale_id')::uuid and tenant_id = tid;
  if not found then raise exception 'Original bill not found' using errcode = 'P0002'; end if;
  if s.status = 'voided' then raise exception 'That bill was voided' using errcode = 'P0001'; end if;
  if coalesce(trim(p_return ->> 'reason'), '') = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  perform set_config('app.device_id', dev.id::text, true);
  number := dev.invoice_prefix || '-R' || lpad(seq::text, 6, '0');

  insert into sale_returns (id, tenant_id, branch_id, device_id, local_seq, return_number, original_sale_id,
                            customer_account_id, refund_method, refund_total, reason, approval_id, drawer_session_id,
                            returned_at, created_by)
  values (rid, tid, dev.branch_id, dev.id, seq, number, s.id, s.customer_account_id, method, 0,
          p_return ->> 'reason', (p_return ->> 'approval')::uuid, (p_return ->> 'drawer_session_id')::uuid,
          returned, p_actor);

  for l in select * from jsonb_array_elements(p_return -> 'lines') loop
    select * into sl from sale_lines where id = (l ->> 'sale_line_id')::uuid and sale_id = s.id;
    if not found then raise exception 'That item is not on the original bill' using errcode = 'P0002'; end if;
    select coalesce(sum(rl.qty_base), 0) into already
    from return_lines rl join sale_returns r on r.id = rl.sale_return_id
    where rl.sale_line_id = sl.id and r.status = 'completed' and r.id <> rid;
    if (l ->> 'qty_base')::bigint <= 0 or already + (l ->> 'qty_base')::bigint > sl.qty_base then
      raise exception 'Only % of this item can still be returned', sl.qty_base - already using errcode = 'P0001';
    end if;
    refund := app.div_round(sl.line_total::numeric * (l ->> 'qty_base')::bigint, sl.qty_base);
    total := total + refund;
    insert into return_lines (tenant_id, sale_return_id, sale_line_id, batch_id, qty_base, refund_amount, restock,
                              condition, created_by, device_id)
    values (tid, rid, sl.id, sl.batch_id, (l ->> 'qty_base')::bigint, refund,
            coalesce((l ->> 'restock')::boolean, true), coalesce(l ->> 'condition', 'sealed'), p_actor, dev.id);
    if coalesce((l ->> 'restock')::boolean, true) then
      insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type,
                                   reference_id, reference_line_id, occurred_at, created_by, device_id)
      values (tid, dev.branch_id, sl.product_id, sl.batch_id, 'sale_return', (l ->> 'qty_base')::bigint,
              'sale_return', rid, sl.id, returned, p_actor, dev.id);
    end if;
  end loop;

  flags := flags || app.decision_or_flag(p_mode, p_actor, 'sales.return', dev.branch_id, total,
                                         (p_return ->> 'approval')::uuid, 'return', rid);
  update sale_returns set refund_total = total where id = rid;

  if method = 'cash' and total > 0 then
    select * into drawer from drawer_sessions where id = (p_return ->> 'drawer_session_id')::uuid and tenant_id = tid;
    if not found or not exists (select 1 from cash_drawers where id = drawer.cash_drawer_id and device_id = dev.id) then
      raise exception 'Open the cash drawer on this PC first' using errcode = 'P0001';
    end if;
    insert into cash_movements (tenant_id, branch_id, drawer_session_id, movement_type, amount, reference_type,
                                reference_id, occurred_at, created_by, device_id)
    values (tid, dev.branch_id, drawer.id, 'sale_refund', -total, 'sale_return', rid, returned, p_actor, dev.id);
  elsif method = 'udhaar_credit' and total > 0 then
    if s.customer_account_id is null then
      raise exception 'The original bill has no customer account' using errcode = 'P0001';
    end if;
    insert into ledger_entries (tenant_id, branch_id, party_type, customer_account_id, entry_type, credit, entry_date,
                                reference_type, reference_id, occurred_at, created_by, device_id)
    values (tid, dev.branch_id, 'customer_account', s.customer_account_id, 'sale_return', total,
            (returned at time zone 'UTC')::date, 'sale_return', rid, returned, p_actor, dev.id);
  end if;
  insert into sync_flags (tenant_id, branch_id, device_id, kind, reference_type, reference_id, details)
  select tid, dev.branch_id, dev.id, f ->> 'kind', 'sale_return', rid,
         jsonb_build_object('message', f ->> 'message') || coalesce(f -> 'details', '{}')
  from jsonb_array_elements(flags) f;
  return jsonb_build_object('return_id', rid, 'return_number', number, 'refund_total', total, 'flags', flags,
                            'duplicate', false);
end $$;

create or replace function public.post_return(p_return jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
begin
  return app.record_return(p_return, uid, 'online');
end $$;

-- ---- Cash drawer (blind closing) ------------------------------------------------
create or replace function public.open_drawer(p_drawer uuid, p_opening_float bigint, p_session uuid default null,
                                              p_drawer_session uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  d cash_drawers;
  dsid uuid := coalesce(p_drawer_session, app.uuid_v7());
begin
  select * into d from cash_drawers where id = p_drawer and tenant_id = app.tenant_id() and archived_at is null;
  if not found then raise exception 'Drawer not found' using errcode = 'P0002'; end if;
  perform app.assert_branch(d.branch_id);
  perform app.require_decision(uid, 'sales.create', d.branch_id, null, null, 'other');
  if p_opening_float is null or p_opening_float < 0 then
    raise exception 'Opening cash must be 0 or more' using errcode = '22023';
  end if;
  insert into drawer_sessions (id, tenant_id, branch_id, cash_drawer_id, opened_by, opened_at, opening_float,
                               created_by, device_id)
  values (dsid, d.tenant_id, d.branch_id, d.id, uid, now(), p_opening_float, uid, app.ctx_device_id());
  if p_opening_float > 0 then
    insert into cash_movements (tenant_id, branch_id, drawer_session_id, movement_type, amount, reference_type,
                                reference_id, occurred_at, created_by, device_id)
    values (d.tenant_id, d.branch_id, dsid, 'opening_float', p_opening_float, 'drawer_session', dsid, now(), uid,
            app.ctx_device_id());
  end if;
  return dsid;
end $$;

-- The salesman enters what they counted and never sees the expected amount;
-- the difference goes to drawer_session_reconciliations (owner-only).
create or replace function public.close_drawer(p_drawer_session uuid, p_counted bigint,
                                               p_denominations jsonb default null, p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  ds drawer_sessions;
  expected bigint;
begin
  select * into ds from drawer_sessions where id = p_drawer_session and tenant_id = app.tenant_id() for update;
  if not found or ds.status <> 'open' then raise exception 'Drawer is not open' using errcode = 'P0001'; end if;
  perform app.assert_branch(ds.branch_id);
  if ds.opened_by <> uid then
    perform app.require_decision(uid, 'cash.view', ds.branch_id, null, null, 'other');
  else
    perform app.require_decision(uid, 'cash.close_shift', ds.branch_id, null, null, 'other');
  end if;
  if p_counted is null or p_counted < 0 then raise exception 'Counted cash must be 0 or more' using errcode = '22023'; end if;
  select coalesce(sum(amount), 0) into expected from cash_movements where drawer_session_id = ds.id;
  update drawer_sessions set status = 'closed', closed_by = uid, closed_at = now(), counted_cash = p_counted,
                             counted_denominations = p_denominations
  where id = ds.id;
  insert into drawer_session_reconciliations (drawer_session_id, tenant_id, expected_cash, variance)
  values (ds.id, ds.tenant_id, expected, p_counted - expected)
  on conflict (drawer_session_id) do update
    set expected_cash = excluded.expected_cash, variance = excluded.variance, computed_at = now();
end $$;

-- ---- Receipt (read through RLS: no cost, no profit) ------------------------------
create or replace function public.get_receipt(p_sale uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'invoice_number', s.invoice_number, 'sold_at', s.sold_at, 'status', s.status,
    'branch', jsonb_build_object('name', br.name, 'address', br.address, 'phone', br.phone),
    'pharmacy', t.name,
    'lines', (select jsonb_agg(jsonb_build_object(
                'name', p.brand_name, 'strength', p.strength, 'unit', u.code, 'qty', sl.qty,
                'unit_price', sl.unit_price, 'discount', sl.discount_amount, 'tax', sl.tax_amount,
                'line_total', sl.line_total, 'batch', b.batch_number, 'expiry', b.expiry_date) order by sl.line_no)
              from sale_lines sl join products p on p.id = sl.product_id
              join product_units pu on pu.id = sl.product_unit_id join units u on u.id = pu.unit_id
              join batches b on b.id = sl.batch_id
              where sl.sale_id = s.id),
    'subtotal', s.subtotal, 'discount_total', s.discount_total, 'tax_total', s.tax_total,
    'rounding', s.rounding_adjustment, 'grand_total', s.grand_total, 'paid_total', s.paid_total,
    'udhaar', s.udhaar_amount, 'change', s.change_given,
    'payments', (select jsonb_agg(jsonb_build_object('method', method, 'amount', amount)) from sale_payments where sale_id = s.id),
    'tax_invoice_number', s.authority_invoice_number)
  from sales s join branches br on br.id = s.branch_id join tenants t on t.id = s.tenant_id
  where s.id = p_sale
$$;

-- ---- Grants ------------------------------------------------------------------------
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
  public.post_sale(jsonb, uuid),
  public.void_sale(uuid, text, uuid, uuid),
  public.post_return(jsonb, uuid),
  public.open_drawer(uuid, bigint, uuid, uuid),
  public.close_drawer(uuid, bigint, jsonb, uuid),
  public.get_receipt(uuid)
  to authenticated;

grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;

select app.assert_rls_everywhere();
