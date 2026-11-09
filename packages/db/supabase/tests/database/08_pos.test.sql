-- Phase 3: the counter sale — bill, FEFO checks, payments, udhaar, returns,
-- voids, blind drawer closing, receipt, and offline re-validation flags.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

-- A bill as the counter app builds it.
create or replace function tests.bill(p_id text, p_seq int, p_qty int, p_price int, p_extra jsonb default '{}',
                                      p_batch uuid default tests.id('batch_a'))
returns jsonb language sql as $$
  select jsonb_build_object(
    'id', tests.id(p_id), 'local_seq', p_seq, 'drawer_session_id', tests.id('drawer_session_a1'),
    'lines', jsonb_build_array(jsonb_build_object('id', tests.id(p_id || ':line'), 'product_unit_id', tests.id('product_unit_a'),
                                                  'batch_id', p_batch, 'qty', p_qty, 'unit_price', p_price)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'tendered', p_qty * p_price))) || p_extra
$$;
grant execute on function tests.bill(text, int, int, int, jsonb, uuid) to authenticated;

select tests.as_device(tests.id('auth_device_a1'));
select lives_ok(format($q$select public.start_staff_session(%L, %L)$q$, tests.id('salesman_a'), tests.id('sess_s')), 'salesman signs in');

-- ---- A plain cash sale ----
select tests.keep('s1', public.post_sale(
  tests.bill('t1', 2, 4, 250, jsonb_build_object('grand_total', 1000,
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'tendered', 1500)))), tests.id('sess_s')));
reset role;
select is(tests.kept('s1') ->> 'invoice_number', 'KHI1-C1-000002', 'invoice number = branch + counter + sequence');
select is((tests.kept('s1') ->> 'change')::int, 500, 'change from Rs 15 for a Rs 10 bill');
select is(tests.kept('s1') -> 'flags', '[]'::jsonb, 'nothing to flag');
select is((select qty_base from stock_balances where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a')), 86::bigint,
          'stock goes down by 4 (90 → 86)');
select is((select sum(amount) from cash_movements where drawer_session_id = tests.id('drawer_session_a1')), 501000::numeric,
          'Rs 10 cash into the drawer (opening float Rs 5,000)');
select is((select cogs from sale_line_costs where sale_line_id = tests.id('t1:line')), 364::bigint,
          'cost of goods: 4 x weighted average (Rs 100 / 110 tablets)');
select ok(exists (select 1 from audit_log where table_name = 'sales' and record_id = tests.id('t1') and user_id = tests.id('salesman_a')),
          'sale is in the audit log under the salesman');

-- The same upload again (a retry after a timeout) does nothing twice.
select tests.as_device(tests.id('auth_device_a1'));
select is((public.post_sale(tests.bill('t1', 2, 4, 250), tests.id('sess_s')) ->> 'duplicate')::boolean, true, 'a retry is recognised');
reset role;
select is((select qty_base from stock_balances where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a')), 86::bigint,
          'a retry does not take stock twice');

-- ---- Speed: a 5-item bill is recorded well inside the brief's 10 seconds ----
select tests.as_device(tests.id('auth_device_a1'));
select set_config('tests.t0', clock_timestamp()::text, true);
select public.post_sale(jsonb_build_object(
  'id', tests.id('t6'), 'local_seq', 6, 'drawer_session_id', tests.id('drawer_session_a1'),
  'lines', (select jsonb_agg(jsonb_build_object('product_unit_id', tests.id('product_unit_a'), 'batch_id', tests.id('batch_a'), 'qty', 1, 'unit_price', 250))
            from generate_series(1, 5)),
  'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'tendered', 1300))), tests.id('sess_s'));
select ok(clock_timestamp() - current_setting('tests.t0')::timestamptz < interval '2 seconds', 'a 5-item sale is recorded in under 2 seconds');
reset role;
select is((select count(*) from sale_lines where sale_id = tests.id('t6')), 5::bigint, 'five lines on the bill');

-- ---- What a salesman may not do ----
select tests.as_device(tests.id('auth_device_a1'));
select throws_ok(format($q$select public.post_sale(tests.bill('t2', 3, 1, 200), %L)$q$, tests.id('sess_s')),
                 '42501', null, 'a salesman cannot change the price');
select throws_ok(format($q$select public.post_sale(tests.bill('t2', 3, 4, 250, '{"bill_discount": 100}'), %L)$q$, tests.id('sess_s')),
                 'P0001', 'Owner approval is needed for this', 'a salesman discount needs the owner''s approval');
select throws_ok(format($q$select public.post_sale(tests.bill('t2', 3, 1000, 250), %L)$q$, tests.id('sess_s')),
                 '42501', null, 'cannot sell more than the shelf has');
reset role;
insert into approval_requests (id, tenant_id, branch_id, kind, permission_code, status, decided_by, decided_at, created_by) values
  (tests.id('ap_discount'), tests.id('tenant_a'), tests.id('branch_a1'), 'discount', 'sales.discount', 'approved', tests.id('owner_a'), now(), tests.id('salesman_a'));
select tests.as_device(tests.id('auth_device_a1'));
select is((public.post_sale(tests.bill('t2', 3, 4, 250, jsonb_build_object('bill_discount', 100,
          'approvals', jsonb_build_object('discount', tests.id('ap_discount')),
          'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'tendered', 900)))), tests.id('sess_s')) ->> 'grand_total')::int,
          900, 'with the approval: Rs 10 less Re 1 discount');
reset role;
select ok((select used_at is not null from approval_requests where id = tests.id('ap_discount')), 'the approval is used up');

-- Expired stock is never sold.
insert into batches (id, tenant_id, product_id, batch_number, expiry_date)
values (tests.id('batch_old'), tests.id('tenant_a'), tests.id('product_a'), 'OLD9', current_date - 1);
insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, occurred_at)
values (tests.id('tenant_a'), tests.id('branch_a1'), tests.id('product_a'), tests.id('batch_old'), 'opening', 5, now());
select tests.as_device(tests.id('auth_device_a1'));
select throws_ok(format($q$select public.post_sale(tests.bill('t3', 4, 1, 250, '{}', %L), %L)$q$, tests.id('batch_old'), tests.id('sess_s')),
                 'P0001', null, 'an expired batch cannot be sold');

-- ---- Udhaar: Rs 10 on the Khan family's khata ----
select throws_ok(format($q$select public.post_sale(tests.bill('t4', 4, 4, 250, jsonb_build_object('customer_account_id', %L, 'payments', '[]'::jsonb)), %L)$q$,
                        tests.id('account_a'), tests.id('sess_s')),
                 'P0001', null, 'salesman udhaar starts at a limit of 0: needs approval');
reset role;
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.set_permission_override(tests.id('salesman_a'), 'udhaar.give', true, null, false, 500000);
select tests.as_device(tests.id('auth_device_a1'));
select is((public.post_sale(tests.bill('t4', 4, 4, 250, jsonb_build_object('customer_account_id', tests.id('account_a'), 'payments', '[]'::jsonb)),
          tests.id('sess_s')) ->> 'udhaar')::int, 1000, 'within the owner''s limit: Rs 10 on udhaar');
reset role;
select is((select balance from party_balances where party_id = tests.id('account_a')), 201000::bigint, 'khata balance: Rs 2,000 + Rs 10');
select is((select due_date - entry_date from ledger_entries where reference_id = tests.id('t4')), 30, 'due in 30 days (default)');

-- ---- Return two tablets of the first bill ----
insert into approval_requests (id, tenant_id, branch_id, kind, permission_code, status, decided_by, decided_at, created_by) values
  (tests.id('ap_return'), tests.id('tenant_a'), tests.id('branch_a1'), 'return', 'sales.return', 'approved', tests.id('owner_a'), now(), tests.id('salesman_a')),
  (tests.id('ap_void'), tests.id('tenant_a'), tests.id('branch_a1'), 'void', 'sales.void', 'approved', tests.id('owner_a'), now(), tests.id('salesman_a'));
select tests.as_device(tests.id('auth_device_a1'));
select is((public.post_return(jsonb_build_object('id', tests.id('r1'), 'local_seq', 1, 'original_sale_id', tests.id('t1'),
          'refund_method', 'cash', 'reason', 'customer bought too many', 'drawer_session_id', tests.id('drawer_session_a1'),
          'approval', tests.id('ap_return'),
          'lines', jsonb_build_array(jsonb_build_object('sale_line_id', tests.id('t1:line'), 'qty_base', 2))), tests.id('sess_s')) ->> 'refund_total')::int,
          500, 'refund: Rs 10 x 2 / 4 = Rs 5');
select throws_ok(format($q$select public.post_return(jsonb_build_object('id', %L, 'local_seq', 2, 'original_sale_id', %L,
                  'refund_method', 'cash', 'reason', 'again', 'drawer_session_id', %L,
                  'lines', jsonb_build_array(jsonb_build_object('sale_line_id', %L, 'qty_base', 3))), %L)$q$,
                  tests.id('r2'), tests.id('t1'), tests.id('drawer_session_a1'), tests.id('t1:line'), tests.id('sess_s')),
                 'P0001', null, 'cannot return more than was sold');
-- ---- Void the discounted bill ----
select lives_ok(format($q$select public.void_sale(%L, 'wrong customer', %L, %L)$q$, tests.id('t2'), tests.id('ap_void'), tests.id('sess_s')),
                'void with the owner''s approval');
reset role;
-- 86 after t1, -5 t6, -4 t2, -4 t4, +2 return, +4 void = 79
select is((select qty_base from stock_balances where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a')), 79::bigint,
          'returns and voids put the stock back on its batch');
select is((select status from sales where id = tests.id('t2')), 'voided', 'the bill is marked void, not deleted');

-- ---- Blind drawer closing ----
select tests.as_device(tests.id('auth_device_a1'));
-- expected = 5,000 + 10 + 13 (12.50 rounded to Re 1) + 9 - 5 - 9 = 5,018; the salesman counts Rs 5,017
select lives_ok(format($q$select public.close_drawer(%L, 501700, null, %L)$q$, tests.id('drawer_session_a1'), tests.id('sess_s')),
                'salesman closes the drawer with the counted cash');
select is(tests.count_rows('drawer_session_reconciliations'), 0::bigint, 'the counter never sees expected cash or the difference');
reset role;
select is((select variance from drawer_session_reconciliations where drawer_session_id = tests.id('drawer_session_a1')), -100::bigint,
          'the owner sees Re 1 short');

-- ---- Receipt (no cost on it) ----
select tests.as_device(tests.id('auth_device_a1'));
select is(public.get_receipt(tests.id('t1')) -> 'lines' -> 0 ->> 'name', 'Panadol 500mg', 'receipt shows the item');
select ok(public.get_receipt(tests.id('t1'))::text not like '%cogs%', 'receipt carries no cost');

-- ---- Offline upload: the medicine already left, so problems become flags ----
reset role;
select tests.keep('off', app.record_sale(tests.bill('t5', 5, 4, 250, '{}', tests.id('batch_old')), tests.id('salesman_a'), 'offline'));
-- (the drawer was closed above, so its cash arriving afterwards is flagged too)
select is((select jsonb_agg(f ->> 'kind') from jsonb_array_elements(tests.kept('off') -> 'flags') f), '["expired_batch", "drawer_closed"]'::jsonb,
          'an offline sale of an expired batch is recorded and flagged, not rejected');
select is((select validation_status from sales where id = tests.id('t5')), 'flagged', 'the sale is marked for the owner');
select ok(exists (select 1 from sync_flags where reference_id = tests.id('t5') and kind = 'expired_batch'), 'the owner gets a flag');

select * from finish();
rollback;
