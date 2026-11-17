-- 0023: Phase 8 — the super-admin console and launch. Tenant lifecycle (trial → active → grace →
-- read-only at closing time → suspended / cancelled), offline licence claims, plans and feature
-- flags with rollouts, announcements, releases and the minimum app version, billing and the revenue
-- dashboard, the tenant health page (no money in it), support tickets and time-limited support
-- access, "export all my data", and the onboarding checklist.

-- The signed-in platform admin (with 2FA), or an error.
create or replace function app.platform_admin() returns uuid
language plpgsql stable security definer set search_path = public, app as $$
declare aid uuid;
begin
  select id into aid from platform_admins where auth_user_id = auth.uid() and is_active;
  if aid is null or not app.is_platform_admin() then
    raise exception 'Platform admin sign-in with 2FA is required' using errcode = '42501';
  end if;
  return aid;
end $$;

create or replace function app.platform_log(p_admin uuid, p_tenant uuid, p_action text, p_details jsonb) returns void
language sql security definer set search_path = public, app as $$
  insert into platform_audit_log (admin_id, tenant_id, action, details) values (p_admin, p_tenant, p_action, coalesce(p_details, '{}'))
$$;

-- ---- Lifecycle ---------------------------------------------------------------------------------
-- The next closing time of the pharmacy (its latest-closing branch; 22:00 when none is set), so
-- read-only mode never starts in the middle of a working day (brief).
create or replace function app.next_closing(p_tenant uuid, p_now timestamptz default now()) returns timestamptz
language sql stable security definer set search_path = public, app as $$
  with c as (
    select coalesce(max(b.closing_time), time '22:00') as closes, coalesce(min(b.time_zone), t.time_zone) as tz
    from tenants t left join branches b on b.tenant_id = t.id and b.archived_at is null
    where t.id = p_tenant group by t.time_zone)
  select case when ((p_now at time zone c.tz)::date + c.closes) at time zone c.tz > p_now
              then ((p_now at time zone c.tz)::date + c.closes) at time zone c.tz
              else ((p_now at time zone c.tz)::date + 1 + c.closes) at time zone c.tz end
  from c
$$;

create or replace function app.set_tenant_status(p_tenant uuid, p_status text, p_admin uuid, p_reason text, p_now timestamptz)
returns void
language plpgsql security definer set search_path = public, app as $$
declare t tenants;
begin
  select * into t from tenants where id = p_tenant for update;
  if not found then raise exception 'Pharmacy not found' using errcode = 'P0002'; end if;
  if t.status = p_status then return; end if;
  if t.status = 'cancelled' and p_status <> 'active' then
    raise exception 'A cancelled pharmacy can only be re-activated' using errcode = 'P0001';
  end if;
  update tenants set
    status = p_status,
    grace_ends_at = case when p_status = 'grace' then coalesce(grace_ends_at, p_now + interval '7 days') when p_status = 'active' then null else grace_ends_at end,
    read_only_from = case when p_status = 'active' then null when p_status = 'read_only' then coalesce(read_only_from, p_now) else read_only_from end,
    cancelled_at = case when p_status = 'cancelled' then p_now when p_status = 'active' then null else cancelled_at end,
    purge_after = case when p_status = 'cancelled' then p_now + interval '90 days' when p_status = 'active' then null else purge_after end
  where id = p_tenant;
  perform app.platform_log(p_admin, p_tenant, 'tenant_status', jsonb_build_object('from', t.status, 'to', p_status, 'reason', p_reason));
  perform app.notify(p_tenant, 'account', case p_status
      when 'grace' then 'Payment overdue'
      when 'read_only' then 'MedFlow is read-only'
      when 'suspended' then 'MedFlow is suspended'
      when 'cancelled' then 'MedFlow subscription cancelled'
      else 'MedFlow is active' end,
    case p_status
      when 'grace' then 'Please pay your MedFlow invoice within 7 days to keep selling.'
      when 'read_only' then 'You can still see and export everything, but not sell. Pay the invoice to continue.'
      when 'suspended' then 'Please contact MedFlow.'
      when 'cancelled' then 'Export your data within 90 days; after that it is deleted.'
      else 'Thank you. Everything is working normally.' end,
    'tenant', p_tenant);
end $$;

