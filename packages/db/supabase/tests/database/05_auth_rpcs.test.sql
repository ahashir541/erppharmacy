-- Onboarding, staff, PINs, devices, sessions and the sign-in token hook.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

-- ---- Platform owner onboards a pharmacy ----
select tests.as_admin(tests.id('auth_admin'), 'aal1');
select throws_ok($q$select public.platform_provision_tenant('X', 'Y', '1', 'y@test.invalid', 'test_basic', 'ISB1', 'Main')$q$,
                 '42501', null, 'platform admin without 2FA cannot onboard');
select tests.as_admin(tests.id('auth_admin'));
select lives_ok($q$select public.platform_provision_tenant('City Pharmacy', 'New Owner', '03001234567',
                  'New.Owner@test.invalid', 'test_basic', 'ISB1', 'Blue Area', 'Islamabad')$q$,
                'platform admin onboards a pharmacy');
reset role;
select is((select status from tenants where name = 'City Pharmacy'), 'trial', 'new pharmacy starts on trial');
select is((select count(*) from roles r join tenants t on t.id = r.tenant_id where t.name = 'City Pharmacy'),
          6::bigint, 'six default roles created');
select is((select u.status || ':' || u.email from users u join tenants t on t.id = u.tenant_id
           where t.name = 'City Pharmacy' and u.is_primary_owner), 'invited:new.owner@test.invalid',
          'primary owner invited, email lower-cased');
select ok(exists (select 1 from user_roles ur join users u on u.id = ur.user_id
                  join roles r on r.id = ur.role_id
                  where u.email = 'new.owner@test.invalid' and r.template_code = 'owner'),
          'owner holds the Owner role');
select ok(exists (select 1 from platform_audit_log where action = 'tenant.provision'), 'onboarding is in the platform audit log');

select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($q$select public.platform_provision_tenant('X', 'Y', '1', 'y@test.invalid', 'test_basic', 'ISB2', 'Main')$q$,
                 '42501', null, 'a pharmacy owner cannot onboard pharmacies');
select throws_ok(format($q$select public.platform_link_owner_auth(%L, %L)$q$, tests.id('owner_a'), tests.id('auth_new_owner')),
                 '42501', null, 'only the Edge Function (service role) links owner logins');

-- Invite accepted: link login (service role), then sign in with 2FA.
reset role;
select set_config('role', 'service_role', true);
select lives_ok(format($q$select public.platform_link_owner_auth(
                  (select id from public.users where email = 'new.owner@test.invalid'), %L)$q$, tests.id('auth_new_owner')),
                'service role links the invited owner');
reset role;
select is((public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('auth_new_owner'), 'claims', '{}'::jsonb))
           -> 'claims' ->> 'principal'), 'owner', 'token hook: invited owner gets owner claims');
select tests.as_owner(tests.id('auth_new_owner'),
                      (select id from tenants where name = 'City Pharmacy'));
select ok(public.accept_owner_invite() is not null, 'owner accepts the invitation with 2FA');
select ok(tests.count_rows('roles') = 6, 'the new owner now sees their own pharmacy');
reset role;

-- ---- Token hook ----
select is((public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('auth_owner_a'), 'claims', '{}'::jsonb))
           -> 'claims' ->> 'tenant_id')::uuid, tests.id('tenant_a'), 'token hook: owner gets their tenant_id');
select is((public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('auth_device_a1'), 'claims', '{}'::jsonb))
           -> 'claims' ->> 'device_id')::uuid, tests.id('device_a1'), 'token hook: counter gets its device_id');
select is((public.custom_access_token_hook(jsonb_build_object('user_id', tests.id('auth_admin'), 'claims', '{}'::jsonb))
           -> 'claims' ->> 'principal'), 'platform_admin', 'token hook: platform admin principal');

-- ---- Owner manages staff ----
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select lives_ok($q$select public.create_staff('Pharmacist A', '03111111111')$q$, 'owner adds a staff member');
select lives_ok(format($q$select public.assign_role((select id from users where full_name = 'Pharmacist A'),
                  (select id from roles where tenant_id = %L and template_code = 'pharmacist'), %L)$q$,
                tests.id('tenant_a'), tests.id('branch_a1')), 'owner gives them the Pharmacist role at A1');
