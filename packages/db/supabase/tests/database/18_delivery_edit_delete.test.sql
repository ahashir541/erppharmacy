-- 0042: a delivery entered wrong is deleted (stock leaves, the supplier bill is reversed) or edited
-- (replaced by the corrected one, same invoice number). Refused once some of it was sold or moved.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();
grant execute on all functions in schema tests to authenticated;

create or replace function tests.shelf() returns bigint language sql as $$
  select coalesce(sum(qty_base), 0)::bigint from stock_balances where branch_id = tests.id('branch_a1') and product_id = tests.id('product_a')
$$;
create or replace function tests.owes(p_sup uuid) returns bigint language sql as $$
  select coalesce((select balance from party_balances where party_type = 'supplier' and party_id = p_sup), 0)::bigint
$$;
grant execute on all functions in schema tests to authenticated;

create or replace function tests.grn(p_id uuid, p_qty int) returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'branch_id', tests.id('branch_a1'), 'supplier_id', tests.kept('sup') #>> '{}', 'supplier_invoice_number', 'AD-77',
    'lines', jsonb_build_array(jsonb_build_object('product_unit_id', tests.id('product_unit_a'), 'qty', p_qty, 'unit_cost', 100)),
    'invoice', jsonb_build_object('supplier_invoice_number', 'AD-77', 'paid_at_receipt', 0))
$$;
grant execute on all functions in schema tests to authenticated;

select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('sup', to_jsonb(public.save_supplier('{"name": "Adeel Traders"}')));
select tests.keep('before', to_jsonb(tests.shelf()));


select public.post_grn(tests.grn(tests.id('d1'), 10));
select is(tests.shelf() - (tests.kept('before') #>> '{}')::bigint, 10::bigint * (select factor_to_base from product_units where id = tests.id('product_unit_a')), 'the delivery added stock');
select ok(tests.owes((tests.kept('sup') #>> '{}')::uuid) > 0, 'and what we owe the supplier');

-- Edit: 10 was wrong, it was 4. Same invoice number again.
select lives_ok(format($q$select public.replace_grn(%L, tests.grn(%L, 4))$q$, tests.id('d1'), tests.id('d2')), 'edit replaces the delivery');
select is(tests.shelf() - (tests.kept('before') #>> '{}')::bigint, 4::bigint * (select factor_to_base from product_units where id = tests.id('product_unit_a')), 'stock now matches the corrected delivery');
select is(tests.owes((tests.kept('sup') #>> '{}')::uuid), 400::bigint, 'the supplier is owed only the corrected bill');
select is((select status from grns where id = tests.id('d1')), 'voided', 'the old delivery is kept, marked deleted');
select ok(not (public.office_deliveries(tests.id('branch_a1')) @> jsonb_build_array(jsonb_build_object('id', tests.id('d1')))), 'and not listed');

-- Delete, once part of it left the shelf: refused.
select public.set_product_stock(tests.id('branch_a1'), tests.id('product_a'), 0, 'sold out');
select throws_ok(format($q$select public.void_grn(%L, 'x')$q$, tests.id('d2')), 'P0001', null, 'cannot delete a delivery whose stock is gone');

select * from finish();
rollback;
