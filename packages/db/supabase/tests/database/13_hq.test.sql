-- MedFlow HQ for MedFlow Local (D57): the platform owner adds a pharmacy and gets a licence key;
-- the pharmacy's server checks in with it and gets what it may do; a wrong, revoked or borrowed
-- key gets nothing; trials end, payments bring it back; only HQ itself can run a check-in.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

-- ---- Only the platform owner, with 2FA, adds pharmacies ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($$select public.platform_create_pharmacy('{"name":"X"}')$$, '42501', null, 'a pharmacy owner cannot add pharmacies');
reset role;
select tests.as_admin(tests.id('auth_admin'), 'aal1');
select throws_ok($$select public.platform_create_pharmacy('{"name":"X"}')$$, '42501', null, 'the platform owner needs 2FA');
reset role;

select tests.as_admin(tests.id('auth_admin'));
select set_config('hq.hq_t', (public.platform_create_pharmacy(
  '{"name":"Al-Shifa Pharmacy","owner_name":"Bilal","owner_phone":"03001234567","city":"Lahore","plan":"test_basic","trial_days":14}'))::text, true);
select ok((current_setting('hq.hq_t')::jsonb ->> 'licence_key') ~ '^MF-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$', 'a licence key in the MF-XXXX-XXXX-XXXX-XXXX form');
select is((select status from tenants where id = ((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid)), 'trial', 'a new pharmacy starts on a trial');
select is(jsonb_array_length(public.platform_pharmacies()) >= 3, true, 'the console lists every pharmacy');
reset role;
select is((select count(*)::int from licence_keys where key_sha256 = (current_setting('hq.hq_t')::jsonb ->> 'licence_key')), 0, 'the key itself is never stored');

-- ---- Check-in only through HQ's server ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($$select public.hq_checkin((current_setting('hq.hq_t')::jsonb ->> 'licence_key'), gen_random_uuid())$$, '42501', null,
                 'a browser cannot call the check-in');
reset role;

set local role service_role;
select throws_ok($$select public.hq_checkin('MF-0000-0000-0000-0000', gen_random_uuid())$$, '42501', null, 'a wrong key gets nothing');
select set_config('hq.hq_c', (public.hq_checkin((current_setting('hq.hq_t')::jsonb ->> 'licence_key'), tests.id('install_1'),
  '{"version":"0.2.0","machine":"SHOP-PC","stats":{"products":120}}'))::text, true);
