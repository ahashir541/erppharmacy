-- 0034: deleting a pharmacy in Nuskha HQ erases it from its PCs too.
-- HQ keeps a list of the deleted pharmacy's licence keys (as SHA-256) and PCs. When one of those PCs
-- checks in (every hour while online), HQ answers with a signed "erase" order instead of a licence.
-- The PC makes a last backup, deletes its records and goes back to the setup screen; its encrypted
-- backups and backup key stay on the PC (and HQ keeps a copy of the key), so nothing is lost by mistake.

create table if not exists app.erase_orders (
  id            uuid primary key default app.uuid_v7(),
  key_sha256    text,
  install_id    uuid,
  pharmacy      text not null,
  ordered_at    timestamptz not null default now(),
  delivered_at  timestamptz,
  check (key_sha256 is not null or install_id is not null)
);
create index if not exists erase_orders_key on app.erase_orders (key_sha256);
create index if not exists erase_orders_install on app.erase_orders (install_id);
revoke all on app.erase_orders from public;

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

  -- Remember the pharmacy's keys and PCs: the next time one of its PCs checks in, HQ sends it a
  -- signed order to erase its data (its encrypted backups and backup key stay on that PC).
  insert into app.erase_orders (key_sha256, install_id, pharmacy)
  select k.key_sha256, null, ph.name from licence_keys k where k.tenant_id = p_tenant
  union all
  select null, i.id, ph.name from local_installs i where i.tenant_id = p_tenant;

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

create or replace function public.hq_checkin(p_key text, p_install uuid, p_info jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  tid uuid := app.licence_key_tenant(p_key);
  t tenants;
  pl plans;
  ins local_installs;
  until timestamptz;
  may boolean;
begin
  if tid is null then
    -- A deleted pharmacy: its PC gets a signed order to erase its data.
    if exists (select 1 from app.erase_orders e
               where e.key_sha256 = encode(sha256(convert_to(upper(trim(coalesce(p_key, ''))), 'UTF8')), 'hex')
                  or (p_install is not null and e.install_id = p_install)) then
      update app.erase_orders e set delivered_at = coalesce(e.delivered_at, now())
      where e.key_sha256 = encode(sha256(convert_to(upper(trim(coalesce(p_key, ''))), 'UTF8')), 'hex')
         or (p_install is not null and e.install_id = p_install);
      return jsonb_build_object('kind', 'erase', 'install_id', p_install, 'issued_at', now(),
        'pharmacy', (select e.pharmacy from app.erase_orders e
                     where e.key_sha256 = encode(sha256(convert_to(upper(trim(coalesce(p_key, ''))), 'UTF8')), 'hex')
                        or (p_install is not null and e.install_id = p_install) order by e.ordered_at desc limit 1));
    end if;
    raise exception 'This licence key is not valid. Ask Nuskha for your key.' using errcode = '42501', hint = 'bad_key';
  end if;
  if p_install is null then raise exception 'Install id is required' using errcode = '22023'; end if;
  select * into ins from local_installs where id = p_install;
  if found and ins.tenant_id <> tid then
    raise exception 'This PC belongs to another pharmacy' using errcode = '42501', hint = 'wrong_pharmacy';
  end if;
  insert into local_installs (id, tenant_id, machine, app_version, stats)
  values (p_install, tid, left(p_info ->> 'machine', 100), left(p_info ->> 'version', 30), coalesce(p_info -> 'stats', '{}'))
  on conflict (id) do update set last_checkin_at = now(), checkins = local_installs.checkins + 1,
    machine = excluded.machine, app_version = excluded.app_version, stats = excluded.stats
  returning * into ins;
  select * into t from tenants where id = tid;
  select * into pl from plans where id = t.plan_id;
  may := t.status in ('trial', 'active', 'grace') and ins.blocked_at is null;
  until := now() + make_interval(days => t.offline_licence_days);
  if t.read_only_from is not null then until := least(until, t.read_only_from); end if;
  if t.status = 'trial' and t.trial_ends_at is not null then until := least(until, t.trial_ends_at + interval '1 day'); end if;
  return jsonb_build_object(
    'kind', 'pharmacy', 'tenant_id', t.id, 'install_id', ins.id, 'pharmacy', t.name, 'plan', pl.code, 'plan_name', pl.name,
    'status', case when ins.blocked_at is not null then 'suspended' else t.status end, 'may_sell', may,
    'trial_ends_at', t.trial_ends_at, 'grace_ends_at', t.grace_ends_at, 'read_only_from', t.read_only_from,
    'issued_at', now(), 'valid_until', case when may then until else now() end,
    'features', (select coalesce(jsonb_object_agg(f.code, jsonb_build_object('enabled', x.enabled, 'limit', x.limit_value)), '{}')
                 from features f cross join lateral app.tenant_feature(t.id, f.code) x),
    'announcements', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'title_ur', a.title_ur, 'body', a.body,
                        'body_ur', a.body_ur, 'severity', a.severity) order by a.starts_at desc), '[]')
                      from announcements a where a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())
                        and (a.audience = 'all' or (a.audience = 'plan' and a.plan_id = t.plan_id) or (a.audience = 'tenant' and a.tenant_id = t.id))),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'invoice_number', i.invoice_number, 'amount', i.amount, 'currency', i.currency,
                   'due_at', i.due_at, 'status', i.status) order by i.due_at), '[]')
                 from platform_invoices i where i.tenant_id = t.id and i.status in ('due', 'overdue', 'submitted')),
    'payment_instructions', (select value #>> '{}' from platform_settings where key = 'payment_instructions'),
    'update', app.release_offer(t.id, 'local', p_info ->> 'version'));
end $$;

revoke all on function public.platform_delete_pharmacy(uuid, text) from public, anon;
grant execute on function public.platform_delete_pharmacy(uuid, text) to authenticated;
revoke all on function public.hq_checkin(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.hq_checkin(text, uuid, jsonb) to service_role;
