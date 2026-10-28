-- Phase 2 acceptance: stock always equals the sum of movements. Plus opening
-- stock, adjustments, write-offs, blind counts and the expiry dashboard.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

-- ---- Opening stock by the owner (with cost) ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select lives_ok(format($q$select public.receive_opening_stock(%L, jsonb_build_array(
    jsonb_build_object('product_id', %L, 'batch_number', 'n555', 'expiry_date', (current_date + 20)::text,
                       'qty', 3, 'unit', 'tablet', 'total_cost', 300),
    jsonb_build_object('product_id', %L, 'batch_number', 'OLD1', 'expiry_date', (current_date - 5)::text,
                       'qty', 7)))$q$,
  tests.id('branch_a1'), tests.id('product_a'), tests.id('product_a')), 'owner enters opening stock');
reset role;
select is((select qty_base from stock_balances sb join batches b on b.id = sb.batch_id
           where sb.branch_id = tests.id('branch_a1') and b.batch_number = 'N555'), 3::bigint,
          'opening stock is on the shelf (batch number upper-cased)');
select is((select total_cost from batch_cost_layers l join batches b on b.id = l.batch_id where b.batch_number = 'N555'),
          300::bigint, 'opening cost recorded as a cost layer');

-- ---- Staff on the PC ----
select tests.as_device(tests.id('auth_device_a1'));
select lives_ok(format($q$select public.start_staff_session(%L, %L)$q$, tests.id('storekeeper_a'), tests.id('sess_keeper')),
                'store keeper signs in at counter A1');
select lives_ok(format($q$select public.start_staff_session(%L, %L)$q$, tests.id('salesman_a'), tests.id('sess_salesman')),
                'salesman signs in at counter A1');
select throws_ok(format($q$select public.receive_opening_stock(%L, jsonb_build_array(jsonb_build_object(
                   'product_id', %L, 'batch_number', 'X1', 'expiry_date', '2030-01-01', 'qty', 1, 'total_cost', 5)), %L)$q$,
                 tests.id('branch_a1'), tests.id('product_a'), tests.id('sess_keeper')),
                 '42501', null, 'store keeper cannot enter costs (no product.view_cost)');
select lives_ok(format($q$select public.adjust_stock(%L, %L, 2, 'found behind the shelf', null, %L)$q$,
                       tests.id('branch_a1'), tests.id('batch_a'), tests.id('sess_keeper')),
                'store keeper adjusts stock');
select throws_ok(format($q$select public.adjust_stock(%L, %L, -1000, 'oops', null, %L)$q$,
                        tests.id('branch_a1'), tests.id('batch_a'), tests.id('sess_keeper')),
                 'P0001', null, 'cannot adjust below zero');
select throws_ok(format($q$select public.adjust_stock(%L, %L, 1, 'x', null, %L)$q$,
                        tests.id('branch_a1'), tests.id('batch_a'), tests.id('sess_salesman')),
                 '42501', null, 'salesman cannot adjust stock');
select throws_ok(format($q$select public.adjust_stock(%L, %L, 1, 'x', null, %L)$q$,
                        tests.id('branch_a2'), tests.id('batch_a'), tests.id('sess_keeper')),
                 'P0002', null, 'a PC cannot touch another branch');
select throws_ok(format($q$select public.write_off_stock(%L, %L, 1, 'expire', 'expired', %L)$q$,
                        tests.id('branch_a1'), tests.id('batch_a'), tests.id('sess_keeper')),
                 '42501', null, 'store keeper has no expiry write-off permission by default');

-- Daily adjustment limit: 2 per day, then approval is needed.
reset role;
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.set_permission_override(tests.id('storekeeper_a'), 'stock.adjust', true, null, false, 2);
select tests.as_device(tests.id('auth_device_a1'));
select lives_ok(format($q$select public.adjust_stock(%L, %L, 1, 'second today', null, %L)$q$,
                       tests.id('branch_a1'), tests.id('batch_a'), tests.id('sess_keeper')), 'second adjustment today is fine');
select throws_ok(format($q$select public.adjust_stock(%L, %L, 1, 'third today', null, %L)$q$,
                        tests.id('branch_a1'), tests.id('batch_a'), tests.id('sess_keeper')),
                 'P0001', null, 'third adjustment today needs owner approval');

-- An approved request lets it through, once.
reset role;
insert into approval_requests (id, tenant_id, branch_id, kind, permission_code, status, decided_by, decided_at, created_by)
values (tests.id('approval_1'), tests.id('tenant_a'), tests.id('branch_a1'), 'other', 'stock.adjust', 'approved',
        tests.id('owner_a'), now(), tests.id('storekeeper_a'));
select tests.as_device(tests.id('auth_device_a1'));
select lives_ok(format($q$select public.adjust_stock(%L, %L, 1, 'third, approved', %L, %L)$q$,
                       tests.id('branch_a1'), tests.id('batch_a'), tests.id('approval_1'), tests.id('sess_keeper')),
                'with an approval it goes through');
