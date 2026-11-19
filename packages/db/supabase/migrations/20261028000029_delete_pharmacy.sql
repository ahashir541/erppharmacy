-- 0029: MedFlow HQ can delete a pharmacy for good (one made by mistake, a test, or one that left).
-- Two safety steps: the pharmacy must already be Cancelled, and the owner types its exact name.
-- Pharmacy rows are append-only or no-delete by design; this one function lifts those guards for
-- its own transaction only (session_replication_role, superuser: MedFlow HQ runs as one), removes
-- every row of that pharmacy from every table that has tenant_id, and puts the guards back.
-- It never touches the pharmacy's own PC: its MedFlow Local keeps its data, and with the licence key
-- gone it can no longer check in. The deletion itself is kept in the platform audit log.

create or replace function public.platform_delete_pharmacy(p_tenant uuid, p_confirm_name text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  t record;
  ph tenants;
  n bigint;
  total bigint := 0;
  touched int := 0;
begin
  select * into ph from tenants where id = p_tenant;
  if not found then raise exception 'Pharmacy not found' using errcode = 'P0002'; end if;
  if ph.status <> 'cancelled' then
    raise exception 'Cancel the pharmacy first (Change status → Cancelled), then delete it' using errcode = '22023';
  end if;
  if lower(trim(coalesce(p_confirm_name, ''))) <> lower(trim(ph.name)) then
    raise exception 'Type the pharmacy name exactly to delete it' using errcode = '22023';
  end if;

  set local session_replication_role = replica;  -- guards and foreign-key checks off, this transaction only

  delete from support_ticket_messages where ticket_id in (select id from support_tickets where tenant_id = p_tenant);
  get diagnostics n = row_count; total := total + n;
  -- Pharmacy sign-ins that belong to no one else (never a platform admin).
  delete from auth.users au where au.id in (select u.auth_user_id from users u where u.tenant_id = p_tenant and u.auth_user_id is not null)
    and not exists (select 1 from platform_admins pa where pa.auth_user_id = au.id)
    and not exists (select 1 from users u2 where u2.auth_user_id = au.id and u2.tenant_id <> p_tenant);
  get diagnostics n = row_count; total := total + n;

  for t in
    select c.relname from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition and c.relname <> 'tenants'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
    order by c.relname
  loop
    execute format('delete from public.%I where tenant_id = $1', t.relname) using p_tenant;
    get diagnostics n = row_count;
    if n > 0 then total := total + n; touched := touched + 1; end if;
  end loop;
  delete from tenants where id = p_tenant;

  set local session_replication_role = origin;

  perform app.platform_log(aid, null, 'pharmacy_deleted',
    jsonb_build_object('tenant_id', p_tenant, 'name', ph.name, 'city', ph.city, 'rows', total, 'tables', touched));
  return jsonb_build_object('deleted', ph.name, 'rows', total, 'tables', touched);
end $$;

revoke all on function public.platform_delete_pharmacy(uuid, text) from public, anon;
grant execute on function public.platform_delete_pharmacy(uuid, text) to authenticated;
