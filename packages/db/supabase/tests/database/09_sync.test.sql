-- Phase 4: offline sync. A counter PC uploads its outbox; the server replays it in order,
-- once, and keeps anything it cannot apply (never loses it).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
select tests.fixture();

create or replace function tests.cmd(p_id text, p_seq int, p_kind text, p_user uuid, p_payload jsonb default '{}')
returns jsonb language sql as $$
  select jsonb_build_object('id', tests.id(p_id), 'device_seq', p_seq, 'kind', p_kind, 'acting_user', p_user,
                            'session_id', tests.id('offline_sess'), 'created_on_device_at', now(), 'payload', p_payload)
$$;
grant execute on function tests.cmd(text, int, text, uuid, jsonb) to authenticated;

create or replace function tests.upload() returns jsonb language sql as $$
  select jsonb_build_array(
    tests.cmd('c1', 1, 'staff_session_start', tests.id('salesman_a')),
    tests.cmd('c2', 2, 'sale', tests.id('salesman_a'), jsonb_build_object(
      'id', tests.id('os1'), 'local_seq', 101, 'drawer_session_id', tests.id('drawer_session_a1'), 'grand_total', 500,
      'lines', jsonb_build_array(jsonb_build_object('id', tests.id('os1:line'), 'product_unit_id', tests.id('product_unit_a'),
                                                    'batch_id', tests.id('batch_a'), 'qty', 2, 'unit_price', 250)),
      'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'tendered', 500)))),
    -- A bill for a batch that doesn't exist: cannot be applied.
    tests.cmd('c3', 3, 'sale', tests.id('salesman_a'), jsonb_build_object(
      'id', tests.id('os2'), 'local_seq', 102, 'drawer_session_id', tests.id('drawer_session_a1'),
      'lines', jsonb_build_array(jsonb_build_object('product_unit_id', tests.id('product_unit_a'), 'batch_id', tests.id('no_such_batch'),
                                                    'qty', 1, 'unit_price', 250)),
      'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'tendered', 250)))),
    tests.cmd('c4', 4, 'held_bill', tests.id('salesman_a'), jsonb_build_object('id', tests.id('hb1'), 'label', 'Uncle', 'cart', '{"lines":[]}'::jsonb)),
    -- From a newer app version: unknown here.
    tests.cmd('c5', 5, 'teleport', tests.id('salesman_a')))
$$;
grant execute on function tests.upload() to authenticated;

-- Only a registered PC uploads.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select throws_ok($$select public.apply_device_commands(tests.upload())$$, '42501', null, 'an owner session cannot upload counter commands');
reset role;

select tests.as_device(tests.id('auth_device_a1'));
select tests.keep('r1', public.apply_device_commands(tests.upload()));
reset role;
select is((select jsonb_agg(x ->> 'status' order by ord) from jsonb_array_elements(tests.kept('r1')) with ordinality t(x, ord)),
          '["applied","applied","rejected","applied","rejected"]'::jsonb, 'each command gets its own result, in order');
select is((select qty_base from stock_balances where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a')), 88::bigint,
          'the offline sale took 2 from stock (90 → 88)');
select ok(exists (select 1 from user_sessions where id = tests.id('offline_sess') and user_id = tests.id('salesman_a')),
          'the offline sign-in is recorded');
select ok(exists (select 1 from held_bills where id = tests.id('hb1')), 'the held bill arrived');
select ok(exists (select 1 from device_commands where id = tests.id('c3') and status = 'rejected' and error is not null
                                               and payload ->> 'id' = tests.id('os2')::text),
          'the failed bill is kept with its error and its full contents');
select ok(exists (select 1 from device_commands where id = tests.id('c5') and status = 'rejected' and kind = 'teleport'),
          'an unknown command is kept, not dropped');
select is((select count(*) from sync_flags where reference_type = 'device_command' and reference_id in (tests.id('c3'), tests.id('c5'))),
          2::bigint, 'the owner is told about both');
select is((select last_command_seq from devices where id = tests.id('device_a1')), 5::bigint, 'the PC''s last upload is remembered');

-- The same upload again (the connection dropped before the answer arrived).
select tests.as_device(tests.id('auth_device_a1'));
select tests.keep('r2', public.apply_device_commands(tests.upload()));
reset role;
select is((select count(*) from jsonb_array_elements(tests.kept('r2')) x where (x ->> 'duplicate')::boolean), 5::bigint,
          'every command is recognised as already received');
select is((select qty_base from stock_balances where branch_id = tests.id('branch_a1') and batch_id = tests.id('batch_a')), 88::bigint,
          'nothing is applied twice');
select is((select count(*) from sync_flags where reference_type = 'device_command'), 2::bigint, 'and nothing is flagged twice');

-- A different command reusing a sequence number is kept aside; the rest of the upload goes through.
select tests.as_device(tests.id('auth_device_a1'));
select tests.keep('r3', public.apply_device_commands(jsonb_build_array(
  tests.cmd('c6', 5, 'held_bill', tests.id('salesman_a'), jsonb_build_object('id', tests.id('hb2'), 'cart', '{}'::jsonb)),
  tests.cmd('c7', 6, 'held_bill', tests.id('salesman_a'), jsonb_build_object('id', tests.id('hb3'), 'cart', '{}'::jsonb)))));
reset role;
select is((select jsonb_agg(x ->> 'status' order by ord) from jsonb_array_elements(tests.kept('r3')) with ordinality t(x, ord)),
          '["rejected","applied"]'::jsonb, 'a reused sequence number is rejected, the next command still applies');
select ok(exists (select 1 from sync_flags where reference_id = tests.id('c6')), 'and the owner is told');

-- Someone disabled while the PC was offline: their offline sign-in arrives flagged.
select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));
select public.disable_user(tests.id('storekeeper_a'), 'left');
select tests.as_device(tests.id('auth_device_a1'));
select tests.keep('r4', public.apply_device_commands(jsonb_build_array(
  jsonb_build_object('id', tests.id('c8'), 'device_seq', 7, 'kind', 'staff_session_start', 'acting_user', tests.id('storekeeper_a'),
                     'session_id', tests.id('offline_sess2'), 'created_on_device_at', now(), 'payload', '{}'::jsonb))));
reset role;
select is(tests.kept('r4') -> 0 ->> 'status', 'flagged', 'a disabled person''s offline sign-in is flagged');
select ok(exists (select 1 from sync_flags where kind = 'permission_exceeded' and details::text like '%after being disabled%'),
          'the owner sees why');

-- Another pharmacy's owner sees none of it.
select tests.as_owner(tests.id('auth_owner_b'), tests.id('tenant_b'));
select is(tests.count_rows('device_commands'), 0::bigint, 'device commands stay inside the pharmacy');
reset role;

select * from finish();
rollback;
