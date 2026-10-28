-- Test helpers, loaded once before the pgTAP files (never in production).
-- tests.fixture() builds two pharmacies; each test file calls it inside its
-- own transaction and rolls back at the end.
--
--   Pharmacy A: branches KHI1 (a1) and KHI2 (a2); primary owner; salesman
--   and manager at a1; store keeper at all branches; counter PCs at a1 and
--   a2; stock, cost, udhaar, cash and one sale.
--   Pharmacy B: one branch, its owner, one product.

create schema if not exists tests;
grant usage on schema tests to authenticated, service_role;

-- Stable ids from names: tests.id('tenant_a').
create or replace function tests.id(p_name text) returns uuid
language sql immutable as $$ select md5('medflow-test:' || p_name)::uuid $$;

-- Switch identity for the rest of the transaction.
create or replace function tests.as_owner(p_auth uuid, p_tenant uuid, p_aal text default 'aal2') returns void
language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', p_auth, 'tenant_id', p_tenant, 'aal', p_aal, 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create or replace function tests.as_device(p_auth uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', p_auth, 'aal', 'aal1', 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create or replace function tests.as_admin(p_auth uuid, p_aal text default 'aal2') returns void
language sql as $$
  select set_config('request.jwt.claims',
           json_build_object('sub', p_auth, 'aal', p_aal, 'role', 'authenticated')::text, true);
  select set_config('role', 'authenticated', true);
$$;

-- Tables/views with a tenant_id where the current caller can see rows of
-- p_tenant. '' means nothing leaks.
create or replace function tests.leaking_tables(p_tenant uuid) returns text
language plpgsql security invoker as $$
declare
  r record;
  n bigint;
  leaks text[] := '{}';
begin
  for r in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'tenant_id'
    order by c.table_name
  loop
    execute format('select count(*) from public.%I where tenant_id = $1', r.table_name) into n using p_tenant;
    if n > 0 then leaks := leaks || r.table_name; end if;
  end loop;
  return array_to_string(leaks, ', ');
end $$;

create or replace function tests.count_rows(p_table text) returns bigint
language plpgsql security invoker as $$
declare n bigint;
begin
  execute format('select count(*) from public.%I', p_table) into n;
  return n;
end $$;

-- The Phase 2 import test file: 10,000 product rows as the import screen sends them.
create or replace function tests.import_file() returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
           'brand_name', 'Medicine ' || g,
           'generic', 'Generic ' || (g % 300),
           'strength', ((g % 5) * 100 + 100) || ' mg',
           'dosage_form', 'tablet',
           'manufacturer', 'Maker ' || (g % 40),
           'category', 'Category ' || (g % 12),
           'barcode', '899' || lpad(g::text, 9, '0'),
           'base_unit', 'tablet',
           'units', jsonb_build_array(jsonb_build_object('unit', 'strip', 'factor', 10),
                                      jsonb_build_object('unit', 'box', 'factor', 100)),
           'retail_price', g * 10 + 500,
           'retail_unit', 'strip',
           'reorder_level', 20,
           'is_controlled', case when g % 500 = 0 then 'yes' else 'no' end) order by g)
  from generate_series(1, 10000) g
$$;

-- Keep a jsonb result for later assertions (temp tables are not usable
-- after switching to the client role).
create or replace function tests.keep(p_name text, p_value jsonb) returns jsonb
language sql as $$ select set_config('tests.' || p_name, p_value::text, true)::jsonb $$;
create or replace function tests.kept(p_name text) returns jsonb
language sql stable as $$ select current_setting('tests.' || p_name)::jsonb $$;

grant execute on all functions in schema tests to authenticated, service_role;