-- The platform owner moves a pharmacy by hand. Read-only is scheduled for closing time.
create or replace function public.platform_set_tenant_status(p_tenant uuid, p_status text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  at timestamptz;
begin
  if p_status not in ('trial', 'active', 'grace', 'read_only', 'suspended', 'cancelled') then
    raise exception 'Unknown status %', p_status using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  if p_status = 'read_only' then
    at := app.next_closing(p_tenant);
    update tenants set read_only_from = at where id = p_tenant;
    perform app.platform_log(aid, p_tenant, 'read_only_scheduled', jsonb_build_object('from', at, 'reason', p_reason));
    return jsonb_build_object('status', (select status from tenants where id = p_tenant), 'read_only_from', at);
  end if;
  perform app.set_tenant_status(p_tenant, p_status, aid, p_reason, now());
  return jsonb_build_object('status', p_status);
end $$;

-- Runs every 15 minutes (cron, service role): trials end, invoices fall overdue, grace runs out,
-- read-only starts at closing time, owners are reminded before an invoice is due.
create or replace function public.platform_tick(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  t record;
  i record;
  moved int := 0;
  reminded int := 0;
begin
  update platform_invoices set status = 'overdue' where status = 'due' and due_at < p_now;

  -- A trial that ended without a paid invoice, or an overdue invoice: grace period.
  for t in select tn.* from tenants tn
           where (tn.status = 'trial' and tn.trial_ends_at < p_now
                  and not exists (select 1 from platform_invoices pi where pi.tenant_id = tn.id and pi.status = 'paid'))
              or (tn.status = 'active' and exists (select 1 from platform_invoices pi where pi.tenant_id = tn.id and pi.status = 'overdue'))
  loop
    perform app.set_tenant_status(t.id, 'grace', null, 'automatic: ' || case when t.status = 'trial' then 'trial ended' else 'invoice overdue' end, p_now);
    moved := moved + 1;
  end loop;

  -- Grace over: read-only from the next closing time.
  update tenants set read_only_from = app.next_closing(id, p_now)
  where status = 'grace' and grace_ends_at < p_now and read_only_from is null;
  for t in select * from tenants where status = 'grace' and read_only_from is not null and read_only_from <= p_now loop
    perform app.set_tenant_status(t.id, 'read_only', null, 'automatic: grace period ended', p_now);
    moved := moved + 1;
  end loop;
  -- Read-only scheduled by hand.
  for t in select * from tenants where status in ('trial', 'active') and read_only_from is not null and read_only_from <= p_now loop
    perform app.set_tenant_status(t.id, 'read_only', null, 'scheduled', p_now);
    moved := moved + 1;
  end loop;

  -- Three days before an invoice is due, and when it is overdue.
  for i in select pi.* from platform_invoices pi where pi.status in ('due', 'overdue')
           and (pi.status = 'overdue' or pi.due_at < p_now + interval '3 days') loop
    reminded := reminded + app.notify(i.tenant_id, 'billing',
      case when i.status = 'overdue' then 'MedFlow invoice overdue' else 'MedFlow invoice due soon' end,
      'Invoice ' || i.invoice_number || ' for ' || app.money_text(i.amount) || ' is due on ' || to_char(i.due_at at time zone 'Asia/Karachi', 'DD Mon YYYY')
      || '. Pay by bank transfer, JazzCash or Easypaisa and enter the reference in Settings → Billing.',
      'platform_invoice', i.id, null, interval '3 days');
  end loop;

  return jsonb_build_object('status_changes', moved, 'reminders', reminded,
                            'to_purge', (select coalesce(jsonb_agg(id), '[]') from tenants where status = 'cancelled' and purge_after < p_now));
end $$;

-- ---- Offline licence ------------------------------------------------------------------------------
-- What a counter's signed licence says: it may keep selling offline until valid_until. The
-- device-licence Edge Function signs these claims (Ed25519); the counter checks the signature
-- with MedFlow's public key (packages/core licence.ts). Only a hash of the token is kept.
create or replace function public.device_licence_claims() returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  dev devices;
  t tenants;
  until timestamptz;
begin
  select * into dev from devices where id = app.current_device_id() and status = 'active';
  if dev.id is null or not app.is_device() then raise exception 'A registered pharmacy PC is required' using errcode = '42501'; end if;
  select * into t from tenants where id = dev.tenant_id;
  until := now() + make_interval(days => t.offline_licence_days);
  -- Never past the start of read-only mode, so an offline PC stops selling when the pharmacy does.
  if t.read_only_from is not null then until := least(until, t.read_only_from); end if;
  update devices set last_seen_at = now() where id = dev.id;
  return jsonb_build_object('tenant_id', t.id, 'device_id', dev.id, 'branch_id', dev.branch_id,
    'may_sell', t.status in ('trial', 'active', 'grace'), 'status', t.status,
    'issued_at', now(), 'valid_until', case when t.status in ('trial', 'active', 'grace') then until else now() end,
    'features', (select coalesce(jsonb_object_agg(f.code, jsonb_build_object('enabled', x.enabled, 'limit', x.limit_value)), '{}')
                 from features f cross join lateral app.tenant_feature(t.id, f.code) x));
end $$;

-- The Edge Function records the hash of the token it signed (service role).
create or replace function public.platform_record_licence(p_device uuid, p_token_sha256 text, p_valid_until timestamptz) returns void
language sql security definer set search_path = public, app as $$
  insert into device_licences (tenant_id, device_id, token_sha256, valid_until)
  select tenant_id, id, p_token_sha256, p_valid_until from devices where id = p_device
$$;

-- ---- Features ------------------------------------------------------------------------------------
-- Most specific wins: a tenant override, then a rollout for the tenant's plan, then a percentage
-- rollout (the same pharmacies always fall in the same slice), then a global switch, then the plan.
create or replace function app.tenant_feature(p_tenant uuid, p_code text)
returns table (enabled boolean, limit_value bigint)
language sql stable security definer set search_path = public, app as $$
  select coalesce(o.enabled, rp.enabled, rpct.enabled, rg.enabled, pf.enabled, false),
         case when o.id is not null then o.limit_value else pf.limit_value end
  from tenants t
  left join plan_features pf on pf.plan_id = t.plan_id and pf.feature_code = p_code
  left join tenant_feature_overrides o
         on o.tenant_id = t.id and o.feature_code = p_code and (o.expires_at is null or o.expires_at > now())
  left join lateral (select r.enabled from feature_rollouts r where r.feature_code = p_code and r.scope = 'plan' and r.plan_id = t.plan_id
                     order by r.created_at desc limit 1) rp on true
  left join lateral (select r.enabled from feature_rollouts r where r.feature_code = p_code and r.scope = 'percentage'
                       and abs(hashtext(t.id::text || ':' || p_code)) % 100 < r.percentage
                     order by r.created_at desc limit 1) rpct on true
  left join lateral (select r.enabled from feature_rollouts r where r.feature_code = p_code and r.scope = 'global'
                     order by r.created_at desc limit 1) rg on true
  where t.id = p_tenant
$$;

create or replace function public.my_features() returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_object_agg(f.code, jsonb_build_object('enabled', x.enabled, 'limit', x.limit_value)), '{}')
  from features f cross join lateral app.tenant_feature(app.tenant_id(), f.code) x
  where app.tenant_id() is not null
$$;

create or replace function public.platform_save_plan(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  pid uuid;
  f record;
begin
  insert into plans (code, name, currency, price_monthly, price_yearly, trial_days, is_public, sort_order)
  values (p ->> 'code', p ->> 'name', coalesce(p ->> 'currency', 'PKR'), coalesce((p ->> 'price_monthly')::bigint, 0),
          coalesce((p ->> 'price_yearly')::bigint, 0), coalesce((p ->> 'trial_days')::int, 14), coalesce((p ->> 'is_public')::boolean, true),
          coalesce((p ->> 'sort_order')::int, 0))
  on conflict (code) do update set name = excluded.name, price_monthly = excluded.price_monthly, price_yearly = excluded.price_yearly,
    trial_days = excluded.trial_days, is_public = excluded.is_public, sort_order = excluded.sort_order
  returning id into pid;
  for f in select key, value from jsonb_each(coalesce(p -> 'features', '{}')) loop
    if not exists (select 1 from features where code = f.key) then raise exception 'Unknown feature %', f.key using errcode = '22023'; end if;
    insert into plan_features (plan_id, feature_code, enabled, limit_value)
    values (pid, f.key, coalesce((f.value ->> 'enabled')::boolean, true), (f.value ->> 'limit')::bigint)
    on conflict (plan_id, feature_code) do update set enabled = excluded.enabled, limit_value = excluded.limit_value;
  end loop;
  perform app.platform_log(aid, null, 'plan_saved', p);
  return pid;
end $$;

create or replace function public.platform_set_tenant_feature(p_tenant uuid, p_feature text, p_enabled boolean, p_limit bigint default null,
                                                              p_reason text default '', p_expires_at timestamptz default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare aid uuid := app.platform_admin();
begin
  insert into tenant_feature_overrides (tenant_id, feature_code, enabled, limit_value, reason, expires_at, created_by)
  values (p_tenant, p_feature, p_enabled, p_limit, coalesce(p_reason, ''), p_expires_at, aid)
  on conflict (tenant_id, feature_code) do update
    set enabled = excluded.enabled, limit_value = excluded.limit_value, reason = excluded.reason, expires_at = excluded.expires_at;
  perform app.platform_log(aid, p_tenant, 'feature_override',
                           jsonb_build_object('feature', p_feature, 'enabled', p_enabled, 'limit', p_limit, 'reason', p_reason));
end $$;

create or replace function public.platform_set_rollout(p_feature text, p_scope text, p_enabled boolean, p_plan_code text default null,
                                                       p_percentage int default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  rid uuid;
begin
  insert into feature_rollouts (feature_code, scope, plan_id, percentage, enabled, created_by)
  values (p_feature, p_scope, (select id from plans where code = p_plan_code), p_percentage, p_enabled, aid)
  returning id into rid;
  perform app.platform_log(aid, null, 'rollout', jsonb_build_object('feature', p_feature, 'scope', p_scope, 'plan', p_plan_code,
                                                                     'percentage', p_percentage, 'enabled', p_enabled));
  return rid;
end $$;

-- ---- Announcements --------------------------------------------------------------------------------
create or replace function public.platform_announce(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  nid uuid;
begin
  insert into announcements (title, title_ur, body, body_ur, severity, audience, plan_id, tenant_id, starts_at, ends_at, created_by)
  values (p ->> 'title', p ->> 'title_ur', p ->> 'body', p ->> 'body_ur', coalesce(p ->> 'severity', 'info'), coalesce(p ->> 'audience', 'all'),
          (select id from plans where code = p ->> 'plan_code'), (p ->> 'tenant_id')::uuid,
          coalesce((p ->> 'starts_at')::timestamptz, now()), (p ->> 'ends_at')::timestamptz, aid)
  returning id into nid;
  perform app.platform_log(aid, (p ->> 'tenant_id')::uuid, 'announcement', p);
  return nid;
end $$;

create or replace function public.my_announcements() returns jsonb
language sql stable security definer set search_path = public, app as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'severity', a.severity,
           'title', case when t.default_language = 'ur' then coalesce(a.title_ur, a.title) else a.title end,
           'body', case when t.default_language = 'ur' then coalesce(a.body_ur, a.body) else a.body end,
           'title_en', a.title, 'title_ur', a.title_ur, 'body_en', a.body, 'body_ur', a.body_ur)
         order by case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end, a.starts_at desc), '[]')
  from announcements a join tenants t on t.id = app.tenant_id()
  where a.starts_at <= now() and (a.ends_at is null or a.ends_at > now())
    and (a.audience = 'all' or (a.audience = 'plan' and a.plan_id = t.plan_id) or (a.audience = 'tenant' and a.tenant_id = t.id))
$$;

-- ---- Releases and updates -------------------------------------------------------------------------
-- Versions are compared number by number (1.10.0 > 1.9.3).
create or replace function app.version_cmp(a text, b text) returns int
language sql immutable as $$
  select case when x < y then -1 when x > y then 1 else 0 end
  from (select (select array_agg(coalesce(nullif(regexp_replace(p, '[^0-9]', '', 'g'), ''), '0')::int)
                from unnest(string_to_array(split_part(a, '-', 1), '.')) p) x,
               (select array_agg(coalesce(nullif(regexp_replace(p, '[^0-9]', '', 'g'), ''), '0')::int)
                from unnest(string_to_array(split_part(b, '-', 1), '.')) p) y) v
$$;

create or replace function public.platform_publish_release(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  rid uuid;
begin
  if (p ->> 'app') = 'desktop' and coalesce(p ->> 'signature', '') = '' then
    raise exception 'Desktop releases must be signed (Tauri updater signature)' using errcode = '22023';
  end if;
  insert into app_releases (app, version, channel, notes, artifact_url, signature, published_at, created_by)
  values (p ->> 'app', p ->> 'version', coalesce(p ->> 'channel', 'internal'), coalesce(p ->> 'notes', ''), p ->> 'artifact_url',
          p ->> 'signature', now(), aid)
  on conflict (app, version, channel) do update set notes = excluded.notes, artifact_url = excluded.artifact_url,
    signature = excluded.signature, published_at = now(), rolled_back_at = null
  returning id into rid;
  perform app.platform_log(aid, null, 'release_published', p - 'signature');
  return rid;
end $$;

-- Pulls a bad release: PCs that have not installed it stay where they are, and PCs that have get
-- the previous version offered as the update (Tauri installs it as a downgrade).
create or replace function public.platform_rollback_release(p_release uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare aid uuid := app.platform_admin();
begin
  update app_releases set rolled_back_at = now() where id = p_release and rolled_back_at is null;
  if not found then raise exception 'Release not found or already rolled back' using errcode = 'P0002'; end if;
  perform app.platform_log(aid, null, 'release_rolled_back', jsonb_build_object('release_id', p_release, 'reason', p_reason));
end $$;

create or replace function public.platform_set_min_version(p_app text, p_version text) returns void
language plpgsql security definer set search_path = public, app as $$
declare aid uuid := app.platform_admin();
begin
  insert into platform_settings (key, value, updated_by) values ('min_app_version.' || p_app, to_jsonb(p_version), aid)
  on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  perform app.platform_log(aid, null, 'min_version', jsonb_build_object('app', p_app, 'version', p_version));
end $$;

-- Asked by an app at start and every few hours. Channels: internal sees internal, beta and stable;
-- beta sees beta and stable; stable only stable. A rolled-back version is never offered; if this
-- PC runs one, the newest good version below it is offered instead. The app installs at next start
-- or after closing time, never mid-sale (it is told when closing time is).
create or replace function public.check_for_update(p_app text, p_current text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  t tenants;
  dev devices;
  channel text;
  r app_releases;
  minv text;
  bad boolean;
begin
  if app.tenant_id() is null then raise exception 'Sign-in required' using errcode = '42501'; end if;
  select * into t from tenants where id = app.tenant_id();
  select * into dev from devices where id = app.current_device_id();
  channel := coalesce(dev.release_channel, t.release_channel);
  if dev.id is not null then update devices set app_version = p_current, last_seen_at = now() where id = dev.id; end if;
  bad := exists (select 1 from app_releases where app = p_app and version = p_current and rolled_back_at is not null);
  select * into r from app_releases x
  where x.app = p_app and x.published_at is not null and x.rolled_back_at is null
    and x.channel = any (case channel when 'internal' then array['internal', 'beta', 'stable'] when 'beta' then array['beta', 'stable']
                                      else array['stable'] end)
    and (case when bad then app.version_cmp(x.version, p_current) < 0 else app.version_cmp(x.version, p_current) > 0 end)
  order by string_to_array(regexp_replace(split_part(x.version, '-', 1), '[^0-9.]', '', 'g'), '.')::int[] desc
  limit 1;
  select value #>> '{}' into minv from platform_settings where key = 'min_app_version.' || p_app;
  return jsonb_build_object(
    'update_available', r.id is not null, 'version', r.version, 'channel', r.channel, 'notes', r.notes,
    'url', r.artifact_url, 'signature', r.signature, 'is_rollback', bad and r.id is not null,
    'must_update', minv is not null and app.version_cmp(p_current, minv) < 0, 'min_version', minv,
    'install_after', app.next_closing(t.id));
end $$;

-- ---- Billing ---------------------------------------------------------------------------------------
create or replace function public.platform_start_subscription(p_tenant uuid, p_plan_code text, p_cycle text default 'monthly',
                                                              p_price bigint default null, p_start timestamptz default now()) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  pl plans;
  sid uuid;
begin
  select * into pl from plans where code = p_plan_code and archived_at is null;
  if not found then raise exception 'Unknown plan %', p_plan_code using errcode = 'P0002'; end if;
  update subscriptions set status = 'cancelled', cancel_at = now() where tenant_id = p_tenant and status <> 'cancelled';
  insert into subscriptions (tenant_id, plan_id, billing_cycle, price, currency, status, current_period_start, current_period_end)
  values (p_tenant, pl.id, p_cycle, coalesce(p_price, case p_cycle when 'yearly' then pl.price_yearly else pl.price_monthly end),
          pl.currency, 'active', p_start, p_start + case p_cycle when 'yearly' then interval '1 year' else interval '1 month' end)
  returning id into sid;
  update tenants set plan_id = pl.id where id = p_tenant;
  perform app.platform_log(aid, p_tenant, 'subscription_started', jsonb_build_object('plan', p_plan_code, 'cycle', p_cycle, 'price', p_price));
  perform app.platform_issue_invoice(sid);
  return sid;
end $$;

-- The invoice for a subscription's current period (once), due 7 days after the period starts.
create or replace function app.platform_issue_invoice(p_subscription uuid) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  s subscriptions;
  iid uuid;
begin
  select * into s from subscriptions where id = p_subscription;
  select id into iid from platform_invoices where subscription_id = s.id and period_start = s.current_period_start and status <> 'void';
  if iid is not null then return iid; end if;
  insert into platform_invoices (tenant_id, subscription_id, invoice_number, amount, currency, period_start, period_end, due_at, status)
  values (s.tenant_id, s.id, 'MF-' || to_char(s.current_period_start, 'YYYYMM') || '-'
            || lpad((select count(*) + 1 from platform_invoices where to_char(period_start, 'YYYYMM') = to_char(s.current_period_start, 'YYYYMM'))::text, 4, '0'),
          s.price, s.currency, s.current_period_start, s.current_period_end, s.current_period_start + interval '7 days',
          case when s.price = 0 then 'paid' else 'due' end)
  returning id into iid;
  return iid;
end $$;

-- Rolls subscriptions into their next period and invoices it (cron, daily, service role).
create or replace function public.platform_run_billing(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  s subscriptions;
  n int := 0;
begin
  for s in select * from subscriptions where status in ('active', 'past_due') and current_period_end <= p_now for update loop
    while s.current_period_end <= p_now loop
      s.current_period_start := s.current_period_end;
      s.current_period_end := s.current_period_end + case s.billing_cycle when 'yearly' then interval '1 year' else interval '1 month' end;
    end loop;
    update subscriptions set current_period_start = s.current_period_start, current_period_end = s.current_period_end where id = s.id;
    perform app.platform_issue_invoice(s.id);
    n := n + 1;
  end loop;
  update subscriptions su set status = case when exists (select 1 from platform_invoices pi where pi.subscription_id = su.id and pi.status = 'overdue')
                                         then 'past_due' else 'active' end
  where su.status in ('active', 'past_due');
  return n;
end $$;

-- The pharmacy tells MedFlow it paid (works in read-only mode too: paying must always be possible).
create or replace function public.submit_platform_payment(p_invoice uuid, p_method text, p_amount bigint, p_reference text) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.current_user_id();
  pid uuid;
begin
  if uid is null or not (app.is_primary_owner() or app.has_perm('settings.manage')) then
    raise exception 'Only the owner can submit payments' using errcode = '42501';
  end if;
  if not exists (select 1 from platform_invoices where id = p_invoice and tenant_id = app.tenant_id() and status in ('due', 'overdue', 'submitted')) then
    raise exception 'Invoice not found or already paid' using errcode = 'P0002';
  end if;
  if coalesce(trim(p_reference), '') = '' then raise exception 'Enter the transaction reference' using errcode = '22023'; end if;
  insert into platform_payments (tenant_id, invoice_id, method, amount, reference, submitted_by)
  values (app.tenant_id(), p_invoice, p_method, p_amount, trim(p_reference), uid)
  returning id into pid;
  update platform_invoices set status = 'submitted' where id = p_invoice and status in ('due', 'overdue');
  return pid;
end $$;

-- The platform owner checks the money arrived. Paid in full: the pharmacy is active again at once.
create or replace function public.platform_review_payment(p_payment uuid, p_ok boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  pm platform_payments;
  inv platform_invoices;
begin
  select * into pm from platform_payments where id = p_payment and status = 'pending' for update;
  if not found then raise exception 'Payment not found or already reviewed' using errcode = 'P0002'; end if;
  update platform_payments set status = case when p_ok then 'verified' else 'rejected' end, reviewed_by = aid, reviewed_at = now(),
         review_note = p_note where id = pm.id;
  select * into inv from platform_invoices where id = pm.invoice_id;
  if p_ok and (select coalesce(sum(amount), 0) from platform_payments where invoice_id = inv.id and status = 'verified') >= inv.amount then
    update platform_invoices set status = 'paid', paid_at = now() where id = inv.id;
    if not exists (select 1 from platform_invoices where tenant_id = inv.tenant_id and status in ('overdue', 'due') and due_at < now())
       and (select status from tenants where id = inv.tenant_id) in ('trial', 'grace', 'read_only') then
      perform app.set_tenant_status(inv.tenant_id, 'active', aid, 'payment ' || pm.reference || ' verified', now());
    end if;
  elsif not p_ok then
    update platform_invoices set status = case when due_at < now() then 'overdue' else 'due' end where id = inv.id and status = 'submitted';
    perform app.notify(inv.tenant_id, 'billing', 'Payment not found',
                       'We could not find payment ' || pm.reference || '. ' || coalesce(p_note, 'Please check the reference.'), 'platform_invoice', inv.id);
  end if;
  perform app.platform_log(aid, inv.tenant_id, 'payment_reviewed', jsonb_build_object('payment', pm.id, 'ok', p_ok, 'note', p_note));
end $$;

-- MRR, pharmacies by status, churn, overdue, money in this month.
create or replace function public.platform_revenue_dashboard(p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare aid uuid := app.platform_admin();
begin
  return jsonb_build_object(
    'mrr', (select coalesce(sum(case billing_cycle when 'yearly' then app.div_round(price, 12) else price end), 0)
            from subscriptions where status in ('active', 'past_due')),
    'tenants', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from tenants group by status) x),
    'new_30_days', (select count(*) from tenants where created_at > p_now - interval '30 days'),
    'cancelled_30_days', (select count(*) from tenants where cancelled_at > p_now - interval '30 days'),
    'churn_bp', (select case when count(*) filter (where created_at < p_now - interval '30 days') > 0 then
                   app.div_round(count(*) filter (where cancelled_at > p_now - interval '30 days') * 10000,
                                 count(*) filter (where created_at < p_now - interval '30 days')) end from tenants),
    'overdue', (select coalesce(sum(amount), 0) from platform_invoices where status = 'overdue'),
    'overdue_tenants', (select count(distinct tenant_id) from platform_invoices where status = 'overdue'),
    'collected_this_month', (select coalesce(sum(amount), 0) from platform_payments where status = 'verified'
                             and reviewed_at >= date_trunc('month', p_now)),
    'payments_to_review', (select count(*) from platform_payments where status = 'pending'));
end $$;

-- ---- Health page (no money in it) -------------------------------------------------------------------
create or replace function public.platform_tenant_health(p_tenant uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare aid uuid := app.platform_admin();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'tenant_id', t.id, 'name', t.name, 'status', t.status, 'plan', (select code from plans where id = t.plan_id),
      'release_channel', t.release_channel,
      'devices', (select coalesce(jsonb_agg(jsonb_build_object('device_id', d.id, 'name', d.name, 'kind', d.kind, 'status', d.status,
                    'app_version', d.app_version, 'last_seen_at', d.last_seen_at, 'last_sync_at', d.last_sync_at,
                    'offline_hours', round(extract(epoch from now() - d.last_seen_at)::numeric / 3600, 1),
                    'rejected_uploads_7d', (select count(*) from device_commands c where c.device_id = d.id and c.status = 'rejected'
                                            and c.created_at > now() - interval '7 days')) order by d.name), '[]')
                  from devices d where d.tenant_id = t.id and d.archived_at is null),
      'open_flags', (select count(*) from sync_flags f where f.tenant_id = t.id and f.status = 'open'),
      'errors_7d', (select count(*) from device_commands c where c.tenant_id = t.id and c.status = 'rejected' and c.created_at > now() - interval '7 days'),
      'last_backup', (select max(created_at) from tenant_backups b where b.tenant_id = t.id),
      'last_restore_test_ok', (select restore_test_ok from tenant_backups b where b.tenant_id = t.id and b.restore_tested_at is not null
                               order by b.restore_tested_at desc limit 1),
      'rows', jsonb_build_object('products', (select count(*) from products where tenant_id = t.id),
                                 'sales_30d', (select count(*) from sales where tenant_id = t.id and sold_at > now() - interval '30 days'),
                                 'stock_movements', (select count(*) from stock_movements where tenant_id = t.id)),
      'open_tickets', (select count(*) from support_tickets s where s.tenant_id = t.id and s.status in ('open', 'waiting_on_customer')))
      order by t.name), '[]')
    from tenants t where p_tenant is null or t.id = p_tenant);
end $$;

-- An uptime monitor's ping (anyone): the database answers.
create or replace function public.health() returns jsonb
language sql stable as $$ select jsonb_build_object('ok', true, 'at', now()) $$;

-- ---- Support ----------------------------------------------------------------------------------------
-- "Help" in the app: a ticket with the device's log file attached.
create or replace function public.open_support_ticket(p_subject text, p_body text, p_device_log_path text default null,
                                                      p_session uuid default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := coalesce(app.current_user_id(), (select user_id from user_sessions where id = p_session and device_id = app.current_device_id()
                                                and ended_at is null));
  tid uuid;
begin
  if uid is null or app.tenant_id() is null then raise exception 'Sign-in required' using errcode = '42501'; end if;
  if coalesce(trim(p_subject), '') = '' or coalesce(trim(p_body), '') = '' then
    raise exception 'Say what the problem is' using errcode = '22023';
  end if;
  insert into support_tickets (tenant_id, opened_by, subject, body, device_log_path, priority)
  values (app.tenant_id(), uid, trim(p_subject), trim(p_body), p_device_log_path, 'normal')
  returning id into tid;
  return tid;
end $$;

create or replace function public.reply_support_ticket(p_ticket uuid, p_body text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid;
  uid uuid := app.current_user_id();
  t support_tickets;
begin
  select * into t from support_tickets where id = p_ticket for update;
  if not found then raise exception 'Ticket not found' using errcode = 'P0002'; end if;
  if uid is not null and t.tenant_id = app.tenant_id() then
    insert into support_ticket_messages (ticket_id, author_user, body) values (t.id, uid, p_body);
    update support_tickets set status = 'open' where id = t.id and status = 'waiting_on_customer';
  else
    aid := app.platform_admin();
    insert into support_ticket_messages (ticket_id, author_admin, body) values (t.id, aid, p_body);
    update support_tickets set status = 'waiting_on_customer', assigned_to = coalesce(assigned_to, aid) where id = t.id;
    perform app.notify(t.tenant_id, 'support', 'MedFlow support replied', left(p_body, 200), 'support_ticket', t.id,
                       null, null, array[t.opened_by]);
  end if;
end $$;

-- Support asks; the owner decides. Without an active grant support sees only the health page.
create or replace function public.platform_request_support_access(p_tenant uuid, p_scope text, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare aid uuid := app.platform_admin();
begin
  perform app.notify(p_tenant, 'support_access', 'MedFlow support asks for access',
                     (select full_name from platform_admins where id = aid) || ' asks for ' || p_scope || ' access: ' || p_reason
                     || '. Approve it in Settings → Support, for up to 7 days.', 'platform_admin', aid);
  perform app.platform_log(aid, p_tenant, 'support_access_requested', jsonb_build_object('scope', p_scope, 'reason', p_reason));
end $$;

create or replace function public.grant_support_access(p_admin uuid, p_scope text, p_hours int, p_reason text) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('settings.manage');
  gid uuid;
begin
  if not app.is_primary_owner() then raise exception 'Only the primary owner can let support in' using errcode = '42501'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 168 then raise exception 'Between 1 hour and 7 days' using errcode = '22023'; end if;
  insert into support_access_grants (tenant_id, admin_id, scope, reason, expires_at, granted_by)
  values (app.tenant_id(), p_admin, p_scope, coalesce(p_reason, ''), now() + make_interval(hours => p_hours), uid)
  returning id into gid;
  perform app.log_event('support_access_granted', 'support_access_grants', gid, jsonb_build_object('scope', p_scope, 'hours', p_hours), null);
  return gid;
end $$;

create or replace function public.revoke_support_access(p_grant uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin('settings.manage');
begin
  update support_access_grants set revoked_at = now() where id = p_grant and tenant_id = app.tenant_id() and revoked_at is null;
  if not found then raise exception 'Grant not found' using errcode = 'P0002'; end if;
  perform app.log_event('support_access_revoked', 'support_access_grants', p_grant, '{}', null);
end $$;

create or replace function app.support_grant(p_tenant uuid, p_admin uuid, p_scope text) returns uuid
language sql stable security definer set search_path = public, app as $$
  select id from support_access_grants
  where tenant_id = p_tenant and admin_id = p_admin and revoked_at is null and starts_at <= now() and expires_at > now()
    and (scope = p_scope or (p_scope = 'technical' and scope in ('financial', 'impersonate')))
  order by expires_at desc limit 1
$$;

-- What support may look at with a technical grant: recent rejected uploads and open flags (with
-- their messages), every read logged in the platform audit log.
create or replace function public.platform_support_snapshot(p_tenant uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  aid uuid := app.platform_admin();
  g uuid := app.support_grant(p_tenant, aid, 'technical');
begin
  if g is null then raise exception 'The pharmacy owner has not given you access' using errcode = '42501'; end if;
  perform app.platform_log(aid, p_tenant, 'support_snapshot', jsonb_build_object('grant', g));
  return jsonb_build_object(
    'health', public.platform_tenant_health(p_tenant) -> 0,
    'rejected_uploads', (select coalesce(jsonb_agg(jsonb_build_object('at', c.created_at, 'device', c.device_id, 'kind', c.kind, 'error', c.error)
                                       order by c.created_at desc), '[]')
                         from (select * from device_commands where tenant_id = p_tenant and status = 'rejected' order by created_at desc limit 50) c),
    'open_flags', (select coalesce(jsonb_agg(jsonb_build_object('at', f.created_at, 'kind', f.kind, 'message', f.details ->> 'message')
                                 order by f.created_at desc), '[]')
                   from (select * from sync_flags where tenant_id = p_tenant and status = 'open' order by created_at desc limit 50) f));
end $$;

-- ---- Export all my data ----------------------------------------------------------------------------
-- The owner's data is theirs. Every pharmacy table, page by page (the web app writes Excel + JSON);
-- also used by the nightly backup (service role) for a chosen pharmacy.
create or replace function app.tenant_tables() returns setof text
language sql stable security definer set search_path = public, app as $$
  select c.table_name::text from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.column_name = 'tenant_id'
    and c.table_name not in ('platform_audit_log', 'device_licences', 'support_access_grants')
  order by 1
$$;

create or replace function app.export_table(p_tenant uuid, p_table text, p_offset bigint, p_limit int) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  rows jsonb;
begin
  if not exists (select 1 from app.tenant_tables() t where t = p_table) then raise exception 'Unknown table %', p_table using errcode = '22023'; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from (select * from public.%I where tenant_id = $1 order by 1 offset $2 limit $3) x', p_table)
    into rows using p_tenant, greatest(coalesce(p_offset, 0), 0), least(greatest(coalesce(p_limit, 1000), 1), 5000);
  return jsonb_build_object('table', p_table, 'offset', coalesce(p_offset, 0), 'rows', rows, 'count', jsonb_array_length(rows));
end $$;

create or replace function public.export_my_data(p_table text default null, p_offset bigint default 0, p_limit int default 1000) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.current_user_id();
begin
  -- Works in read-only and cancelled mode too: owners can always take their data.
  if uid is null or not (app.is_primary_owner() or app.has_perm('data.export')) then
    raise exception 'Only the owner can export all data' using errcode = '42501';
  end if;
  if p_table is null then
    perform app.log_event('export_started', 'tenants', app.tenant_id(), '{}', null);
    return jsonb_build_object('tables', (select jsonb_agg(t) from app.tenant_tables() t), 'exported_at', now());
  end if;
  return app.export_table(app.tenant_id(), p_table, p_offset, p_limit);
end $$;

create or replace function public.platform_export_table(p_tenant uuid, p_table text, p_offset bigint default 0, p_limit int default 1000) returns jsonb
language sql security definer set search_path = public, app as $$ select app.export_table(p_tenant, p_table, p_offset, p_limit) $$;

create or replace function public.platform_record_backup(p_tenant uuid, p_kind text, p_path text, p_size bigint, p_sha256 text,
                                                         p_restore_ok boolean default null) returns uuid
language sql security definer set search_path = public, app as $$
  insert into tenant_backups (tenant_id, kind, storage_path, size_bytes, sha256, expires_at, restore_tested_at, restore_test_ok)
  values (p_tenant, p_kind, p_path, p_size, p_sha256, now() + interval '30 days',
          case when p_restore_ok is not null then now() end, p_restore_ok)
  returning id
$$;

-- ---- Onboarding ------------------------------------------------------------------------------------
-- The setup wizard's checklist: what is done and what comes next.
create or replace function public.onboarding_status() returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  tid uuid := app.tenant_id();
  steps jsonb;
begin
  if app.current_user_id() is null or tid is null then raise exception 'Owner sign-in required' using errcode = '42501'; end if;
  steps := jsonb_build_array(
    jsonb_build_object('step', 'branch', 'title', 'Your shop', 'title_ur', 'آپ کی دکان', 'required', true,
                       'done', exists (select 1 from branches where tenant_id = tid and archived_at is null and coalesce(address, '') <> '')),
    jsonb_build_object('step', 'counter', 'title', 'Counter PC', 'title_ur', 'کاؤنٹر کمپیوٹر', 'required', true,
                       'done', exists (select 1 from devices where tenant_id = tid and kind = 'counter' and status = 'active')),
    jsonb_build_object('step', 'staff', 'title', 'Staff and PINs', 'title_ur', 'عملہ اور پن', 'required', false,
                       'done', exists (select 1 from users u join user_pins p on p.user_id = u.id where u.tenant_id = tid and u.kind = 'staff')),
    jsonb_build_object('step', 'products', 'title', 'Medicines', 'title_ur', 'ادویات', 'required', true,
                       'done', exists (select 1 from products where tenant_id = tid)),
    jsonb_build_object('step', 'opening_stock', 'title', 'Opening stock', 'title_ur', 'ابتدائی اسٹاک', 'required', true,
                       'done', exists (select 1 from stock_movements where tenant_id = tid and movement_type in ('opening', 'purchase'))),
    jsonb_build_object('step', 'opening_udhaar', 'title', 'Old khata balances', 'title_ur', 'پرانے کھاتے', 'required', false,
                       'done', exists (select 1 from ledger_entries where tenant_id = tid and entry_type = 'opening')),
    jsonb_build_object('step', 'first_sale', 'title', 'First sale', 'title_ur', 'پہلی فروخت', 'required', true,
                       'done', exists (select 1 from sales where tenant_id = tid)));
  return jsonb_build_object('steps', steps,
    'complete', not exists (select 1 from jsonb_array_elements(steps) s where (s ->> 'required')::boolean and not (s ->> 'done')::boolean),
    'next', (select s ->> 'step' from jsonb_array_elements(steps) with ordinality x(s, n) where not (s ->> 'done')::boolean order by n limit 1));
end $$;

-- ---- Grants -----------------------------------------------------------------------------------------
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke all on function %s from public, anon', f);
  end loop;
end $$;
revoke all on all functions in schema app from public;
grant execute on function
  public.platform_set_tenant_status(uuid, text, text), public.device_licence_claims(), public.my_features(),
  public.platform_save_plan(jsonb), public.platform_set_tenant_feature(uuid, text, boolean, bigint, text, timestamptz),
  public.platform_set_rollout(text, text, boolean, text, int), public.platform_announce(jsonb), public.my_announcements(),
  public.platform_publish_release(jsonb), public.platform_rollback_release(uuid, text), public.platform_set_min_version(text, text),
  public.check_for_update(text, text), public.platform_start_subscription(uuid, text, text, bigint, timestamptz),
  public.submit_platform_payment(uuid, text, bigint, text), public.platform_review_payment(uuid, boolean, text),
  public.platform_revenue_dashboard(timestamptz), public.platform_tenant_health(uuid), public.open_support_ticket(text, text, text, uuid),
  public.reply_support_ticket(uuid, text), public.platform_request_support_access(uuid, text, text),
  public.grant_support_access(uuid, text, int, text), public.revoke_support_access(uuid), public.platform_support_snapshot(uuid),
  public.export_my_data(text, bigint, int), public.onboarding_status()
  to authenticated;
grant execute on function public.health() to anon, authenticated;
-- Cron jobs and Edge Functions only.
revoke all on function public.platform_tick(timestamptz), public.platform_run_billing(timestamptz),
  public.platform_record_licence(uuid, text, timestamptz), public.platform_export_table(uuid, text, bigint, int),
  public.platform_record_backup(uuid, text, text, bigint, text, boolean) from authenticated;
grant execute on function public.platform_tick(timestamptz), public.platform_run_billing(timestamptz),
  public.platform_record_licence(uuid, text, timestamptz), public.platform_export_table(uuid, text, bigint, int),
  public.platform_record_backup(uuid, text, text, bigint, text, boolean) to service_role;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;
select app.assert_rls_everywhere();