select throws_ok($q$select public.set_staff_pin((select id from users where full_name = 'Pharmacist A'), '1234')$q$,
                 '22023', null, 'a raw PIN is refused (only hashes are stored)');
select lives_ok($q$select public.set_staff_pin((select id from users where full_name = 'Pharmacist A'),
                  'pbkdf2-sha256$600000$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=')$q$,
                'owner sets the PIN hash');
-- 4 people + Pharmacist A = 5 of 6 allowed; one more fits, the next does not.
select lives_ok($q$select public.create_staff('Helper A')$q$, 'sixth person fits the plan');
select throws_ok($q$select public.create_staff('Helper B')$q$, 'P0001', null, 'seventh person is over the plan limit');
select throws_ok(format($q$select public.disable_user(%L, 'test')$q$, tests.id('owner_a')),
                 'P0001', null, 'the primary owner can never be disabled');
select throws_ok($q$select public.create_branch('KHI3', 'Third')$q$, 'P0001', null, 'third branch is over the plan limit');
select throws_ok(format($q$select public.register_device(%L, 'C2', 'Counter 2')$q$, tests.id('branch_a1')),
                 'P0001', null, 'third counter is over the plan limit');
reset role;
select ok(exists (select 1 from audit_log where action = 'staff.pin_set'), 'PIN change is audited');
select ok(not exists (select 1 from audit_log where table_name = 'user_pins'), 'PIN hashes never appear in the audit log');
select ok(exists (select 1 from audit_log where table_name = 'users' and action = 'insert'
                  and new_data ->> 'full_name' = 'Pharmacist A'
                  and user_id = tests.id('owner_a')),
          'adding staff is audited with who did it');

-- ---- Counter: staff sign-in by PIN ----
select tests.as_device(tests.id('auth_device_a1'));
select lives_ok(format($q$select public.start_staff_session(%L, %L)$q$, tests.id('manager_a'), tests.id('session_1')),
                'manager starts a session on counter A1');
select lives_ok(format($q$select public.end_staff_session(%L, 'idle_lock')$q$, tests.id('session_1')),
                'session ends on idle lock');
select throws_ok(format($q$select public.create_staff('Sneaky')$q$), '42501', null,
                 'a counter cannot add staff');
select tests.as_device(tests.id('auth_device_a2'));
select throws_ok(format($q$select public.start_staff_session(%L)$q$, tests.id('manager_a')),
                 '42501', null, 'manager of A1 cannot sign in at counter A2');
reset role;
select is((select end_reason from user_sessions where id = tests.id('session_1')), 'idle_lock', 'attendance recorded');
select ok(exists (select 1 from audit_log where action = 'login' and user_id = tests.id('manager_a')
                  and device_id = tests.id('device_a1')), 'login is audited with person and PC');

-- Five wrong PINs lock the PIN for 15 minutes.
select tests.as_device(tests.id('auth_device_a1'));
select public.record_pin_failure(tests.id('salesman_a')) from generate_series(1, 5);
reset role;
select ok((select locked_until > now() from user_pins where user_id = tests.id('salesman_a')),
          'five wrong PINs lock the PIN');

-- Disabled staff cannot sign in anywhere.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select lives_ok(format($q$select public.disable_user(%L, 'left')$q$, tests.id('manager_a')), 'owner disables the manager');
select tests.as_device(tests.id('auth_device_a1'));
select throws_ok(format($q$select public.start_staff_session(%L)$q$, tests.id('manager_a')),
                 '42501', null, 'disabled manager cannot sign in at the counter');

-- A disabled PC loses all access instantly.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select lives_ok(format($q$select public.disable_device(%L, 'stolen')$q$, tests.id('device_a2')), 'owner disables counter A2');
select tests.as_device(tests.id('auth_device_a2'));
select is(tests.count_rows('products'), 0::bigint, 'disabled counter sees nothing');

-- Read-only pharmacies cannot change anything.
reset role;
update tenants set status = 'read_only' where id = tests.id('tenant_a');
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($q$select public.create_staff('Late hire')$q$, 'P0001', null, 'read-only pharmacy cannot add staff');
select ok(tests.count_rows('products') > 0, 'read-only pharmacy can still read its data');

reset role;
select * from finish();
rollback;
