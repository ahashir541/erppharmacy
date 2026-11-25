-- 0040: the owner fixes a wrong product in place: stock set to what the shelf really has (as
-- adjustments), and a product deleted even with stock (stock goes to 0 first). A salesman cannot.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();
grant execute on all functions in schema tests to authenticated;

select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.set_product_stock(tests.id('branch_a1'), tests.id('product_a'), 7, 'counted wrong');
select is((public.office_product_edit(tests.id('product_a'), tests.id('branch_a1')) ->> 'stock')::bigint, 7::bigint, 'stock set to what the shelf has');
select public.set_product_stock(tests.id('branch_a1'), tests.id('product_a'), 25, 'found a box');
select is((public.office_product_edit(tests.id('product_a'), tests.id('branch_a1')) ->> 'stock')::bigint, 25::bigint, 'raising stock works too');
select ok((select count(*) from stock_movements where product_id = tests.id('product_a') and movement_type = 'adjust') >= 2,
          'every change is a stock movement with its reason');
select throws_ok(format($q$select public.set_product_stock(%L, %L, -1, 'x')$q$, tests.id('branch_a1'), tests.id('product_a')), '22023', null,
                 'stock cannot go below 0');

select tests.as_device(tests.id('auth_device_a1'));
select public.start_staff_session(tests.id('salesman_a'), tests.id('sess_sal'));
select throws_ok(format($q$select public.remove_product(%L, 'x', %L)$q$, tests.id('product_a'), tests.id('sess_sal')), '42501', null,
                 'a salesman cannot delete a product');

select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select lives_ok(format($q$select public.remove_product(%L, 'entered twice')$q$, tests.id('product_a')), 'the owner deletes a product that has stock');
select is((select coalesce(sum(qty_base), 0) from stock_balances where product_id = tests.id('product_a'))::bigint, 0::bigint, 'its stock went to 0 first');
select isnt((select archived_at from products where id = tests.id('product_a')), null, 'the product is archived (old bills keep its name)');

select * from finish();
rollback;
