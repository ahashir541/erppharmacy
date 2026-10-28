-- Phase 2 acceptance: importing 10,000 products works (and re-importing the
-- same file changes nothing).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();


select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('first', public.import_products(tests.import_file()));
select is((tests.kept('first') ->> 'created')::int, 10000, 'all 10,000 products created');
select is((tests.kept('first') ->> 'error_count')::int, 0, 'no errors');
select is((tests.kept('first') ->> 'prices_set')::int, 10000, 'a retail price for each');
reset role;

select is((select count(*) from products where tenant_id = tests.id('tenant_a') and brand_name like 'Medicine %'),
          10000::bigint, '10,000 products in the catalogue');
select is((select count(*) from product_units pu join products p on p.id = pu.product_id
           where p.brand_name like 'Medicine %'), 30000::bigint, 'tablet, strip and box for each');
select is((select count(*) from generics where tenant_id = tests.id('tenant_a') and name like 'Generic %'),
          300::bigint, 'generics created once each');
select is((select count(*) from manufacturers where tenant_id = tests.id('tenant_a') and name like 'Maker %'),
          40::bigint, 'manufacturers created once each');
select is((select count(*) from products where tenant_id = tests.id('tenant_a') and is_controlled),
          20::bigint, 'controlled flag read from yes/no');
select is((select pp.amount from product_prices pp join barcodes b on b.product_id = pp.product_id
           join product_units pu on pu.id = pp.product_unit_id join units u on u.id = pu.unit_id
           where b.code = '899000000042' and u.code = 'strip'), 920::bigint,
          'price stored on the strip, in paisa');
select is((select count(*) from products where tenant_id = tests.id('tenant_b') and brand_name like 'Medicine %'),
          0::bigint, 'nothing landed in pharmacy B');

-- Same file again: nothing changes.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('second', public.import_products(tests.import_file()));
select is((tests.kept('second') ->> 'created')::int, 0, 're-import creates nothing');
select is((tests.kept('second') ->> 'updated')::int, 0, 're-import updates nothing');
select is((tests.kept('second') ->> 'prices_set')::int, 0, 're-import sets no prices');
select is((tests.kept('second') ->> 'unchanged')::int, 10000, 're-import: 10,000 unchanged');

-- A corrected file: 2 new prices, 1 new rack location.
select tests.keep('third', public.import_products(jsonb_build_array(
  jsonb_build_object('brand_name', 'Medicine 1', 'barcode', '899000000001', 'retail_price', 777, 'retail_unit', 'strip'),
  jsonb_build_object('brand_name', 'Medicine 2', 'strength', '300 mg', 'manufacturer', 'Maker 2', 'retail_price', 888,
                     'retail_unit', 'strip', 'rack', 'A-12'))));
select is((tests.kept('third') ->> 'prices_set')::int, 2, 'changed prices are added to the history');
select is((tests.kept('third') ->> 'updated')::int, 1, 'new rack location applied');
select is((tests.kept('third') ->> 'created')::int, 0, 'matched by barcode and by brand + strength + maker');

-- Problems are reported per row; good rows still import.
select tests.keep('bad', public.import_products(jsonb_build_array(
  jsonb_build_object('brand_name', 'Good One', 'retail_price', 100),
  jsonb_build_object('brand_name', ''),
  jsonb_build_object('brand_name', 'Bad Price', 'retail_price', '12.50'),
  jsonb_build_object('brand_name', 'Bad Unit', 'units', jsonb_build_array(jsonb_build_object('unit', 'strip', 'factor', 1))),
  jsonb_build_object('brand_name', 'Taken Barcode', 'barcode', '899000000005'),
  jsonb_build_object('brand_name', 'Bad Tax', 'tax_category', 'luxury'),
  jsonb_build_object('brand_name', 'Medicine 7', 'strength', '300 mg', 'manufacturer', 'Maker 7', 'base_unit', 'bottle'),
  jsonb_build_object('brand_name', 'Twice', 'retail_price', 100),
  jsonb_build_object('brand_name', 'Twice', 'retail_price', 200))));
select is((tests.kept('bad') ->> 'created')::int, 2, 'the good rows import');
select is((tests.kept('bad') ->> 'error_count')::int, 6, 'six rows rejected');
select is((tests.kept('bad') ->> 'duplicates_skipped')::int, 1, 'a row listed twice: the last one wins');
select is((select jsonb_agg(e -> 'row' order by (e ->> 'row')::int) from jsonb_array_elements(tests.kept('bad') -> 'errors') e),
          '[2, 3, 4, 5, 6, 7]'::jsonb, 'errors point at the right rows');
reset role;
select is((select pp.amount from product_prices pp join products p on p.id = pp.product_id
           where p.brand_name = 'Twice'), 200::bigint, 'last duplicate row wins');

-- Too big, or not allowed.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($q$select public.import_products((select jsonb_agg(jsonb_build_object('brand_name', 'x' || g))
                                                   from generate_series(1, 10001) g))$q$,
                 '22023', null, 'more than 10,000 rows per call is refused');
select tests.as_device(tests.id('auth_device_a1'));
select throws_ok($q$select public.import_products('[{"brand_name":"x"}]')$q$, '42501', null,
                 'a PC with nobody signed in cannot import');
select lives_ok(format($q$select public.start_staff_session(%L, %L)$q$, tests.id('salesman_a'), tests.id('sess_salesman')),
                'salesman signs in on the PC');
select throws_ok(format($q$select public.import_products('[{"brand_name":"x"}]', %L)$q$, tests.id('sess_salesman')),
                 '42501', null, 'a salesman cannot import products');

-- Prices: bulk +5% by manufacturer, rounded half-up to the paisa.
reset role;
insert into manufacturers (id, tenant_id, name) values (tests.id('maker_gsk'), tests.id('tenant_a'), 'GSK');
update products set manufacturer_id = tests.id('maker_gsk') where id = tests.id('product_a');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select is((public.bulk_price_change(500, 'company price list 2026', tests.id('maker_gsk')) ->> 'prices_changed')::int, 1,
          'bulk change touches the one GSK price');
reset role;
select is((select amount from current_product_prices where product_unit_id = tests.id('product_unit_a') and price_kind = 'retail'),
          263::bigint, 'Rs 2.50 + 5% = Rs 2.625, rounded half-up to Rs 2.63');
select is((select count(*) from product_prices where product_unit_id = tests.id('product_unit_a') and price_kind = 'retail'),
          2::bigint, 'the old price stays in the history');

select tests.as_device(tests.id('auth_device_a1'));
select throws_ok(format($q$select public.set_price(%L, 'trade', 100, 'x', null, %L)$q$,
                        tests.id('product_unit_a'), tests.id('sess_salesman')),
                 '42501', null, 'a salesman cannot change prices');
reset role;

select * from finish();
rollback;
