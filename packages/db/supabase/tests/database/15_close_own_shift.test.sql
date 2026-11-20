-- Whoever may sell may close their own shift (managers and pharmacists too); closing someone
-- else's shift still needs cash.view.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();
grant execute on all functions in schema tests to authenticated;

select tests.as_device(tests.id('auth_device_a1'));
select public.start_staff_session(tests.id('manager_a'), tests.id('sess_mgr'));
select public.start_staff_session(tests.id('salesman_a'), tests.id('sess_sal'));
select throws_ok(format($q$select public.close_drawer(%L, 100, null, %L)$q$, tests.id('drawer_session_a1'), tests.id('sess_mgr')),
                 '42501', null, 'a manager cannot close the salesman''s shift');
select lives_ok(format($q$select public.close_drawer(%L, 500000, null, %L)$q$, tests.id('drawer_session_a1'), tests.id('sess_sal')),
                'the salesman closes their own shift');
select lives_ok(format($q$select public.open_drawer(%L, 100000, %L, %L)$q$, tests.id('drawer_a1'), tests.id('sess_mgr'), tests.id('mgr_shift')),
                'the manager opens a shift');
select lives_ok(format($q$select public.close_drawer(%L, 100000, null, %L)$q$, tests.id('mgr_shift'), tests.id('sess_mgr')),
                'the manager closes their own shift (was: Permission cash.close_shift is required)');
reset role;
select is((select status from drawer_sessions where id = tests.id('mgr_shift')), 'closed', 'the manager''s shift is closed');
select ok((select bool_and(rp.allowed) from role_permissions rp join roles r on r.id = rp.role_id
           where r.template_code in ('manager', 'pharmacist') and rp.permission_code = 'cash.close_shift'),
          'manager and pharmacist roles may close their own shift');

select * from finish();
rollback;
