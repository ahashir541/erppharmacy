-- Ledgers, no hard deletes, the append-only audit log, recalls, GL balance.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

-- Balances are the sum of ledger rows.
select is((select qty_base from stock_balances
           where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a')),
          (select sum(qty_base) from stock_movements
           where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a'))::bigint,
          'stock balance = sum of stock movements');
select is((select qty_base from stock_balances
           where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a')), 90::bigint,
          'branch A1 has 100 - 4 - 6 = 90');
select is((select balance from party_balances where party_id = tests.id('account_a')), 200000::bigint,
          'customer owes 3,000 - 1,000 = Rs 2,000');
select is((select balance from party_balances where party_id = tests.id('supplier_a')), 500000::bigint,
          'we owe the supplier Rs 5,000');
select is((select status || ':' || available_credit from customer_credit_status
           where account_id = tests.id('account_a')), 'allowed:300000',
          'credit status: allowed, Rs 3,000 headroom on a Rs 5,000 limit');

-- Blocking the account updates the counter's answer.
update customer_accounts set udhaar_blocked = true, blocked_reason = 'unpaid since March'
where id = tests.id('account_a');
select is((select status from customer_credit_status where account_id = tests.id('account_a')), 'blocked',
          'blocked account shows not allowed');

-- Nothing is edited or deleted in place.
select throws_ok('update stock_movements set qty_base = 1', 'P0001', null, 'stock movements cannot be edited');
select throws_ok('delete from stock_movements', 'P0001', null, 'stock movements cannot be deleted');
select throws_ok('update ledger_entries set debit = 1 where debit > 0', 'P0001', null, 'udhaar ledger cannot be edited');
select throws_ok('delete from products', 'P0001', null, 'products cannot be hard-deleted');
select throws_ok('delete from sales', 'P0001', null, 'sales cannot be hard-deleted');
select throws_ok('update audit_log set action = ''x''', 'P0001', null, 'audit log cannot be edited, even by the database owner');
select throws_ok('delete from audit_log', 'P0001', null, 'audit log cannot be deleted, even by the database owner');

-- Every master-data change is in the audit log with old and new values.
select ok(exists (select 1 from audit_log where table_name = 'products' and action = 'insert'
                  and record_id = tests.id('product_a') and new_data ->> 'brand_name' = 'Panadol 500mg'),
          'product creation is audited');
update products set brand_name = 'Panadol Extra' where id = tests.id('product_a');
select ok(exists (select 1 from audit_log where table_name = 'products' and action = 'update'
                  and record_id = tests.id('product_a')
                  and old_data ->> 'brand_name' = 'Panadol 500mg'
                  and new_data ->> 'brand_name' = 'Panadol Extra'),
          'product edit is audited with old and new values');

-- A platform recall freezes matching batches in every pharmacy.
insert into global_recalls (brand_name, batch_number, reason) values ('panadol extra', 'p123', 'DRAP recall');
select is((select count(*) from batch_blocks where batch_id = tests.id('batch_a') and lifted_at is null),
          1::bigint, 'recalled batch is frozen');

-- General ledger journals must balance.
insert into gl_accounts (id, tenant_id, code, name, type) values
  (tests.id('gl_cash'), tests.id('tenant_a'), '1000', 'Cash', 'asset'),
  (tests.id('gl_sales'), tests.id('tenant_a'), '4000', 'Sales', 'income');
select throws_ok($q$
  do $x$
  declare j uuid;
  begin
    insert into gl_journals (tenant_id, journal_date, source_type)
    values (tests.id('tenant_a'), current_date, 'manual') returning id into j;
    insert into gl_entries (tenant_id, journal_id, gl_account_id, debit)
    values (tests.id('tenant_a'), j, tests.id('gl_cash'), 100);
    set constraints all immediate;
  end $x$;
$q$, 'P0001', null, 'an unbalanced journal is refused');
select lives_ok($q$
  do $x$
  declare j uuid;
  begin
    insert into gl_journals (tenant_id, journal_date, source_type)
    values (tests.id('tenant_a'), current_date, 'manual') returning id into j;
    insert into gl_entries (tenant_id, journal_id, gl_account_id, debit)
    values (tests.id('tenant_a'), j, tests.id('gl_cash'), 100);
    insert into gl_entries (tenant_id, journal_id, gl_account_id, credit)
    values (tests.id('tenant_a'), j, tests.id('gl_sales'), 100);
    set constraints all immediate;
  end $x$;
$q$, 'a balanced journal is accepted');

-- A row can never point at another pharmacy's row.
select throws_ok(
  format($q$insert into product_units (tenant_id, product_id, unit_id, factor_to_base)
            values (%L, %L, (select id from units where tenant_id = %L and code = 'box'), 10)$q$,
         tests.id('tenant_b'), tests.id('product_a'), tests.id('tenant_b')),
  '23503', null, 'cross-pharmacy reference is refused by the composite foreign key');

select * from finish();
rollback;
