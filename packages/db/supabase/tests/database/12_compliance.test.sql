-- Phase 7: compliance. Prescriptions and the controlled drugs register, licences, recalls and the
-- scheduled checks. There is no sales tax and no tax authority link (D55).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

create or replace function tests.one_tablet(p_id text, p_seq int, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('id', tests.id(p_id), 'local_seq', p_seq, 'drawer_session_id', tests.id('drawer_session_a1'), 'grand_total', 500,
    'lines', jsonb_build_array(jsonb_build_object('id', tests.id(p_id || ':l'), 'product_unit_id', tests.id('product_unit_a'),
                                                  'batch_id', tests.id('batch_a'), 'qty', 2, 'unit_price', 250)),
    'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'tendered', 500))) || p_extra
$$;
grant execute on function tests.one_tablet(text, int, jsonb) to authenticated;

-- ---- Prescriptions and the controlled drugs register ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.set_permission_override(tests.id('salesman_a'), 'controlled.dispense', true, null, false, null);
reset role;
select tests.as_device(tests.id('auth_device_a1'));
select public.start_staff_session(tests.id('salesman_a'), tests.id('sess_s'));
reset role;
select is(app.tax_rate_bp(tests.id('product_a'), current_date), 0, 'no item is ever taxed');
select ok(not exists (select 1 from permissions where code like 'tax.%' or code = 'reports.tax'), 'no tax permissions');
update products set is_controlled = true where id = tests.id('product_a');
select tests.as_device(tests.id('auth_device_a1'));
select throws_ok($$select public.post_sale(tests.one_tablet('cd0', 302), tests.id('sess_s'))$$, 'P0001', null,
                 'a controlled medicine needs a prescription');
select throws_ok($$select public.post_sale(tests.one_tablet('cd0', 302, jsonb_build_object('prescription', jsonb_build_object(
    'id', tests.id('rx0'), 'patient_name', 'Ali Khan', 'doctor_name', 'Dr. Ahmed', 'pharmacist_id', tests.id('salesman_a')))), tests.id('sess_s'))$$,
  'P0001', null, 'and a real pharmacist''s confirmation (a salesman does not count)');
select lives_ok($$select public.post_sale(tests.one_tablet('cd1', 303, jsonb_build_object('prescription', jsonb_build_object(
    'id', tests.id('rx1'), 'patient_name', 'Ali Khan', 'patient_age_years', 54, 'doctor_name', 'Dr. Ahmed',
    'photo_paths', jsonb_build_array('rx/2026/11/rx1.jpg'), 'pharmacist_id', tests.id('owner_a')))), tests.id('sess_s'))$$,
  'with the prescription and the pharmacist, it sells');
reset role;
select is((select prescription_id from sales where id = tests.id('cd1')), tests.id('rx1'), 'the bill points to its prescription');
select ok(exists (select 1 from notifications where kind = 'controlled_sale'), 'the owner hears about the controlled sale');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select tests.keep('reg', public.controlled_register(tests.id('branch_a1'), current_date - 1, current_date));
reset role;
select is((tests.kept('reg') -> 0 ->> 'medicine'), 'Panadol 500mg', 'the register lists the medicine');
select is((tests.kept('reg') -> 0 ->> 'closing_balance')::bigint, 88::bigint, 'balance: 90 − 2 = 88');
select is((tests.kept('reg') -> 0 -> 'entries' -> -1 ->> 'patient'), 'Ali Khan', 'with the patient');
select is((tests.kept('reg') -> 0 -> 'entries' -> -1 ->> 'prescriber'), 'Dr. Ahmed', 'and the prescriber');
select is((tests.kept('reg') -> 0 -> 'entries' -> -1 ->> 'balance')::bigint, 88::bigint, 'and the running balance');
select ok(exists (select 1 from jsonb_array_elements(tests.kept('reg') -> 0 -> 'entries') e where (e ->> 'qty_in')::bigint = 100),
          'receipts are listed too');
update products set is_controlled = false where id = tests.id('product_a');

-- ---- Licences ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.save_branch_licence(jsonb_build_object('branch_id', tests.id('branch_a1'), 'licence_number', 'DSL-KHI-0042',
  'qualified_person_name', 'Ph. Sana Ali', 'expires_on', current_date + 10));
select is((select licence_number from public.licences_due()), 'DSL-KHI-0042', 'a licence expiring in 10 days is due for renewal');
reset role;

-- ---- Scheduled checks ----
update devices set last_seen_at = now() - interval '3 days' where id = tests.id('device_a2');
select tests.keep('run1', public.run_scheduled_checks());
select tests.keep('run2', public.run_scheduled_checks());
select is((select count(*) from notifications where kind = 'licence_expiry'), 1::bigint, 'the owner is reminded about the licence');
select is((select count(*) from notifications where kind = 'device_offline' and reference_id = tests.id('device_a2')), 1::bigint,
          'and about the PC offline for 3 days');
select ok((tests.kept('run2') ->> 'licences')::int = 0 and (tests.kept('run2') ->> 'devices_offline')::int = 0, 'but not every 15 minutes');

-- ---- Recalls ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($$select public.platform_issue_recall('{"brand_name": "Panadol", "batch_number": "P123", "reason": "x"}')$$,
                 '42501', null, 'only the platform owner issues recalls');
reset role;
select tests.as_admin(tests.id('auth_admin'));
select tests.keep('recall', public.platform_issue_recall(jsonb_build_object('brand_name', 'Panadol', 'batch_number', 'p123',
  'reason', 'DRAP: sub-standard', 'authority_reference', 'DRAP/RA/2026/77')));
reset role;
select is((tests.kept('recall') ->> 'batches_matched')::int, 1, 'the recall finds the batch in pharmacy A');
select ok(exists (select 1 from batch_blocks where batch_id = tests.id('batch_a') and source = 'global_recall' and lifted_at is null),
          'matching stock is frozen at once');
select ok(exists (select 1 from notifications where kind = 'recall' and tenant_id = tests.id('tenant_a')), 'and the owner is told');
select tests.as_device(tests.id('auth_device_a1'));
select throws_ok($$select public.post_sale(tests.one_tablet('rc1', 305), tests.id('sess_s'))$$, 'P0001', null, 'the frozen batch cannot be sold');
reset role;
insert into batches (id, tenant_id, product_id, batch_number, expiry_date)
values (tests.id('batch_late'), tests.id('tenant_a'), tests.id('product_a'), 'P123', current_date + 500);
select ok(exists (select 1 from batch_blocks where batch_id = tests.id('batch_late') and lifted_at is null),
          'the same batch number received later is frozen as it arrives');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok(format($q$select public.unblock_batch(%L, 'mine')$q$, (select id from batch_blocks where batch_id = tests.id('batch_a')
                 and source = 'global_recall')), '42501', null, 'the pharmacy cannot lift a recall itself');
reset role;
select tests.as_admin(tests.id('auth_admin'));
select is(public.platform_lift_recall((tests.kept('recall') ->> 'recall_id')::uuid, 'DRAP withdrew the alert'), 2, 'lifting the recall');
reset role;
select is((select count(*) from batch_blocks where source = 'global_recall' and lifted_at is null), 0::bigint, 'unfreezes both batches');

select * from finish();
rollback;
