-- Removes the cloud test pharmacies made by cloud.e2e.mjs (named "TEST (cloud e2e) …" and cancelled),
-- with everything that belongs to them: their rows in every table, their owner and counter-PC logins.
-- Real pharmacies are never touched. Run: supabase db query --linked -f e2e/cloud-cleanup.sql
begin;
set local session_replication_role = replica;
create temp table _t on commit drop as
  select id from public.tenants where name like 'TEST (cloud e2e)%' and status = 'cancelled';
create temp table _a on commit drop as
  select u.auth_user_id as id from public.users u where u.tenant_id in (select id from _t) and u.auth_user_id is not null
  union
  select d.auth_user_id from public.devices d where d.tenant_id in (select id from _t) and d.auth_user_id is not null;
delete from public.support_ticket_messages where ticket_id in (select id from public.support_tickets where tenant_id in (select id from _t));
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
           where s.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition and c.relname <> 'tenants'
             and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
  loop
    execute format('delete from public.%I where tenant_id in (select id from _t)', r.relname);
  end loop;
end $$;
delete from auth.users au where au.id in (select id from _a)
  and not exists (select 1 from public.platform_admins pa where pa.auth_user_id = au.id);
delete from public.tenants where id in (select id from _t);
commit;
select count(*)::int as pharmacies_left from public.tenants;
