-- Phase 6: owner control and finance. Approvals to the owner, alerts, expenses, salaries and
-- advances, the dashboard and reports; and a counter PC sees no totals anywhere.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

insert into bank_accounts (id, tenant_id, kind, name) values (tests.id('bank_a'), tests.id('tenant_a'), 'bank', 'Meezan current');
insert into user_pins (user_id, tenant_id, pin_hash)
values (tests.id('owner_a'), tests.id('tenant_a'), 'pbkdf2-sha256$600000$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=');

-- ---- Approvals ----
select tests.as_device(tests.id('auth_device_a1'));
select public.start_staff_session(tests.id('salesman_a'), tests.id('sess_s'));
select throws_ok($$select public.request_approval('{"kind": "other", "permission_code": "sales.create"}', tests.id('sess_s'))$$,
                 'P0001', 'No approval is needed for this', 'no request for something already allowed');
select throws_ok($$select public.request_approval('{"kind": "other", "permission_code": "payables.pay"}', tests.id('sess_s'))$$,
                 '42501', null, 'no request for something not allowed at all');
select tests.keep('ap1', to_jsonb(public.request_approval(jsonb_build_object('id', tests.id('ap1'), 'kind', 'discount',
  'permission_code', 'sales.discount', 'amount', 500, 'details', jsonb_build_object('summary', 'Rs 5 off for Khan sahib')), tests.id('sess_s'))));
select throws_ok($$select public.decide_approval(tests.id('ap1'), true)$$, '42501', null, 'a counter PC cannot decide');
reset role;
select is((select count(*) from notifications where kind = 'approval' and reference_id = tests.id('ap1') and user_id = tests.id('owner_a')),
          1::bigint, 'the owner gets the request at once');
select ok((select body from notifications where reference_id = tests.id('ap1')) like '%Salesman A%Rs 5.00%Khan sahib%',
          'it says who, how much and why');

select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.decide_approval(tests.id('ap1'), true, 'ok');
select throws_ok($$select public.decide_approval(tests.id('ap1'), false)$$, 'P0001', null, 'decided only once');
reset role;
select is((select status || '/' || decided_via from approval_requests where id = tests.id('ap1')), 'approved/app', 'approved from the phone');

-- The owner types their PIN at the counter instead.
select tests.as_device(tests.id('auth_device_a1'));
select public.request_approval(jsonb_build_object('id', tests.id('ap2'), 'kind', 'void', 'permission_code', 'sales.void'), tests.id('sess_s'));
select throws_ok($$select public.approve_at_counter(tests.id('ap2'), tests.id('salesman_a'), tests.id('sess_s'))$$,
                 '42501', null, 'the salesman cannot approve their own request');
select lives_ok($$select public.approve_at_counter(tests.id('ap2'), tests.id('owner_a'), tests.id('sess_s'))$$, 'the owner''s PIN approves it');
reset role;
select is((select decided_by from approval_requests where id = tests.id('ap2')), tests.id('owner_a'), 'recorded as the owner''s decision');
select is((select decided_via from approval_requests where id = tests.id('ap2')), 'counter_pin', 'made at the counter');

-- ---- Alerts ----
update drawer_session_reconciliations set variance = -20000 where drawer_session_id = tests.id('drawer_session_a1');
select is((select count(*) from notifications where kind = 'cash_short'), 1::bigint, 'Rs 200 short tells the owner');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.set_alert_rule('cash_short', true, 50000);
reset role;
update drawer_session_reconciliations set variance = -30000 where drawer_session_id = tests.id('drawer_session_a1');
select is((select count(*) from notifications where kind = 'cash_short'), 1::bigint, 'below the owner''s Rs 500 threshold: quiet');
insert into sync_flags (tenant_id, branch_id, kind, reference_type, reference_id, details)
values (tests.id('tenant_a'), tests.id('branch_a1'), 'over_credit_limit', 'sale', tests.id('sale_a1'), '{"message": "Khan family is over the limit"}');
select is((select title from notifications where kind = 'sync_flag'), 'Udhaar over limit', 'flags reach the owner');

-- ---- Expenses ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('e1', to_jsonb(public.post_expense(jsonb_build_object('branch_id', tests.id('branch_a1'), 'category', 'tea and refreshments',
  'description', 'Tea for the shop', 'amount', 15000, 'paid_from', 'drawer', 'drawer_session_id', tests.id('drawer_session_a1')))));
