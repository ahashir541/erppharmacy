-- Owner live view (0038): the shop PC pushes with its secret push key, the owner reads with the
-- view code; parts merge; a new view code locks the old one out; forgetting deletes the copy;
-- nobody reaches the table directly.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

set local role anon;
select is((public.mirror_push(repeat('k', 64), encode(sha256(convert_to('NSK-AAAA-BBBB-CCCC-DDDD', 'UTF8')), 'hex'), '{"pharmacy": "Al Noor"}', '{"owner_dashboard": {"sales": 1}}') ->> 'ok'), 'true',
          'the shop PC can push without an account');
select is(public.mirror_read('nsk-aaaa-bbbb-cccc-dddd') #>> '{meta,pharmacy}', 'Al Noor', 'the owner reads with the view code (any letter case)');
select public.mirror_push(repeat('k', 64), encode(sha256(convert_to('NSK-AAAA-BBBB-CCCC-DDDD', 'UTF8')), 'hex'), '{"pharmacy": "Al Noor"}', '{"office_products": [1, 2]}');
select is(public.mirror_read('NSK-AAAA-BBBB-CCCC-DDDD') -> 'parts' ?& array['owner_dashboard', 'office_products'], true,
          'only changed screens are sent; the others stay');
select throws_ok($$select public.mirror_read('NSK-WRONG')$$, '42501', null, 'a wrong code reads nothing');
select throws_ok($$select public.mirror_push('short', repeat('a', 64), '{}', '{}')$$, '22023', null, 'a weak push key is refused');
select throws_ok($$select * from app.owner_mirrors$$, '42501', null, 'the table itself cannot be read');
select public.mirror_push(repeat('k', 64), encode(sha256(convert_to('NSK-NEW1-NEW2-NEW3-NEW4', 'UTF8')), 'hex'), '{"pharmacy": "Al Noor"}', '{}');
select throws_ok($$select public.mirror_read('NSK-AAAA-BBBB-CCCC-DDDD')$$, '42501', null, 'a new view code locks the old one out');
select is(public.mirror_read('NSK-NEW1-NEW2-NEW3-NEW4') #>> '{parts,owner_dashboard,sales}', '1', 'the new code sees the same copy');
-- 0039: the owner asks from home; the shop PC takes it, answers; the answer is read once.
select is(public.relay_ask('NSK-NEW1-NEW2-NEW3-NEW4', '00000000-0000-0000-0000-0000000000a1', '{"kind": "login", "pin": "2580"}'), true, 'the owner leaves a request');
select is(public.relay_take(repeat('k', 64)) #>> '{requests,0,body,pin}', '2580', 'the shop PC picks it up');
reset role;
select is((select count(*) from app.owner_requests where body ? 'pin')::int, 0, 'the PIN is not kept in the cloud after that');
set local role anon;
select is(public.relay_answer('NSK-NEW1-NEW2-NEW3-NEW4', '00000000-0000-0000-0000-0000000000a1') ->> 'status', 'taken', 'no answer yet while the shop works on it');
select is(public.relay_reply(repeat('k', 64), '00000000-0000-0000-0000-0000000000a1', true, '{"token": "t"}'), true, 'the shop answers');
select is(public.relay_answer('NSK-NEW1-NEW2-NEW3-NEW4', '00000000-0000-0000-0000-0000000000a1') #>> '{result,token}', 't', 'the owner gets the answer');
select is(public.relay_answer('NSK-NEW1-NEW2-NEW3-NEW4', '00000000-0000-0000-0000-0000000000a1') ->> 'status', 'gone', 'and it is deleted once read');
select throws_ok($$select public.relay_ask('NSK-WRONG', gen_random_uuid(), '{}')$$, '42501', null, 'a wrong code cannot ask the shop anything');
select is(public.relay_reply(repeat('z', 64), '00000000-0000-0000-0000-0000000000a1', true, '{}'), false, 'only the shop PC can answer');
select is(public.mirror_forget(repeat('k', 64)), true, 'turning sharing off deletes the copy');
select throws_ok($$select public.mirror_read('NSK-NEW1-NEW2-NEW3-NEW4')$$, '42501', null, 'after that, nothing to read');

select * from finish();
rollback;
