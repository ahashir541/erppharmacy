-- The permissions engine (same rules as packages/core/src/permissions.ts).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

select is(app.permission_decision(tests.id('owner_a'), 'sales.discount', tests.id('branch_a1'), 9999), 'allow',
          'primary owner: everything, no limit');
select is(app.permission_decision(tests.id('salesman_a'), 'sales.create', tests.id('branch_a1')), 'allow',
          'salesman can sell at own branch');
select is(app.permission_decision(tests.id('salesman_a'), 'sales.create', tests.id('branch_a2')), 'deny',
          'salesman cannot sell at another branch');
select is(app.permission_decision(tests.id('salesman_a'), 'sales.discount', tests.id('branch_a1'), 100), 'needs_approval',
          'salesman discount needs approval (brief matrix)');
select is(app.permission_decision(tests.id('salesman_a'), 'sales.void', tests.id('branch_a1')), 'needs_approval',
          'salesman void needs approval');
select is(app.permission_decision(tests.id('manager_a'), 'sales.discount', tests.id('branch_a1'), 500), 'needs_approval',
          'manager discount with no limit set needs approval (fail closed)');
select is(app.permission_decision(tests.id('manager_a'), 'sales.view_totals', tests.id('branch_a1')), 'deny',
          'manager: sales totals off by default');
select is(app.permission_decision(tests.id('storekeeper_a'), 'sales.create', tests.id('branch_a1')), 'deny',
          'store keeper cannot sell');
select is(app.permission_decision(tests.id('storekeeper_a'), 'stock.adjust', tests.id('branch_a2')), 'allow',
          'store keeper (all branches) can adjust stock at any branch');

-- The owner sets the manager's discount limit to 10% (1000 bp) via the RPC.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select lives_ok(
  format($q$select public.set_role_permission(%L, 'sales.discount', true, false, 1000)$q$,
         (select id from roles where tenant_id = tests.id('tenant_a') and template_code = 'manager')),
  'owner sets manager discount limit');
reset role;
select is(app.permission_decision(tests.id('manager_a'), 'sales.discount', tests.id('branch_a1'), 500), 'allow',
          'manager: 5% within the 10% limit');
select is(app.permission_decision(tests.id('manager_a'), 'sales.discount', tests.id('branch_a1'), 1500), 'needs_approval',
          'manager: 15% over the limit needs approval');

-- Per-person overrides: branch-specific beats all-branches.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select lives_ok(format($q$select public.set_permission_override(%L, 'stock.transfer', true)$q$, tests.id('storekeeper_a')),
                'owner allows transfers for the store keeper everywhere');
select lives_ok(format($q$select public.set_permission_override(%L, 'stock.transfer', false, %L)$q$,
                       tests.id('storekeeper_a'), tests.id('branch_a2')),
                'owner denies transfers for the store keeper at branch A2');
select throws_ok(format($q$select public.set_permission_override(%L, 'sales.view_totals', false)$q$, tests.id('owner_a')),
                 'P0001', null, 'the primary owner cannot be restricted');
reset role;
select is(app.permission_decision(tests.id('storekeeper_a'), 'stock.transfer', tests.id('branch_a1')), 'allow',
          'override allows at A1');
select is(app.permission_decision(tests.id('storekeeper_a'), 'stock.transfer', tests.id('branch_a2')), 'deny',
          'branch-specific deny wins at A2');

-- A disabled person can do nothing.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select lives_ok(format($q$select public.disable_user(%L, 'left the job')$q$, tests.id('salesman_a')),
                'owner disables the salesman');
reset role;
select is(app.permission_decision(tests.id('salesman_a'), 'sales.create', tests.id('branch_a1')), 'deny',
          'disabled salesman cannot sell');

-- branches_with() for a counter: its own branch, counter-safe permissions only.
select tests.as_device(tests.id('auth_device_a1'));
select is(app.branches_with('stock.view'), array[tests.id('branch_a1')], 'counter: stock.view at its branch');
select is(app.branches_with('product.view_cost'), '{}'::uuid[], 'counter: never cost');
select is(app.branches_with('sales.view_totals'), '{}'::uuid[], 'counter: never sales totals');
reset role;

select * from finish();
rollback;