select throws_ok(format($q$select public.adjust_stock(%L, %L, 1, 'reuse', %L, %L)$q$,
                        tests.id('branch_a1'), tests.id('batch_a'), tests.id('approval_1'), tests.id('sess_keeper')),
                 'P0001', null, 'an approval cannot be used twice');

-- ---- Blind stock count ----
select lives_ok(format($q$select public.start_stock_count(%L, 'cycle', null, %L)$q$, tests.id('branch_a1'), tests.id('sess_keeper')),
                'store keeper starts a cycle count');
reset role;
select tests.as_device(tests.id('auth_device_a1'));
select lives_ok(format($q$select public.record_count((select id from stock_counts where branch_id = %L), %L, 90, %L)$q$,
                       tests.id('branch_a1'), tests.id('batch_a'), tests.id('sess_keeper')), 'counts 90 on the shelf');
select lives_ok(format($q$select public.submit_stock_count((select id from stock_counts where branch_id = %L), %L)$q$,
                       tests.id('branch_a1'), tests.id('sess_keeper')), 'submits the count');
select is(tests.count_rows('stock_count_results'), 0::bigint, 'the PC never sees expected quantity or variance');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select is((public.approve_stock_count((select id from stock_counts where branch_id = tests.id('branch_a1'))) ->> 'corrections')::int,
          1, 'owner approves: one correction posted');
reset role;
-- system had 90 + 2 + 1 + 1 = 94; counted 90
select is((select variance_qty from stock_count_results), -4::bigint, 'variance -4 kept for the owner');
select is((select qty_base from stock_balances where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a')),
          90::bigint, 'shelf and system now agree');

-- ---- Expiry dashboard ----
select tests.as_device(tests.id('auth_device_a1'));
select is((select bucket from expiry_dashboard where batch_number = 'OLD1'), 'expired', 'expired batch shows as expired');
select is((select bucket from expiry_dashboard where batch_number = 'N555'), 'within_30', '20 days left: within 30');
select is((select bucket from expiry_dashboard where batch_number = 'P123'), 'later', 'P123 has over a year');
select is((select qty_base from product_stock where product_id = tests.id('product_a')), 100::bigint,
          'product stock at A1: 90 + 3 + 7');
select is((select sellable_qty_base from product_stock where product_id = tests.id('product_a')), 93::bigint,
          'expired stock is not sellable');
select is((select nearest_expiry from product_stock where product_id = tests.id('product_a')), current_date + 20,
          'nearest sellable expiry shown while typing');
reset role;
insert into global_recalls (brand_name, batch_number, reason) values ('Panadol 500mg', 'N555', 'test recall');
select tests.as_device(tests.id('auth_device_a1'));
select ok((select is_blocked from expiry_dashboard where batch_number = 'N555'), 'recalled batch shows as blocked');
reset role;

-- ---- The ledger rule, under load ----
insert into batches (id, tenant_id, product_id, batch_number, expiry_date)
select tests.id('rand_batch_' || g), tests.id('tenant_a'), tests.id('product_a'), 'R' || g, current_date + 100 + g
from generate_series(1, 20) g;
insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, occurred_at)
select tests.id('tenant_a'),
       case when g % 2 = 0 then tests.id('branch_a1') else tests.id('branch_a2') end,
       tests.id('product_a'),
       tests.id('rand_batch_' || (1 + (g * 7) % 20)),
       (array['opening', 'purchase', 'sale_return', 'transfer_in', 'sale', 'purchase_return',
              'transfer_out', 'expire', 'dispose', 'adjust'])[1 + g % 10],
       case when g % 10 < 4 then 1 + (g * 13) % 50
            when g % 10 = 9 then (g % 7) - 3 + case when g % 7 = 3 then 1 else 0 end
            else -(1 + (g * 11) % 30) end,
       now() - make_interval(mins => g)
from generate_series(1, 3000) g;
select is((select count(*) from app.stock_balance_mismatches(tests.id('tenant_a'))), 0::bigint,
          'after 3,000 mixed movements: every cached balance = sum of its movements');
select is((select count(*) from app.stock_balance_mismatches()), 0::bigint, 'same for every pharmacy');

-- If a cache is ever damaged, the self-check finds it and the repair fixes it.
update stock_balances set qty_base = qty_base + 999 where batch_id = tests.id('batch_a') and branch_id = tests.id('branch_a1');
select is((select count(*) from app.stock_balance_mismatches(tests.id('tenant_a'))), 1::bigint, 'damaged cache detected');
select ok(app.rebuild_stock_balances(tests.id('tenant_a')) >= 1, 'repair rebuilds from the ledger');
select is((select count(*) from app.stock_balance_mismatches(tests.id('tenant_a'))), 0::bigint, 'cache matches the ledger again');

select * from finish();
rollback;