select is((current_setting('hq.hq_c')::jsonb ->> 'status'), 'trial', 'check-in: trial');
select is(((current_setting('hq.hq_c')::jsonb ->> 'may_sell')::boolean), true, 'check-in: may sell');
select is((current_setting('hq.hq_c')::jsonb ->> 'plan'), 'test_basic', 'check-in: the plan');
select is(((current_setting('hq.hq_c')::jsonb #>> '{features,max_counters,limit}')::int), 2, 'check-in: the plan''s limits');
select ok(((current_setting('hq.hq_c')::jsonb ->> 'valid_until')::timestamptz) <= now() + interval '15 days 1 minute', 'offline for at most the offline days');
select is((current_setting('hq.hq_c')::jsonb #>> '{install_id}'), tests.id('install_1')::text, 'check-in: this install');
reset role;
select is((select stats ->> 'products' from local_installs where id = tests.id('install_1')), '120', 'HQ keeps counts for the health page');
set local role service_role;
select lives_ok($$select public.hq_checkin((current_setting('hq.hq_t')::jsonb ->> 'licence_key'), tests.id('install_1'))$$, 'checking in again is fine');
select throws_ok($$select public.hq_checkin('x', tests.id('install_1'))$$, '42501', null, 'a garbage key gets nothing');
reset role;

-- A PC of another pharmacy cannot borrow this pharmacy's install id.
select tests.as_admin(tests.id('auth_admin'));
select set_config('hq.hq_t2', (public.platform_create_pharmacy('{"name":"Other Pharmacy","plan":"test_basic"}'))::text, true);
reset role;
set local role service_role;
select throws_ok($$select public.hq_checkin((current_setting('hq.hq_t2')::jsonb ->> 'licence_key'), tests.id('install_1'))$$, '42501', null,
                 'an install belongs to one pharmacy');
reset role;

-- ---- Features and limits from the console reach the pharmacy ----
select tests.as_admin(tests.id('auth_admin'));
select public.platform_set_tenant_feature(((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid), 'max_counters', true, 5, 'one free extra counter');
reset role;
set local role service_role;
select is((public.hq_checkin((current_setting('hq.hq_t')::jsonb ->> 'licence_key'), tests.id('install_1')) #>> '{features,max_counters,limit}')::int, 5,
          'an override for one pharmacy reaches its check-in');
reset role;

-- ---- A new key stops the old one ----
select tests.as_admin(tests.id('auth_admin'));
select set_config('hq.hq_k2', (public.platform_reissue_licence_key(((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid)))::text, true);
reset role;
set local role service_role;
select throws_ok($$select public.hq_checkin((current_setting('hq.hq_t')::jsonb ->> 'licence_key'), tests.id('install_1'))$$, '42501', null, 'the old key stops working');
select lives_ok($$select public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1'))$$, 'the new key works');
reset role;

-- ---- The trial ends: grace, then read-only at closing time; may not sell ----
update tenants set trial_ends_at = now() - interval '1 day' where id = ((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid);
select public.platform_tick();
select is((select status from tenants where id = ((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid)), 'grace', 'an unpaid ended trial goes to grace');
set local role service_role;
select is((public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1')) ->> 'may_sell')::boolean, true, 'grace still sells');
reset role;
update tenants set status = 'read_only' where id = ((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid);
set local role service_role;
select set_config('hq.hq_ro', (public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1')))::text, true);
select is(((current_setting('hq.hq_ro')::jsonb ->> 'may_sell')::boolean), false, 'read-only may not sell');
select ok(((current_setting('hq.hq_ro')::jsonb ->> 'valid_until')::timestamptz) <= now(), 'a read-only licence is not valid for selling offline');
reset role;

-- ---- Subscription, invoice, the pharmacy pays by reference, the owner verifies: active ----
select tests.as_admin(tests.id('auth_admin'));
select public.platform_start_subscription(((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid), 'test_basic', 'monthly', 250000);
reset role;
set local role service_role;
select set_config('hq.hq_inv', (public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1')) -> 'invoices' -> 0)::text, true);
select is(((current_setting('hq.hq_inv')::jsonb ->> 'amount')::bigint), 250000::bigint, 'the invoice reaches the pharmacy');
select throws_ok($$select public.hq_submit_payment('MF-0000-0000-0000-0000', ((current_setting('hq.hq_inv')::jsonb ->> 'id')::uuid), 'jazzcash', 250000, 'T1')$$,
                 '42501', null, 'paying needs the pharmacy''s key');
select set_config('hq.hq_pay', (public.hq_submit_payment(current_setting('hq.hq_k2'), ((current_setting('hq.hq_inv')::jsonb ->> 'id')::uuid), 'jazzcash', 250000, 'JC-778899'))::text, true);
reset role;
select tests.as_admin(tests.id('auth_admin'));
select ok(public.platform_payments_to_review() @> jsonb_build_array(jsonb_build_object('reference', 'JC-778899')), 'the payment waits for the owner');
select public.platform_review_payment(current_setting('hq.hq_pay')::uuid, true, null);
reset role;
select is((select status from tenants where id = ((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid)), 'active', 'a verified payment makes the pharmacy active');

-- ---- Blocking one PC ----
select tests.as_admin(tests.id('auth_admin'));
select public.platform_block_install(tests.id('install_1'), true, 'stolen PC');
reset role;
set local role service_role;
select is((public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1')) ->> 'may_sell')::boolean, false, 'a blocked PC may not sell');
reset role;

-- ---- Updates: signed releases, channels, rollback ----
select public.platform_block_install(tests.id('install_1'), false) from (select tests.as_admin(tests.id('auth_admin'))) x;
reset role;
select tests.as_admin(tests.id('auth_admin'));
select throws_ok($$select public.platform_publish_release('{"app":"local","version":"0.2.0","channel":"stable","artifact_url":"/hq/download/a"}')$$,
                 '22023', null, 'an unsigned MedFlow Local release is refused');
select throws_ok($$select public.platform_publish_release('{"app":"local","version":"two","channel":"stable","signature":"s","artifact_url":"/a"}')$$,
                 '22023', null, 'a version must look like 1.2.3');
select public.platform_publish_release('{"app":"local","version":"0.1.0","channel":"stable","signature":"s1","artifact_url":"/hq/download/v1","sha256":"aa","size_bytes":10}');
select set_config('hq.rel2', public.platform_publish_release('{"app":"local","version":"0.2.0","channel":"stable","signature":"s2","artifact_url":"/hq/download/v2","sha256":"bb","size_bytes":20}')::text, true);
select public.platform_publish_release('{"app":"local","version":"0.3.0","channel":"beta","signature":"s3","artifact_url":"/hq/download/v3","sha256":"cc","size_bytes":30}');
reset role;
set local role service_role;
select is(public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1'), '{"version":"0.1.0"}') #>> '{update,version}', '0.2.0',
          'a stable pharmacy on 0.1.0 is offered the newest stable release');
select is(public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1'), '{"version":"0.1.0"}') #>> '{update,signature}', 's2',
          'the offer carries HQ''s signature');
select is((public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1'), '{"version":"0.2.0"}') #>> '{update,update_available}')::boolean, false,
          'nothing newer: no update');
reset role;
select tests.as_admin(tests.id('auth_admin'));
select public.platform_set_release_channel((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid, 'beta');
reset role;
set local role service_role;
select is(public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1'), '{"version":"0.2.0"}') #>> '{update,version}', '0.3.0',
          'a beta pharmacy gets the beta release first');
reset role;
select tests.as_admin(tests.id('auth_admin'));
select public.platform_set_release_channel((current_setting('hq.hq_t')::jsonb ->> 'tenant_id')::uuid, 'stable');
select public.platform_rollback_release(current_setting('hq.rel2')::uuid, 'bug in 0.2.0');
reset role;
set local role service_role;
select is(public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1'), '{"version":"0.2.0"}') #>> '{update,version}', '0.1.0',
          'a pharmacy on a pulled release is offered the last good one');
select is((public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1'), '{"version":"0.2.0"}') #>> '{update,is_rollback}')::boolean, true,
          'and is told it is going back');
select is((public.hq_checkin(current_setting('hq.hq_k2'), tests.id('install_1'), '{"version":"0.1.0"}') #>> '{update,update_available}')::boolean, false,
          'a pulled release is never offered');
reset role;
select tests.as_admin(tests.id('auth_admin'));
select ok((public.platform_releases() -> 'releases') @> '[{"version":"0.2.0"}]', 'the console lists releases');
reset role;

select * from finish();
rollback;
