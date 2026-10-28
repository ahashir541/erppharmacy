-- Phase 1 acceptance: pharmacy A can never read pharmacy B (and vice versa),
-- checked across every table and view that has a tenant_id.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select ok(tests.count_rows('products') > 0, 'owner A sees their own products');
select is(tests.leaking_tables(tests.id('tenant_b')), '', 'owner A sees nothing of pharmacy B in any table');
select is(tests.count_rows('tenants'), 1::bigint, 'owner A sees only their own tenant row');

select tests.as_owner(tests.id('auth_owner_b'), tests.id('tenant_b'));
select ok(tests.count_rows('products') > 0, 'owner B sees their own products');
select is(tests.leaking_tables(tests.id('tenant_a')), '', 'owner B sees nothing of pharmacy A in any table');

-- Owner B puts pharmacy A's id in their token: membership is re-checked.
select tests.as_owner(tests.id('auth_owner_b'), tests.id('tenant_a'));
select is(tests.leaking_tables(tests.id('tenant_a')), '', 'a forged tenant_id claim gives nothing');
select is(tests.count_rows('products'), 0::bigint, 'a forged tenant_id claim sees no products');

-- Owner A without 2FA (aal1) sees nothing at all.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'), 'aal1');
select is(tests.count_rows('products'), 0::bigint, 'owner without 2FA sees no data');

-- A counter PC of pharmacy A sees nothing of pharmacy B.
select tests.as_device(tests.id('auth_device_a1'));
select ok(tests.count_rows('products') > 0, 'counter A1 sees products');
select is(tests.leaking_tables(tests.id('tenant_b')), '', 'counter A1 sees nothing of pharmacy B');

-- The platform owner sees tenants, but no pharmacy business data.
select tests.as_admin(tests.id('auth_admin'));
select ok(tests.count_rows('tenants') >= 2, 'platform admin sees tenant list');
select is(tests.leaking_tables(tests.id('tenant_a')), '', 'platform admin sees no pharmacy A business data');
select is(tests.leaking_tables(tests.id('tenant_b')), '', 'platform admin sees no pharmacy B business data');

-- Not signed in.
reset role;
select set_config('request.jwt.claims', '', true);
select set_config('role', 'anon', true);
select throws_ok('select count(*) from public.products', '42501', null, 'anonymous visitors cannot read tables');

-- Clients cannot write tables directly, even their own tenant's.
reset role;
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok(
  format($q$insert into public.suppliers (tenant_id, name) values (%L, 'x')$q$, tests.id('tenant_a')),
  '42501', null, 'owner cannot insert into a table directly');
select throws_ok('update public.products set brand_name = ''x''', '42501', null,
                 'owner cannot update a table directly');

-- Tables added by future migrations do not inherit client write access.
reset role;
create table public.zz_future_table (id int, tenant_id uuid);
select ok(not has_table_privilege('anon', 'public.zz_future_table', 'select'),
          'future tables: anonymous visitors get nothing');
select ok(not has_table_privilege('authenticated', 'public.zz_future_table', 'insert'),
          'future tables: clients cannot insert directly');
select throws_ok('select app.assert_rls_everywhere()', 'P0001', null,
                 'a future table without RLS fails the migration check');

select * from finish();
rollback;
