-- WhatsApp: udhaar reminders (who, how much, how many days), logging, payment contact,
-- refill reminders, the reorder list and settings — and that another pharmacy sees none of it.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();
grant execute on all functions in schema tests to authenticated;

-- ---- Settings ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.set_setting('whatsapp.number', '"03316368566"');
select public.set_setting('whatsapp.language', '"roman"');
select tests.keep('ws', public.office_whatsapp_settings());
select is(tests.kept('ws') ->> 'number', '03316368566', 'the pharmacy WhatsApp number is saved');
select is(tests.kept('ws') ->> 'language', 'roman', 'the message language is saved');
select is((tests.kept('ws') ->> 'interval_days')::int, 7, 'remind again after 7 days by default');

-- ---- A customer who owes Rs 300 for 45 days ----
select tests.keep('cust', public.create_customer(jsonb_build_object('id', tests.id('wa_cust'), 'name', 'Bilal Khan', 'phone', '0300 1234567',
  'reminders_opt_in', true, 'opening_balance', 30000, 'opening_date', current_date - 45)));
select tests.keep('acct', to_jsonb(tests.kept('cust') ->> 'account_id'));
select tests.keep('list', public.office_udhaar_reminders(current_date));
select tests.keep('bilal', (select x from jsonb_array_elements(tests.kept('list')) x where x ->> 'account_id' = tests.kept('acct') #>> '{}'));
select is((tests.kept('bilal') ->> 'balance')::bigint, 30000::bigint, 'the list shows what Bilal owes');
select is((tests.kept('bilal') ->> 'days')::int, 45, 'and for how many days');
select is(tests.kept('bilal') ->> 'phone', '0300 1234567', 'and the mobile number');
select is((tests.kept('bilal') ->> 'due')::boolean, true, 'Bilal is due a reminder');

-- One button: the message is opened in WhatsApp and logged.
select throws_ok(format($q$select public.log_whatsapp(jsonb_build_object('kind', 'udhaar_reminder', 'to_phone', '12', 'body', 'x', 'related_id', %L))$q$,
                 tests.kept('acct') #>> '{}'), '22023', null, 'a wrong number is refused');
select ok(public.log_whatsapp(jsonb_build_object('kind', 'udhaar_reminder', 'to_phone', '923001234567', 'body', 'Assalam-o-Alaikum Bilal Khan, Rs 300 ...',
  'related_id', tests.kept('acct') #>> '{}', 'balance', 30000)) is not null, 'the reminder is logged');
select tests.keep('bilal2', (select x from jsonb_array_elements(public.office_udhaar_reminders(current_date)) x
                             where x ->> 'account_id' = tests.kept('acct') #>> '{}'));
select is((tests.kept('bilal2') ->> 'due')::boolean, false, 'not due again this week');
select ok(tests.kept('bilal2') ->> 'last_reminded_at' is not null, 'the list shows when he was last reminded');
select is((public.office_customer_contact((tests.kept('acct') #>> '{}')::uuid) ->> 'balance')::bigint, 30000::bigint,
          'the khata knows the balance for a payment receipt');
select is(jsonb_array_length(public.office_whatsapp_log(50)), 1, 'the WhatsApp history has the message');

-- ---- Refill reminders ----
select ok(public.save_regular_medicine(jsonb_build_object('customer_id', tests.id('wa_cust'), 'product_id', tests.id('product_a'), 'interval_days', 2)) is not null,
          'Panadol every 2 days is saved for Bilal');
select throws_ok(format($q$select public.save_regular_medicine(jsonb_build_object('customer_id', %L, 'product_id', %L, 'interval_days', 0))$q$,
                 tests.id('wa_cust'), tests.id('product_a')), '22023', null, 'a refill needs a number of days');
select is(jsonb_array_length(public.office_regular_medicines(tests.id('wa_cust'))), 1, 'the customer has one regular medicine');
select is(jsonb_array_length(public.office_refills_due(current_date, 3)), 1, 'it is due within 3 days');
select is(jsonb_array_length(public.office_refills_due(current_date, 0)), 0, 'but not today');

-- ---- Reorder list ----
reset role;
update products set reorder_level = 1000 where id = tests.id('product_a');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select ok(public.office_reorder_list(tests.id('branch_a1')) @> jsonb_build_array(jsonb_build_object('product_id', tests.id('product_a'))),
          'a medicine under its reorder level is on the reorder list');

-- ---- Staff and other pharmacies ----
reset role;
select tests.as_device(tests.id('auth_device_a1'));
select throws_ok($$select public.office_udhaar_reminders(current_date)$$, '42501', null, 'a counter PC cannot list who owes');
select throws_ok($$select public.log_whatsapp('{"kind": "daily_summary", "to_phone": "923001234567", "body": "x"}')$$, '42501', null,
                 'a counter PC cannot log as the owner');
reset role;
select tests.as_owner(tests.id('auth_owner_b'), tests.id('tenant_b'));
select is(jsonb_array_length(public.office_whatsapp_log(50)), 0, 'another pharmacy sees no messages');
select is((select count(*)::int from jsonb_array_elements(public.office_udhaar_reminders(current_date)) x where x ->> 'name' = 'Bilal Khan'), 0,
          'another pharmacy does not see Bilal');
select is(jsonb_array_length(public.office_refills_due(current_date, 30)), 0, 'nor his refills');
reset role;

select * from finish();
rollback;