create or replace function tests.fixture() returns void
language plpgsql as $$
declare
  ta uuid := tests.id('tenant_a');
  tb uuid := tests.id('tenant_b');
  pl uuid := tests.id('plan');
  owner_a uuid := tests.id('owner_a');
  owner_b uuid := tests.id('owner_b');
  a1 uuid := tests.id('branch_a1');
  a2 uuid := tests.id('branch_a2');
  b1 uuid := tests.id('branch_b1');
  salesman uuid := tests.id('salesman_a');
  manager uuid := tests.id('manager_a');
  keeper uuid := tests.id('storekeeper_a');
  dev1 uuid := tests.id('device_a1');
  dev2 uuid := tests.id('device_a2');
  tab_a uuid;
  tab_b uuid;
  pu uuid := tests.id('product_unit_a');
  acct uuid := tests.id('account_a');
  sup uuid := tests.id('supplier_a');
  drawer uuid := tests.id('drawer_a1');
  sess uuid := tests.id('drawer_session_a1');
  sale uuid := tests.id('sale_a1');
  line uuid := tests.id('sale_line_a1');
begin
  insert into auth.users (id, email) values
    (tests.id('auth_owner_a'), 'owner.a@test.invalid'),
    (tests.id('auth_owner_b'), 'owner.b@test.invalid'),
    (tests.id('auth_device_a1'), 'device.a1@test.invalid'),
    (tests.id('auth_device_a2'), 'device.a2@test.invalid'),
    (tests.id('auth_admin'), 'admin@test.invalid'),
    (tests.id('auth_new_owner'), 'new.owner@test.invalid');

  insert into plans (id, code, name, trial_days) values (pl, 'test_basic', 'Test Basic', 14);
  insert into plan_features (plan_id, feature_code, enabled, limit_value) values
    (pl, 'max_branches', true, 2), (pl, 'max_counters', true, 2), (pl, 'max_staff', true, 6),
    (pl, 'warehouse', false, null), (pl, 'pos', true, null);

  insert into platform_admins (id, auth_user_id, full_name, email)
  values (tests.id('admin'), tests.id('auth_admin'), 'Syed Hashir Ali', 'admin@test.invalid');

  insert into tenants (id, name, owner_name, owner_phone, owner_email, plan_id, status) values
    (ta, 'Pharmacy A', 'Owner A', '03000000001', 'owner.a@test.invalid', pl, 'active'),
    (tb, 'Pharmacy B', 'Owner B', '03000000002', 'owner.b@test.invalid', pl, 'active');

  insert into users (id, tenant_id, auth_user_id, kind, is_primary_owner, full_name, status) values
    (owner_a, ta, tests.id('auth_owner_a'), 'owner', true, 'Owner A', 'active'),
    (owner_b, tb, tests.id('auth_owner_b'), 'owner', true, 'Owner B', 'active');

  insert into branches (id, tenant_id, code, name) values
    (a1, ta, 'KHI1', 'A Saddar'), (a2, ta, 'KHI2', 'A Clifton'), (b1, tb, 'LHR1', 'B Gulberg');

  perform app.seed_tenant_defaults(ta, owner_a);
  perform app.seed_tenant_defaults(tb, owner_b);

  insert into users (id, tenant_id, kind, full_name) values
    (salesman, ta, 'staff', 'Salesman A'), (manager, ta, 'staff', 'Manager A'), (keeper, ta, 'staff', 'Store keeper A');
  insert into user_roles (tenant_id, user_id, role_id, branch_id)
  select ta, x.u, r.id, x.b
  from (values (salesman, 'salesman', a1), (manager, 'manager', a1), (keeper, 'storekeeper', null::uuid)) as x(u, t, b)
  join roles r on r.tenant_id = ta and r.template_code = x.t;

  insert into devices (id, tenant_id, branch_id, auth_user_id, code, invoice_prefix, name, kind) values
    (dev1, ta, a1, tests.id('auth_device_a1'), 'C1', 'KHI1-C1', 'Saddar counter 1', 'counter'),
    (dev2, ta, a2, tests.id('auth_device_a2'), 'C1', 'KHI2-C1', 'Clifton counter 1', 'counter');

  insert into user_pins (user_id, tenant_id, pin_hash) values
    (salesman, ta, 'pbkdf2-sha256$600000$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g='),
    (manager, ta, 'pbkdf2-sha256$600000$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=');

  -- catalogue and stock
  select id into tab_a from units where tenant_id = ta and code = 'tablet';
  select id into tab_b from units where tenant_id = tb and code = 'tablet';
  insert into products (id, tenant_id, brand_name, base_unit_id) values
    (tests.id('product_a'), ta, 'Panadol 500mg', tab_a),
    (tests.id('product_b'), tb, 'Brufen 400mg', tab_b);
  insert into product_units (id, tenant_id, product_id, unit_id, factor_to_base)
  values (pu, ta, tests.id('product_a'), tab_a, 1);
  insert into product_prices (tenant_id, product_id, product_unit_id, price_kind, amount) values
    (ta, tests.id('product_a'), pu, 'retail', 250),
    (ta, tests.id('product_a'), pu, 'trade', 180);
  insert into batches (id, tenant_id, product_id, batch_number, expiry_date)
  values (tests.id('batch_a'), ta, tests.id('product_a'), 'P123', current_date + 400);
  insert into batch_cost_layers (tenant_id, batch_id, source, qty_base, total_cost, occurred_at)
  values (ta, tests.id('batch_a'), 'opening', 110, 10000, now());
  insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, occurred_at) values
    (ta, a1, tests.id('product_a'), tests.id('batch_a'), 'opening', 100, now()),
    (ta, a1, tests.id('product_a'), tests.id('batch_a'), 'sale', -4, now()),
    (ta, a1, tests.id('product_a'), tests.id('batch_a'), 'sale', -6, now()),
    (ta, a2, tests.id('product_a'), tests.id('batch_a'), 'opening', 10, now());

  -- udhaar: customer owes 2,000.00; we owe the supplier 5,000.00
  insert into customer_accounts (id, tenant_id, account_number, name)
  values (acct, ta, 'C-0001', 'Khan family');
  insert into credit_limits (tenant_id, account_id, limit_amount, created_by)
  values (ta, acct, 500000, owner_a);
  insert into ledger_entries (tenant_id, party_type, customer_account_id, entry_type, debit, credit,
                              entry_date, occurred_at, created_by) values
    (ta, 'customer_account', acct, 'credit_sale', 300000, 0, current_date, now(), salesman),
    (ta, 'customer_account', acct, 'payment', 0, 100000, current_date, now(), salesman);
  insert into suppliers (id, tenant_id, name) values (sup, ta, 'Muller & Phipps');
  insert into ledger_entries (tenant_id, party_type, supplier_id, entry_type, debit, credit,
                              entry_date, occurred_at, created_by)
  values (ta, 'supplier', sup, 'purchase_invoice', 0, 500000, current_date, now(), owner_a);

  -- cash: drawer at counter a1, a session opened by the salesman
  insert into cash_drawers (id, tenant_id, branch_id, device_id, name)
  values (drawer, ta, a1, dev1, 'Drawer 1');
  insert into drawer_sessions (id, tenant_id, branch_id, cash_drawer_id, opened_by, opened_at, opening_float)
  values (sess, ta, a1, drawer, salesman, now(), 500000);
  insert into cash_movements (tenant_id, branch_id, drawer_session_id, movement_type, amount, occurred_at, created_by)
  values (ta, a1, sess, 'opening_float', 500000, now(), salesman);
  insert into drawer_session_reconciliations (drawer_session_id, tenant_id, expected_cash, variance)
  values (sess, ta, 500000, 0);

  -- one sale at counter a1
  insert into sales (id, tenant_id, branch_id, device_id, local_seq, invoice_number, subtotal, grand_total,
                     paid_total, sold_at, business_date, created_by)
  values (sale, ta, a1, dev1, 1, 'KHI1-C1-000001', 1000, 1000, 1000, now(), current_date, salesman);
  insert into sale_lines (id, tenant_id, sale_id, line_no, product_id, product_unit_id, batch_id,
                          qty, qty_base, list_unit_price, unit_price, line_total)
  values (line, ta, sale, 1, tests.id('product_a'), pu, tests.id('batch_a'), 4, 4, 250, 250, 1000);
  insert into sale_line_costs (sale_line_id, tenant_id, cogs) values (line, ta, 364);
  insert into sale_payments (tenant_id, sale_id, method, amount, drawer_session_id)
  values (ta, sale, 'cash', 1000, sess);
end $$;
