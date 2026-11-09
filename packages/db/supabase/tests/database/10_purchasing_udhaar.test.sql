-- Phase 5: purchasing and udhaar. Supplier → order → delivery (with bonus) → invoice → return →
-- payments and cheques; a customer's khata from opening balance to reminder. Done when both
-- statements match the ledger to the paisa.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

create or replace function tests.stock(p_batch uuid) returns bigint language sql as $$
  select coalesce((select qty_base from stock_balances where branch_id = tests.id('branch_a1') and batch_id = p_batch), 0)
$$;
create or replace function tests.balance(p_type text, p_party uuid) returns bigint language sql as $$
  select coalesce((select balance from party_balances where party_type = p_type and party_id = p_party), 0)
$$;
create or replace function tests.grn1(p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('id', tests.id('grn1'), 'supplier_id', tests.kept('sup') #>> '{}', 'purchase_order_id', tests.id('po1'),
    'supplier_invoice_number', 'INV-1',
    'lines', jsonb_build_array(jsonb_build_object('id', tests.id('gl1'), 'po_line_id', tests.kept('pol1') #>> '{}',
      'product_unit_id', tests.id('product_unit_a'), 'batch_number', 'g1', 'expiry_date', current_date + 300,
      'qty', 60, 'bonus_qty', 6, 'retail_price', 260) || p_extra))
$$;
grant execute on function tests.grn1(jsonb) to authenticated;
grant execute on all functions in schema tests to authenticated;

insert into bank_accounts (id, tenant_id, kind, name) values (tests.id('bank_a'), tests.id('tenant_a'), 'bank', 'Meezan current');
insert into user_pins (user_id, tenant_id, pin_hash)
values (tests.id('storekeeper_a'), tests.id('tenant_a'), 'pbkdf2-sha256$600000$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=');

-- ---- Supplier and purchase order ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('sup', to_jsonb(public.save_supplier('{"name": "Getz Distributors", "payment_terms_days": 30, "phone": "02100000000"}')));
select throws_ok($$select public.save_supplier('{"name": "getz distributors"}')$$, '23505', null, 'supplier names are unique');
select tests.keep('po', public.create_purchase_order(jsonb_build_object(
  'id', tests.id('po1'), 'branch_id', tests.id('branch_a1'), 'supplier_id', tests.kept('sup') #>> '{}',
  'lines', jsonb_build_array(jsonb_build_object('id', tests.id('pol1'), 'product_unit_id', tests.id('product_unit_a'),
                                                'qty', 100, 'bonus_qty', 10, 'expected_unit_cost', 180)))));
select is(tests.kept('po') ->> 'po_number', 'PO-000001', 'orders are numbered per pharmacy');
select ok(public.send_purchase_order(tests.id('po1'), 'whatsapp') like '%Panadol 500mg%100 + 10 bonus%', 'the WhatsApp order lists the items and bonus');
reset role;
select is((select status from purchase_orders where id = tests.id('po1')), 'sent', 'order marked sent');

-- ---- The store keeper receives the first part, without prices ----
select tests.keep('pol1', to_jsonb((select id from po_lines where purchase_order_id = tests.id('po1'))));
select tests.as_device(tests.id('auth_device_a1'));
select public.start_staff_session(tests.id('storekeeper_a'), tests.id('sess_k'));
select throws_ok($$select public.post_grn(tests.grn1('{"unit_cost": 180}'), tests.id('sess_k'))$$, '42501', null,
                 'a store keeper cannot enter prices');
select throws_ok(format($q$select public.post_grn(jsonb_build_object('supplier_id', %L, 'lines', jsonb_build_array(jsonb_build_object(
  'product_unit_id', %L, 'batch_number', 'old', 'expiry_date', current_date - 1, 'qty', 5))), %L)$q$,
  tests.kept('sup') #>> '{}', tests.id('product_unit_a'), tests.id('sess_k')), 'P0001', null, 'expired goods are refused at the door');
select tests.keep('g1', public.post_grn(tests.grn1(), tests.id('sess_k')));
select is((public.post_grn(tests.grn1(), tests.id('sess_k')) ->> 'duplicate')::boolean, true, 'posting the same delivery twice is recognised');
reset role;
select tests.keep('batch_g1', to_jsonb((select batch_id from grn_lines where id = tests.id('gl1'))));
select is(tests.stock((tests.kept('batch_g1') #>> '{}')::uuid), 66::bigint, '60 paid + 6 bonus are on the shelf, once');
select is((select batch_number from batches where id = (tests.kept('batch_g1') #>> '{}')::uuid), 'G1', 'batch number stored in capitals');
select is((select status from purchase_orders where id = tests.id('po1')), 'partially_received', 'order partly received');
select is((select count(*) from grn_line_costs where grn_line_id = tests.id('gl1')), 0::bigint, 'no prices yet');

-- ---- The owner enters the supplier's invoice ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($$select public.post_purchase_invoice(jsonb_build_object('grn_id', tests.id('grn1'), 'expected_grand_total', 11000,
  'line_costs', jsonb_build_array(jsonb_build_object('grn_line_id', tests.id('gl1'), 'unit_cost', 180))))$$,
  'P0001', 'The invoice says Rs 110.00, but the lines add up to Rs 108.00', 'a total that does not match the paper is refused');
select tests.keep('i1', public.post_purchase_invoice(jsonb_build_object('id', tests.id('inv1'), 'grn_id', tests.id('grn1'),
  'expected_grand_total', 10800, 'line_costs', jsonb_build_array(jsonb_build_object('grn_line_id', tests.id('gl1'), 'unit_cost', 180)))));
reset role;
select is((tests.kept('i1') ->> 'due_date')::date, current_date + 30, 'due date from the supplier''s 30-day terms');
select is(app.batch_cogs((tests.kept('batch_g1') #>> '{}')::uuid, 1), 164::bigint, 'bonus lowers the cost: Rs 108 / 66 = Rs 1.64 a tablet');
select is(tests.balance('supplier', (tests.kept('sup') #>> '{}')::uuid), 10800::bigint, 'we owe Getz Rs 108');

-- ---- The rest arrives, priced, with the invoice and part paid in cash ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('g2', public.post_grn(jsonb_build_object('id', tests.id('grn2'), 'branch_id', tests.id('branch_a1'),
  'supplier_id', tests.kept('sup') #>> '{}', 'purchase_order_id', tests.id('po1'), 'supplier_invoice_number', 'INV-2',
  'lines', jsonb_build_array(jsonb_build_object('id', tests.id('gl2'), 'po_line_id', tests.kept('pol1') #>> '{}',
    'product_unit_id', tests.id('product_unit_a'), 'batch_number', 'G2', 'expiry_date', current_date + 60,
    'qty', 40, 'bonus_qty', 4, 'unit_cost', 180, 'discount_amount', 200)),
  'invoice', jsonb_build_object('id', tests.id('inv2'), 'expected_grand_total', 7000, 'paid_at_receipt', 2000,
    'payment', jsonb_build_object('method', 'cash', 'drawer_session_id', tests.id('drawer_session_a1'))))));
reset role;
select is(tests.kept('g2') -> 'warnings' -> 0 ->> 'kind', 'short_dated', 'a batch expiring in 60 days is flagged as short-dated');
select is((tests.kept('g2') -> 'invoice' ->> 'grand_total')::bigint, 7000::bigint, 'invoice: 40 × Rs 1.80 − Rs 2 discount');
select is((select status from purchase_orders where id = tests.id('po1')), 'received', 'order fully received');
select is((select balance from money_balances where account_id = tests.id('drawer_session_a1')), 498000::bigint,
          'Rs 20 paid from the drawer');
select is(tests.balance('supplier', (tests.kept('sup') #>> '{}')::uuid), 15800::bigint, 'we owe Getz Rs 158');

-- ---- Returning 6 expired-soon tablets ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok(format($q$select public.post_purchase_return(jsonb_build_object('branch_id', %L, 'supplier_id', %L, 'reason', 'expired',
  'lines', jsonb_build_array(jsonb_build_object('batch_id', %L, 'qty_base', 999))))$q$, tests.id('branch_a1'), tests.kept('sup') #>> '{}',
  tests.kept('batch_g1') #>> '{}'), 'P0001', null, 'cannot return more than is in stock');
select tests.keep('r1', public.post_purchase_return(jsonb_build_object('id', tests.id('pr1'), 'branch_id', tests.id('branch_a1'),
  'supplier_id', tests.kept('sup') #>> '{}', 'reason', 'short_dated',
  'lines', jsonb_build_array(jsonb_build_object('batch_id', tests.kept('batch_g1') #>> '{}', 'qty_base', 6)))));
reset role;
select is(tests.stock((tests.kept('batch_g1') #>> '{}')::uuid), 60::bigint, 'stock goes back to the supplier');
select is((select claimed_amount from supplier_claims where reference_id = tests.id('pr1')), 982::bigint,
          'claim at cost: 6 × Rs 108 / 66');
select is(tests.balance('supplier', (tests.kept('sup') #>> '{}')::uuid), 15800::bigint, 'nothing owed changes until the credit note');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.settle_purchase_return(tests.id('pr1'), 'CN-77', 900);
reset role;
select is((select status from supplier_claims where reference_id = tests.id('pr1')), 'partially_settled', 'credited Rs 9 of Rs 9.82');
select is(tests.balance('supplier', (tests.kept('sup') #>> '{}')::uuid), 14900::bigint, 'we owe Getz Rs 149');

-- ---- Paying by cheque against the first invoice; one cheque clears, one bounces ----
-- The Rs 9 credit note already paid part of the oldest invoice, so Rs 99 is what is left on INV-1.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok(format($q$select public.pay_supplier(jsonb_build_object('supplier_id', %L, 'amount', 5000, 'method', 'bank_transfer',
  'bank_account_id', %L, 'allocations', jsonb_build_array(jsonb_build_object('entry_id', %L, 'amount', 20000))))$q$,
  tests.kept('sup') #>> '{}', tests.id('bank_a'), tests.kept('i1') ->> 'ledger_entry_id'), '22023', null,
  'cannot allocate more than the bill''s open amount');
select tests.keep('pay1', public.pay_supplier(jsonb_build_object('id', tests.id('pay1'), 'supplier_id', tests.kept('sup') #>> '{}',
  'amount', 9900, 'method', 'cheque', 'cheque', jsonb_build_object('number', '000123', 'date', current_date, 'bank_account_id', tests.id('bank_a')),
  'allocations', jsonb_build_array(jsonb_build_object('entry_id', tests.kept('i1') ->> 'ledger_entry_id', 'amount', 9900)))));
select is((public.pay_supplier(jsonb_build_object('id', tests.id('pay1'), 'supplier_id', tests.kept('sup') #>> '{}', 'amount', 10800,
  'method', 'cheque')) ->> 'duplicate')::boolean, true, 'a retried payment is recognised');
select public.pay_supplier(jsonb_build_object('id', tests.id('pay2'), 'supplier_id', tests.kept('sup') #>> '{}', 'amount', 1000,
  'method', 'cheque', 'cheque', jsonb_build_object('number', '000124', 'date', current_date)));
select tests.keep('open_s', (select jsonb_agg(jsonb_build_object('ref', reference, 'open', open_amount) order by entry_date, reference)
                             from public.open_bills('supplier', (tests.kept('sup') #>> '{}')::uuid)));
select public.set_cheque_status((select id from cheques where cheque_number = '000123'), 'cleared');
select public.set_cheque_status((select id from cheques where cheque_number = '000124'), 'deposited', tests.id('bank_a'));
select public.set_cheque_status((select id from cheques where cheque_number = '000124'), 'bounced', null, 'insufficient funds');
select throws_ok($$select public.set_cheque_status((select id from cheques where cheque_number = '000124'), 'cleared')$$,
                 'P0001', null, 'a bounced cheque cannot clear');
reset role;
select is(tests.kept('open_s'), '[{"ref": "Invoice INV-2", "open": 4000}]'::jsonb,
          'open bills: INV-1 paid by the credit note and its cheque; the cash and the Rs 10 cheque go to INV-2');
select is((select balance from money_balances where account_id = tests.id('bank_a')), -9900::bigint, 'the cleared cheque left the bank');
select is(tests.balance('supplier', (tests.kept('sup') #>> '{}')::uuid), 5000::bigint,
          'we owe Getz Rs 50 (the bounced Rs 10 is owed again)');

-- ---- Supplier statement = ledger, to the paisa ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('st_s', public.party_statement('supplier', (tests.kept('sup') #>> '{}')::uuid, current_date - 30, current_date));
reset role;
select is((tests.kept('st_s') ->> 'closing_balance')::bigint, tests.balance('supplier', (tests.kept('sup') #>> '{}')::uuid),
          'supplier statement closing balance = ledger balance');
select is((tests.kept('st_s') -> 'entries' -> -1 ->> 'balance')::bigint, 5000::bigint, 'the last running balance is the closing balance');
select is(jsonb_array_length(tests.kept('st_s') -> 'entries'), 7, 'two invoices, the cash, the credit note, two cheques and the bounce');
select is((tests.kept('st_s') ->> 'total_credit')::bigint - (tests.kept('st_s') ->> 'total_debit')::bigint
          + (tests.kept('st_s') ->> 'opening_balance')::bigint, 5000::bigint, 'opening + bills − payments = closing');

-- ---- Matching Getz's own statement ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('rec', public.reconcile_supplier_statement(jsonb_build_object('supplier_id', tests.kept('sup') #>> '{}',
  'statement_date', current_date, 'period_from', current_date - 30, 'period_to', current_date, 'statement_balance', 5500,
  'lines', jsonb_build_array(
    jsonb_build_object('ref', 'INV-1', 'date', current_date, 'amount', 10800),
    jsonb_build_object('ref', 'inv-2', 'date', current_date, 'amount', 7500),
    jsonb_build_object('ref', 'CHQ 000123', 'date', current_date, 'amount', -9900)))));
reset role;
select is((select jsonb_agg(x ->> 'status' order by ord) from jsonb_array_elements(tests.kept('rec') -> 'lines') with ordinality t(x, ord)
           where ord <= 3), '["matched","difference","matched"]'::jsonb, 'INV-1 and the cheque match; INV-2 differs');
select is((tests.kept('rec') ->> 'difference')::bigint, 500::bigint, 'their balance is Rs 5 more than ours');
select ok(exists (select 1 from jsonb_array_elements(tests.kept('rec') -> 'lines') x where x ->> 'status' = 'missing_in_theirs'
                  and x ->> 'ref' = 'Return PR-000001'), 'our credit note is missing from their statement');

-- ---- A customer's khata ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('cust', public.create_customer(jsonb_build_object('id', tests.id('cust1'), 'name', 'Ahmed Raza', 'phone', '03001234567',
  'reminders_opt_in', true, 'credit_limit', 100000, 'opening_balance', 30000, 'opening_date', current_date - 45)));
select public.set_permission_override(tests.id('salesman_a'), 'udhaar.give', true, null, false, 500000);
select public.set_permission_override(tests.id('salesman_a'), 'udhaar.receive_payment', true, null, false, null);
reset role;
select is(tests.kept('cust') ->> 'account_number', 'C-000001', 'a new khata account number');
select tests.keep('acct', to_jsonb(tests.kept('cust') ->> 'account_id'));
select is((select status from customer_credit_status where account_id = (tests.kept('acct') #>> '{}')::uuid), 'allowed',
          'within the Rs 1,000 limit');

-- At the counter: Rs 10 on udhaar, then Rs 200 paid in cash.
select tests.as_device(tests.id('auth_device_a1'));
select public.start_staff_session(tests.id('salesman_a'), tests.id('sess_s'));
select public.post_sale(jsonb_build_object('id', tests.id('us1'), 'local_seq', 50, 'drawer_session_id', tests.id('drawer_session_a1'),
  'customer_account_id', tests.kept('acct') #>> '{}', 'grand_total', 1000,
  'lines', jsonb_build_array(jsonb_build_object('product_unit_id', tests.id('product_unit_a'), 'batch_id', tests.id('batch_a'),
                                                'qty', 4, 'unit_price', 250)),
  'payments', '[]'::jsonb), tests.id('sess_s'));
select tests.keep('rcpt', public.receive_udhaar_payment(jsonb_build_object('id', tests.id('up1'), 'account_id', tests.kept('acct') #>> '{}',
  'amount', 20000, 'method', 'cash', 'drawer_session_id', tests.id('drawer_session_a1')), tests.id('sess_s')));
select is((public.receive_udhaar_payment(jsonb_build_object('id', tests.id('up1'), 'account_id', tests.kept('acct') #>> '{}',
  'amount', 20000, 'method', 'cash', 'drawer_session_id', tests.id('drawer_session_a1')), tests.id('sess_s')) ->> 'duplicate')::boolean,
  true, 'a retried payment is recognised');
select throws_ok(format($q$select public.party_statement('customer_account', %L, current_date - 60, current_date)$q$, tests.kept('acct') #>> '{}'),
                 '42501', null, 'a counter PC cannot read a statement');
reset role;
select ok(not (tests.kept('rcpt') ? 'balance'), 'the counter receipt does not show the balance');
select is(tests.balance('customer_account', (tests.kept('acct') #>> '{}')::uuid), 11000::bigint, 'Ahmed owes Rs 110');
select is((select balance from money_balances where account_id = tests.id('drawer_session_a1')), 518000::bigint,
          'Rs 200 into the drawer (Rs 4,980 + Rs 200)');

select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('st_c', public.party_statement('customer_account', (tests.kept('acct') #>> '{}')::uuid, current_date - 60, current_date));
select tests.keep('age', (select to_jsonb(a) from public.party_ageing('customer_account') a
                          where a.party_id = (tests.kept('acct') #>> '{}')::uuid));
select tests.keep('due', coalesce((select jsonb_agg(to_jsonb(d)) from public.udhaar_reminders_due(1) d), '[]'));
select is(public.queue_udhaar_reminders(array[(tests.kept('acct') #>> '{}')::uuid]), 1, 'one reminder queued');
select is((select count(*) from public.udhaar_reminders_due(1)), 0::bigint, 'not reminded again this week');
select throws_ok(format($q$select public.write_off_udhaar(%L, 50000, 'moved away')$q$, tests.kept('acct') #>> '{}'),
                 '22023', null, 'cannot write off more than is owed');
select public.write_off_udhaar((tests.kept('acct') #>> '{}')::uuid, 1000, 'rounding settled');
select throws_ok(format($q$select public.set_udhaar_block(%L, true)$q$, tests.kept('acct') #>> '{}'), '22023', null, 'blocking needs a reason');
select public.set_udhaar_block((tests.kept('acct') #>> '{}')::uuid, true, 'slow payer');
reset role;
select is((tests.kept('st_c') ->> 'closing_balance')::bigint, 11000::bigint, 'customer statement closing balance = ledger balance');
select is((select jsonb_agg(x ->> 'type' order by ord) from jsonb_array_elements(tests.kept('st_c') -> 'entries') with ordinality t(x, ord)),
          '["opening","credit_sale","payment"]'::jsonb, 'opening, the udhaar bill, the payment');
select is(tests.kept('st_c') -> 'entries' -> 1 ->> 'reference', 'KHI1-C1-000050', 'the bill number is on the statement');
select is((tests.kept('age') ->> 'days_31_60')::bigint, 10000::bigint, 'Rs 100 of the 45-day-old opening balance is still owed');
select is((tests.kept('age') ->> 'not_due')::bigint, 1000::bigint, 'the Rs 10 bill is not due yet');
select is(jsonb_array_length(tests.kept('due')), 1, 'Ahmed is due a reminder');
select ok(tests.kept('due') -> 0 ->> 'message' like '%Rs 110.00%', 'the reminder shows what is owed');
select is((select count(*) from outbound_messages where to_phone = '03001234567' and status = 'queued'), 1::bigint, 'message waits in the queue');
select is(tests.balance('customer_account', (tests.kept('acct') #>> '{}')::uuid), 10000::bigint, 'Rs 10 written off');
select is((select status from customer_credit_status where account_id = (tests.kept('acct') #>> '{}')::uuid), 'blocked',
          'a blocked account cannot take udhaar');

-- ---- Everything adds up ----
select is((select count(*) from app.party_balance_mismatches(tests.id('tenant_a'))), 0::bigint, 'every cached balance = its ledger');
select is((select count(*) from app.stock_balance_mismatches(tests.id('tenant_a'))), 0::bigint, 'every stock balance = its movements');

-- ---- Privacy ----
select tests.as_owner(tests.id('auth_owner_b'), tests.id('tenant_b'));
select throws_ok(format($q$select public.party_statement('supplier', %L, current_date - 30, current_date)$q$, tests.kept('sup') #>> '{}'),
                 'P0002', null, 'another pharmacy cannot read the statement');
select is(tests.count_rows('purchase_invoices'), 0::bigint, 'nor see the invoices');
reset role;

select * from finish();
rollback;
