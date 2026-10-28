-- Phase 1 acceptance: a salesman cannot read cost or other money data.
-- Staff work only on pharmacy PCs (D11), so "the salesman's view" is the
-- counter PC's view plus the permission engine's answers for the salesman.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

-- The owner sees the money rows, so the zeros below are real hiding.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select ok(tests.count_rows('batch_cost_layers') > 0, 'owner sees cost layers');
select ok(tests.count_rows('sale_line_costs') > 0, 'owner sees sale costs');
select ok(tests.count_rows('party_balances') > 0, 'owner sees udhaar balances');
select ok(tests.count_rows('money_balances') > 0, 'owner sees cash balances');
select is(tests.count_rows('product_prices'), 2::bigint, 'owner sees retail and trade prices');

select tests.as_device(tests.id('auth_device_a1'));
select ok(tests.count_rows('products') > 0, 'counter sees products');
select is(tests.count_rows('stock_balances'), 1::bigint, 'counter sees stock of its own branch only');
select is(tests.count_rows('batch_cost_layers'), 0::bigint, 'counter cannot see cost layers');
select is(tests.count_rows('grn_line_costs'), 0::bigint, 'counter cannot see purchase costs');
select is(tests.count_rows('sale_line_costs'), 0::bigint, 'counter cannot see sale costs / profit');
select is(tests.count_rows('product_prices'), 1::bigint, 'counter sees retail price but not trade price');
select is(tests.count_rows('party_balances'), 0::bigint, 'counter cannot see udhaar or payable balances');
select is(tests.count_rows('ledger_entries'), 0::bigint, 'counter cannot see the udhaar ledger');
select is(tests.count_rows('credit_limits'), 0::bigint, 'counter cannot see credit limits');
select is(tests.count_rows('customer_credit_status'), 1::bigint, 'counter sees allowed / not allowed for udhaar');
select is(tests.count_rows('cash_movements'), 0::bigint, 'counter cannot see cash movements');
select is(tests.count_rows('money_balances'), 0::bigint, 'counter cannot see cash balances');
select is(tests.count_rows('drawer_session_reconciliations'), 0::bigint, 'counter cannot see expected cash / short-over');
select is(tests.count_rows('drawer_sessions'), 1::bigint, 'counter sees its own open drawer session');
select is(tests.count_rows('audit_log'), 0::bigint, 'counter cannot read the audit log');
select is(tests.count_rows('sales'), 1::bigint, 'counter sees recent bills of its branch');
select is(tests.count_rows('user_pins'), 2::bigint, 'counter gets PIN hashes of staff at its branch');

-- A counter at the other branch.
select tests.as_device(tests.id('auth_device_a2'));
select is(tests.count_rows('sales'), 0::bigint, 'counter A2 cannot see branch A1 bills');
select is(tests.count_rows('user_pins'), 0::bigint, 'counter A2 gets no PINs of branch A1 staff');
select is(tests.count_rows('drawer_sessions'), 0::bigint, 'counter A2 cannot see branch A1 drawer');

reset role;

-- The salesman's permissions (what the counter app and server RPCs enforce).
select is(app.permission_decision(tests.id('salesman_a'), 'product.view_cost', tests.id('branch_a1')), 'deny',
          'salesman may not see cost price');
select is(app.permission_decision(tests.id('salesman_a'), 'sales.view_totals', tests.id('branch_a1')), 'deny',
          'salesman may not see sales totals');
select is(app.permission_decision(tests.id('salesman_a'), 'udhaar.view_balance', tests.id('branch_a1')), 'deny',
          'salesman may not see udhaar balances');
select is(app.permission_decision(tests.id('salesman_a'), 'cash.view_variance', tests.id('branch_a1')), 'deny',
          'salesman may not see cash short / over');

-- Staff can never be given a cloud login (D11).
select throws_ok(
  format('update public.users set auth_user_id = %L where id = %L', tests.id('auth_new_owner'), tests.id('salesman_a')),
  '23514', null, 'a staff member cannot have a cloud login');

select * from finish();
rollback;
