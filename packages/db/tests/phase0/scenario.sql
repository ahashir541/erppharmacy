-- Fixture (as superuser, RLS bypassed)
insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-0000000000a3'), ('00000000-0000-0000-0000-0000000000b1');
insert into plans (id, code, name) values ('10000000-0000-0000-0000-000000000001', 'basic', 'Basic');
insert into tenants (id, name, owner_name, owner_phone, owner_email, plan_id, status) values
  ('20000000-0000-0000-0000-00000000000a', 'Pharmacy A', 'Owner A', '1', 'a@x.test', '10000000-0000-0000-0000-000000000001', 'active'),
  ('20000000-0000-0000-0000-00000000000b', 'Pharmacy B', 'Owner B', '2', 'b@x.test', '10000000-0000-0000-0000-000000000001', 'active');
insert into users (id, tenant_id, auth_user_id, kind, is_primary_owner, full_name) values
  ('30000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'owner', true, 'Owner A'),
  ('30000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'staff', false, 'Salesman A'),
  ('30000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000000b1', 'owner', true, 'Owner B');
insert into branches (id, tenant_id, code, name) values
  ('40000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', 'KHI1', 'A main'),
  ('40000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-00000000000b', 'LHR1', 'B main');
insert into devices (id, tenant_id, branch_id, auth_user_id, code, invoice_prefix, name, kind) values
  ('50000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-0000000000a1',
   '00000000-0000-0000-0000-0000000000a3', 'C1', 'KHI1-C1', 'Counter 1', 'counter');
-- salesman role from template
insert into roles (id, tenant_id, name, template_code) values
  ('60000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', 'Salesman', 'salesman');
insert into role_permissions (tenant_id, role_id, permission_code, allowed, needs_approval)
  select '20000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-0000000000a1', permission_code, allowed, needs_approval
  from role_template_permissions where template_code = 'salesman';
insert into user_roles (tenant_id, user_id, role_id, branch_id) values
  ('20000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-0000000000a2', '60000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-0000000000a1');
insert into user_pins (user_id, tenant_id, pin_hash) values
  ('30000000-0000-0000-0000-0000000000a2', '20000000-0000-0000-0000-00000000000a', 'argon2id$x');

-- catalogue + stock in both tenants
insert into units (id, tenant_id, code, name) values
  ('70000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', 'tablet', 'Tablet'),
  ('70000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-00000000000b', 'tablet', 'Tablet');
insert into products (id, tenant_id, brand_name, base_unit_id) values
  ('80000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', 'Panadol', '70000000-0000-0000-0000-0000000000a1'),
  ('80000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-00000000000b', 'Brufen', '70000000-0000-0000-0000-0000000000b1');
insert into product_units (id, tenant_id, product_id, unit_id, factor_to_base) values
  ('81000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-0000000000a1', '70000000-0000-0000-0000-0000000000a1', 1);
insert into product_prices (tenant_id, product_id, product_unit_id, price_kind, amount) values
  ('20000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-0000000000a1', '81000000-0000-0000-0000-0000000000a1', 'retail', 250),
  ('20000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-0000000000a1', '81000000-0000-0000-0000-0000000000a1', 'trade', 180);
insert into batches (id, tenant_id, product_id, batch_number, expiry_date) values
  ('90000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-0000000000a1', 'P123', '2028-01-01');
insert into batch_cost_layers (tenant_id, batch_id, source, qty_base, total_cost, occurred_at) values
  ('20000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-0000000000a1', 'opening', 110, 10000, now());
insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, occurred_at) values
  ('20000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000a1', 'opening', 110, now()),
  ('20000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000a1', 'sale', -4, now()),
  ('20000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000000a1', '90000000-0000-0000-0000-0000000000a1', 'sale', -6, now());

-- udhaar ledger
insert into customer_accounts (id, tenant_id, account_number, name) values
  ('a0000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-00000000000a', 'C-1', 'Khan family');
insert into credit_limits (tenant_id, account_id, limit_amount, created_by) values
  ('20000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-0000000000a1', 500000, '30000000-0000-0000-0000-0000000000a1');
insert into ledger_entries (tenant_id, party_type, customer_account_id, entry_type, debit, credit, entry_date, occurred_at, created_by) values
  ('20000000-0000-0000-0000-00000000000a', 'customer_account', 'a0000000-0000-0000-0000-0000000000a1', 'credit_sale', 300000, 0, current_date, now(), '30000000-0000-0000-0000-0000000000a2'),
  ('20000000-0000-0000-0000-00000000000a', 'customer_account', 'a0000000-0000-0000-0000-0000000000a1', 'payment', 0, 100000, current_date, now(), '30000000-0000-0000-0000-0000000000a2');

do $$ begin
  assert (select qty_base from stock_balances where batch_id = '90000000-0000-0000-0000-0000000000a1') = 100, 'stock balance = sum of movements';
  assert (select balance from party_balances where party_id = 'a0000000-0000-0000-0000-0000000000a1') = 200000, 'udhaar balance = sum of entries';
  assert (select status || ':' || available_credit from customer_credit_status where account_id = 'a0000000-0000-0000-0000-0000000000a1') = 'allowed:300000', 'credit status';
end $$;

-- append-only / no delete
do $$ begin
  begin update stock_movements set qty_base = 1; raise exception 'update allowed!' using errcode = 'MF001';
  exception when sqlstate 'P0001' then null; end;
  begin delete from products; raise exception 'delete allowed!' using errcode = 'MF001';
  exception when sqlstate 'P0001' then null; end;
end $$;

-- audit captured the product insert
do $$ begin
  assert (select count(*) from audit_log where table_name = 'products' and action = 'insert') = 2, 'audit inserts';
end $$;

-- recall freezes matching batches
insert into global_recalls (brand_name, batch_number, reason) values ('PANADOL', 'p123', 'DRAP recall');
do $$ begin
  assert (select count(*) from batch_blocks where batch_id = '90000000-0000-0000-0000-0000000000a1' and lifted_at is null) = 1, 'recall block';
end $$;

-- ---- RLS as Owner A ----
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","tenant_id":"20000000-0000-0000-0000-00000000000a"}', false);
do $$ begin
  assert (select count(*) from products) = 1, 'owner A sees only A products';
  assert (select count(*) from tenants) = 1, 'owner A sees only own tenant';
  assert (select count(*) from batch_cost_layers) = 1, 'owner sees cost';
  assert (select count(*) from product_prices) = 2, 'owner sees trade price';
  assert (select count(*) from party_balances) = 1, 'owner sees balances';
end $$;
do $$ begin
  begin insert into products (tenant_id, brand_name, base_unit_id) values ('20000000-0000-0000-0000-00000000000a', 'x', '70000000-0000-0000-0000-0000000000a1');
        raise exception 'direct insert allowed!' using errcode = 'MF001';
  exception when insufficient_privilege then null; end;
end $$;

-- ---- RLS as Owner B: nothing of A ----
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","tenant_id":"20000000-0000-0000-0000-00000000000b"}', false);
do $$ begin
  assert (select count(*) from products where tenant_id = '20000000-0000-0000-0000-00000000000a') = 0, 'B cannot read A';
  assert (select count(*) from stock_balances) = 0, 'B cannot read A stock';
  assert (select count(*) from audit_log where tenant_id <> '20000000-0000-0000-0000-00000000000b') = 0, 'B cannot read A audit';
end $$;
-- B forging A's tenant_id in the token
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","tenant_id":"20000000-0000-0000-0000-00000000000a"}', false);
do $$ begin
  assert (select count(*) from products) = 0, 'forged tenant claim gives nothing';
end $$;

-- ---- RLS as Salesman A ----
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","tenant_id":"20000000-0000-0000-0000-00000000000a"}', false);
do $$ begin
  assert (select count(*) from products) = 1, 'salesman sees products';
  assert (select count(*) from stock_balances) = 1, 'salesman sees stock';
  assert (select count(*) from batch_cost_layers) = 0, 'salesman cannot see cost';
  assert (select count(*) from product_prices) = 1, 'salesman cannot see trade price';
  assert (select count(*) from party_balances) = 0, 'salesman cannot see udhaar balance';
  assert (select count(*) from ledger_entries) = 0, 'salesman cannot see ledger';
  assert (select count(*) from customer_credit_status) = 1, 'salesman sees allowed/not allowed';
  assert (select count(*) from audit_log) = 0, 'salesman cannot see audit';
end $$;

-- ---- RLS as Counter device A ----
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a3"}', false);
do $$ begin
  assert (select count(*) from products) = 1, 'device sees products';
  assert (select count(*) from stock_balances) = 1, 'device sees stock';
  assert (select count(*) from user_pins) = 1, 'device gets PIN hash of allowed staff';
  assert (select count(*) from batch_cost_layers) = 0, 'device cannot see cost';
  assert (select count(*) from party_balances) = 0, 'device cannot see balances';
  assert (select count(*) from money_balances) = 0, 'device cannot see cash';
end $$;
reset role;

-- GL journal must balance at commit
do $$
declare acc uuid; j uuid;
begin
  insert into gl_accounts (tenant_id, code, name, type) values ('20000000-0000-0000-0000-00000000000a', '1000', 'Cash', 'asset') returning id into acc;
  insert into gl_journals (tenant_id, journal_date, source_type) values ('20000000-0000-0000-0000-00000000000a', current_date, 'manual') returning id into j;
  begin
    insert into gl_entries (tenant_id, journal_id, gl_account_id, debit) values ('20000000-0000-0000-0000-00000000000a', j, acc, 100);
    set constraints all immediate;
    raise exception 'unbalanced journal accepted!' using errcode = 'MF001';
  exception when sqlstate 'P0001' then null; end;
end $$;

-- balanced journal is accepted
do $$
declare acc uuid; acc2 uuid; j uuid;
begin
  insert into gl_accounts (tenant_id, code, name, type) values ('20000000-0000-0000-0000-00000000000a', '4000', 'Sales', 'income') returning id into acc2;
  select id into acc from gl_accounts where code = '1000';
  insert into gl_journals (tenant_id, journal_date, source_type) values ('20000000-0000-0000-0000-00000000000a', current_date, 'manual') returning id into j;
  insert into gl_entries (tenant_id, journal_id, gl_account_id, debit) values ('20000000-0000-0000-0000-00000000000a', j, acc, 100);
  insert into gl_entries (tenant_id, journal_id, gl_account_id, credit) values ('20000000-0000-0000-0000-00000000000a', j, acc2, 100);
  set constraints all immediate;
end $$;