select public.post_expense(jsonb_build_object('branch_id', tests.id('branch_a1'), 'category', 'Electricity', 'description', 'K-Electric bill',
  'amount', 1200000, 'paid_from', 'bank_account', 'bank_account_id', tests.id('bank_a')));
select throws_ok($$select public.post_expense(jsonb_build_object('branch_id', tests.id('branch_a1'), 'category', 'Holidays',
  'description', 'x', 'amount', 100, 'paid_from', 'unpaid'))$$, '22023', null, 'the category must exist');
reset role;
select is((select balance from money_balances where account_id = tests.id('drawer_session_a1')), 485000::bigint, 'Rs 150 tea from the drawer');
select is((select balance from money_balances where account_id = tests.id('bank_a')), -1200000::bigint, 'Rs 12,000 electricity from the bank');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.void_expense((tests.kept('e1') #>> '{}')::uuid, 'entered twice');
select public.save_recurring_expense(jsonb_build_object('branch_id', tests.id('branch_a1'), 'category', 'Rent', 'description', 'Shop rent',
  'amount', 8000000, 'frequency', 'monthly', 'next_due_on', current_date - 40));
select is(public.post_due_recurring_expenses(current_date), 2, 'two months of rent are due');
select is(public.post_due_recurring_expenses(current_date), 0, 'and not again');
reset role;
select is((select balance from money_balances where account_id = tests.id('drawer_session_a1')), 500000::bigint, 'the voided tea goes back in the drawer');
select is((select count(*) from expenses where description = 'Shop rent' and paid_from = 'unpaid'), 2::bigint, 'rent waits to be paid');

-- ---- Salaries and advances ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.set_salary_rate(tests.id('salesman_a'), 3000000, (date_trunc('month', current_date) - interval '2 months')::date);
select public.give_staff_advance(jsonb_build_object('user_id', tests.id('salesman_a'), 'amount', 500000, 'recovery_per_month', 200000,
  'given_on', (date_trunc('month', current_date) - interval '2 months')::date, 'bank_account_id', tests.id('bank_a')));
select tests.keep('pay1', public.pay_salary(jsonb_build_object('user_id', tests.id('salesman_a'),
  'month', (date_trunc('month', current_date) - interval '1 month')::date, 'bank_account_id', tests.id('bank_a'))));
select throws_ok(format($q$select public.pay_salary(jsonb_build_object('user_id', %L, 'month', %L, 'bank_account_id', %L))$q$,
  tests.id('salesman_a'), (date_trunc('month', current_date) - interval '1 month')::date, tests.id('bank_a')),
  'P0001', null, 'a month is paid once');
select is((public.salary_preview(tests.id('salesman_a'), current_date) ->> 'advance_recovery')::bigint, 200000::bigint,
          'next month takes the next Rs 2,000');
reset role;
select is((tests.kept('pay1') ->> 'net_amount')::bigint, 2800000::bigint, 'Rs 30,000 less Rs 2,000 back on the advance');
select is((select balance from money_balances where account_id = tests.id('bank_a')), -4500000::bigint,
          'bank: electricity Rs 12,000 + advance Rs 5,000 + salary Rs 28,000');

-- ---- Dashboard and reports (the fixture's Rs 10 sale, cost Rs 3.64) ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('dash', public.owner_dashboard());
select tests.keep('sales', (select to_jsonb(r) from public.report_sales(current_date, current_date, 'product') r));
select tests.keep('profit', (select to_jsonb(r) from public.report_profit(current_date, current_date, 'product') r));
select tests.keep('pl', public.report_profit_and_loss(date_trunc('month', current_date - 62)::date, current_date));
select tests.keep('tb', public.trial_balance());
select tests.keep('stock', (select to_jsonb(r) from public.report_stock_valuation() r));
select tests.keep('staff', (select to_jsonb(r) from public.report_staff(current_date, current_date) r where r.user_id = tests.id('salesman_a')));
select ok((select count(*) from public.activity_feed()) > 0, 'the activity feed shows what staff did');
select ok((select count(*) from public.report_payments(current_date, current_date)) > 0, 'sales by payment method');
select ok((select count(*) from public.report_purchases(current_date - 30, current_date)) >= 0, 'purchases report runs');
select ok((select count(*) from public.report_collections(current_date - 30, current_date)) >= 0, 'collections report runs');
select ok((select count(*) from public.report_dead_stock(90)) >= 0, 'dead stock report runs');
select is((select count(*) from owner_sales), 1::bigint, 'the owner reads full bills through owner_sales');
select is((select grand_total from owner_sales), 1000::bigint, 'with their totals');
reset role;
select is((tests.kept('dash') #>> '{periods,today,sales}')::bigint, 1000::bigint, 'dashboard: Rs 10 sold today');
select is((tests.kept('dash') #>> '{periods,today,gross_profit}')::bigint, 636::bigint, 'dashboard: Rs 6.36 profit');
select is((tests.kept('dash') ->> 'udhaar_receivable')::bigint, 200000::bigint, 'dashboard: Rs 2,000 udhaar to collect');
select is((tests.kept('dash') ->> 'supplier_payable')::bigint, 500000::bigint, 'dashboard: Rs 5,000 owed to suppliers');
select is((tests.kept('sales') ->> 'sales')::bigint, 1000::bigint, 'sales report');
select is((tests.kept('profit') ->> 'gross_profit')::bigint, 636::bigint, 'profit report');
select is((tests.kept('profit') ->> 'margin_bp')::bigint, 6360::bigint, 'margin 63.6%');
select is((tests.kept('pl') ->> 'net_profit')::bigint, 636 - 1200000 - 16000000 - 3000000::bigint,
          'profit and loss: Rs 6.36 profit, less electricity, two months'' rent and one salary');
select is((tests.kept('staff') ->> 'sales')::bigint, 1000::bigint, 'staff report: the salesman sold Rs 10');
select is((select sum((x ->> 'debit')::bigint) from jsonb_array_elements(tests.kept('tb') -> 'lines') x),
          (select sum((x ->> 'credit')::bigint) from jsonb_array_elements(tests.kept('tb') -> 'lines') x), 'the trial balance balances');
select is((select (x ->> 'debit')::bigint from jsonb_array_elements(tests.kept('tb') -> 'lines') x where x ->> 'account' = 'Stock (at cost)'),
          (tests.kept('stock') ->> 'cost_value')::bigint, 'stock in the trial balance = stock valuation');

-- ---- Nothing for the counter ----
select tests.as_device(tests.id('auth_device_a1'));
select throws_ok($$select public.owner_dashboard()$$, '42501', null, 'counter: no dashboard');
select throws_ok($$select * from public.report_sales(current_date, current_date)$$, '42501', null, 'counter: no sales report');
select throws_ok($$select * from public.report_profit(current_date, current_date)$$, '42501', null, 'counter: no profit report');
select throws_ok($$select public.report_profit_and_loss(current_date, current_date)$$, '42501', null, 'counter: no profit and loss');
select throws_ok($$select * from public.report_staff(current_date, current_date)$$, '42501', null, 'counter: no staff report');
select throws_ok($$select public.trial_balance()$$, '42501', null, 'counter: no trial balance');
select throws_ok($$select * from public.report_stock_valuation()$$, '42501', null, 'counter: no stock value');
select throws_ok($$select * from public.activity_feed()$$, '42501', null, 'counter: no activity feed');
select is((select count(*) from owner_sales), 0::bigint, 'counter: owner_sales is empty');
select throws_ok($$select sum(grand_total) from sales$$, '42501', null, 'counter: bill totals cannot be added up');
select throws_ok($$select sum(amount) from sale_payments$$, '42501', null, 'counter: payments cannot be added up');
select ok(public.get_receipt(tests.id('sale_a1')) ->> 'grand_total' = '1000', 'but one bill''s receipt still prints');
reset role;

-- A manager with no totals permission (the default) sees no totals either.
select is(app.permission_decision(tests.id('manager_a'), 'sales.view_totals', tests.id('branch_a1')), 'deny', 'managers: totals off by default');

-- Another pharmacy sees nothing of A.
select tests.as_owner(tests.id('auth_owner_b'), tests.id('tenant_b'));
select is((tests.kept('dash') is not null), true, 'setup');
select is((public.owner_dashboard() #>> '{periods,today,sales}')::bigint, 0::bigint, 'pharmacy B: no sales of A');
select is((select count(*) from owner_sales), 0::bigint, 'pharmacy B: no bills of A');
reset role;

select * from finish();
rollback;
