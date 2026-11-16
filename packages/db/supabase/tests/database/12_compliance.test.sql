-- Phase 7: compliance. The tax queue, prescriptions and the controlled drugs register, licences,
-- recalls and the scheduled checks.
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

-- ---- Tax registration ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($$select public.save_tax_profile('{"provider": "srb", "is_enabled": true}')$$, 'P0001', null,
                 'SRB cannot be switched on until its sender exists');
select throws_ok($$select public.save_tax_profile('{"provider": "fbr", "is_enabled": true, "environment": "production"}')$$, '22023', null,
                 'production needs the NTN and POS ID');
select lives_ok($$select public.save_tax_profile('{"provider": "fbr", "is_enabled": true, "ntn": "1234567", "pos_id": "123456"}')$$,
                'FBR switched on (sandbox)');
select public.set_permission_override(tests.id('salesman_a'), 'controlled.dispense', true, null, false, null);
select throws_ok($$select public.tax_claim_batch(10)$$, '42501', null, 'only the sender (service role) takes from the queue');
reset role;

-- ---- A bill joins the queue ----
select tests.as_device(tests.id('auth_device_a1'));
select public.start_staff_session(tests.id('salesman_a'), tests.id('sess_s'));
select public.post_sale(tests.one_tablet('tx1', 301), tests.id('sess_s'));
select throws_ok($$select public.void_sale(tests.id('tx1'), 'mistake', null, tests.id('sess_s'))$$, 'P0001',
                 'This bill is reported to the tax authority; take a return instead of voiding it', 'a reported bill is not voided');
reset role;
select is((select tax_status from sales where id = tests.id('tx1')), 'pending', 'the bill shows "pending FBR"');
select is((select count(*) from tax_submissions where sale_id = tests.id('tx1') and status = 'queued' and provider = 'fbr'), 1::bigint,
          'and waits in the FBR queue');

-- The sender: FBR refuses it (a missing tax code), the owner is told, fixes, and sends it again.
select tests.keep('c1', public.tax_claim_batch(10));
select is(tests.kept('c1') -> 0 -> 'document' ->> 'invoice_number', 'KHI1-C1-000301', 'the sender gets the bill');
select is((tests.kept('c1') -> 0 -> 'document' -> 'totals' ->> 'total')::bigint, 500::bigint, 'with its total');
select is(tests.kept('c1') -> 0 -> 'document' -> 'seller' ->> 'pos_id', '123456', 'and the POS ID');
select public.tax_record_result(tests.id('tx1')::uuid, false, null, null, null, 'unused', true) where false;
select public.tax_record_result((tests.kept('c1') -> 0 ->> 'id')::uuid, false, null, null, '{"Code": "401"}', 'Invalid PCT code', false);
select is((select tax_status from sales where id = tests.id('tx1')), 'failed', 'refused: the bill is marked');
select ok(exists (select 1 from notifications where kind = 'tax_rejected' and body like '%Invalid PCT code%'), 'the owner is told why');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.retry_tax_submission((tests.kept('c1') -> 0 ->> 'id')::uuid);
select tests.keep('rep', public.report_tax(current_date, current_date));
reset role;
select is((select tax_status from sales where id = tests.id('tx1')), 'pending', 'sent again after the fix');
select is((tests.kept('rep') -> 'queue' ->> 'fbr:queued')::int, 1, 'the tax report shows it waiting');
select tests.keep('c2', public.tax_claim_batch(10));
select public.tax_record_result((tests.kept('c2') -> 0 ->> 'id')::uuid, true, '123456FBR0001', 'qr-data', '{"Code": "100"}');
select is((select authority_invoice_number || ' ' || tax_status from sales where id = tests.id('tx1')), '123456FBR0001 reported',
          'accepted: FBR''s number is on the bill');
select is(public.get_receipt(tests.id('tx1')) ->> 'tax_invoice_number', '123456FBR0001', 'and on the receipt');
select is((public.tax_claim_batch(10)), '[]'::jsonb, 'nothing left to send');

-- ---- Prescriptions and the controlled drugs register ----
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
select is((tests.kept('reg') -> 0 ->> 'closing_balance')::bigint, 86::bigint, 'balance: 90 − 2 − 2 = 86');
select is((tests.kept('reg') -> 0 -> 'entries' -> -1 ->> 'patient'), 'Ali Khan', 'with the patient');
select is((tests.kept('reg') -> 0 -> 'entries' -> -1 ->> 'prescriber'), 'Dr. Ahmed', 'and the prescriber');
select is((tests.kept('reg') -> 0 -> 'entries' -> -1 ->> 'balance')::bigint, 86::bigint, 'and the running balance');
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

-- A bill that cannot reach FBR for hours.
select tests.as_device(tests.id('auth_device_a1'));
select public.post_sale(tests.one_tablet('tx2', 304), tests.id('sess_s'));
reset role;
update tax_submissions set queued_at = now() - interval '7 hours' where status <> 'accepted';
select public.run_scheduled_checks();
-- The oldest unsent bill of the counter (the controlled sale) holds the line; the next waits behind it.
select is((select status from tax_submissions where sale_id = tests.id('cd1')), 'stuck', 'waiting over 6 hours: stuck');
select is((select status from tax_submissions where sale_id = tests.id('tx2')), 'queued', 'the bill behind it waits its turn');
select ok(exists (select 1 from notifications where kind = 'tax_queue_stuck'), 'the owner is told it is stuck');
select is(jsonb_array_length(public.tax_claim_batch(10)), 1, 'and it is still sent');

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
