-- 0014 (Phase 1): sign-in token hook, plan features, tenant onboarding, and
-- the owner's staff / role / PIN / device / settings functions.
--
-- Every write function here:
--   * is SECURITY DEFINER with a fixed search_path,
--   * starts with app.rpc_begin(<permission>), which requires an owner
--     session with 2FA and the permission, and sets the audit context,
--   * refuses to write when the tenant is read-only, suspended or cancelled.

-- ---- Sign-in token hook --------------------------------------------------
-- Adds tenant_id / device_id / principal claims. An owner of several
-- pharmacies picks one with user_metadata.active_tenant_id; the hook only
-- accepts pharmacies where they really are an active owner.
create or replace function public.custom_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  claims  jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  uid     uuid := (event ->> 'user_id')::uuid;
  wanted  uuid := nullif(claims -> 'user_metadata' ->> 'active_tenant_id', '')::uuid;
  t       uuid;
  d       record;
begin
  select u.tenant_id into t
  from users u join tenants tn on tn.id = u.tenant_id
  where u.auth_user_id = uid and u.kind = 'owner' and u.status in ('invited', 'active')
    and u.archived_at is null and tn.status <> 'cancelled'
  order by (u.tenant_id = wanted) desc nulls last, u.created_at
  limit 1;

  if t is not null then
    claims := claims || jsonb_build_object('tenant_id', t, 'principal', 'owner');
  else
    select id, tenant_id, branch_id into d
    from devices where auth_user_id = uid and status = 'active' and archived_at is null;
    if found then
      claims := claims || jsonb_build_object('tenant_id', d.tenant_id, 'device_id', d.id,
                                             'branch_id', d.branch_id, 'principal', 'device');
    elsif exists (select 1 from platform_admins where auth_user_id = uid and is_active) then
      claims := claims || jsonb_build_object('principal', 'platform_admin');
    end if;
  end if;
  return jsonb_set(event, '{claims}', claims);
end $$;

revoke all on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- ---- Plan features ------------------------------------------------------
-- Tenant override (unexpired) beats the plan. A limit of null = unlimited.
create or replace function app.tenant_feature(p_tenant uuid, p_code text)
returns table (enabled boolean, limit_value bigint)
language sql stable security definer set search_path = public, app as $$
  select coalesce(o.enabled, pf.enabled, false),
         case when o.id is not null then o.limit_value else pf.limit_value end
  from tenants t
  left join plan_features pf on pf.plan_id = t.plan_id and pf.feature_code = p_code
  left join tenant_feature_overrides o
         on o.tenant_id = t.id and o.feature_code = p_code
        and (o.expires_at is null or o.expires_at > now())
  where t.id = p_tenant
$$;

create or replace function app.assert_within_limit(p_tenant uuid, p_code text, p_current bigint)
returns void
language plpgsql stable security definer set search_path = public, app as $$
declare
  lim bigint;
begin
  select limit_value into lim from app.tenant_feature(p_tenant, p_code);
  if lim is not null and p_current >= lim then
    raise exception 'Your plan allows % for %. Ask MedFlow to upgrade the plan.', lim, p_code
      using errcode = 'P0001', hint = 'plan_limit';
  end if;
end $$;

-- ---- RPC scaffolding ----------------------------------------------------
create or replace function app.assert_tenant_writable(p_tenant uuid) returns void
language plpgsql stable security definer set search_path = public, app as $$
begin
  if not exists (select 1 from tenants where id = p_tenant and status in ('trial', 'active', 'grace')) then
    raise exception 'This pharmacy is read-only. Please contact MedFlow.' using errcode = 'P0001', hint = 'tenant_read_only';
  end if;
end $$;

-- Owner session + permission + writable tenant; sets the audit context.
create or replace function app.rpc_begin(p_perm text) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.current_user_id();
begin
  if uid is null then
    raise exception 'Owner sign-in with 2FA is required' using errcode = '42501';
  end if;
  if p_perm is not null and not app.has_perm(p_perm) then
    raise exception 'Permission % is required', p_perm using errcode = '42501';
  end if;
  perform app.assert_tenant_writable(app.tenant_id());
  perform set_config('app.user_id', uid::text, true);
  return uid;
end $$;

-- Device session (counter principal) for counter-side writes.
create or replace function app.rpc_begin_device() returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  did uuid := app.current_device_id();
begin
  if did is null or not app.is_device() then
    raise exception 'A registered pharmacy PC is required' using errcode = '42501';
  end if;
  perform app.assert_tenant_writable(app.tenant_id());
  perform set_config('app.device_id', did::text, true);
  return did;
end $$;

create or replace function app.log_event(p_action text, p_table text, p_record uuid, p_context jsonb default '{}'::jsonb,
                                         p_branch uuid default null)
returns void
language sql security definer set search_path = public, app as $$
  insert into audit_log (tenant_id, branch_id, user_id, device_id, action, table_name, record_id, context)
  values (app.tenant_id(), p_branch, coalesce(app.ctx_user_id(), app.current_user_id()),
          coalesce(app.ctx_device_id(), app.current_device_id()), p_action, p_table, p_record, p_context)
$$;

-- Fetch a row of this tenant or fail (never reveals other tenants' rows).
create or replace function app.own_user(p_user uuid) returns users
language plpgsql stable security definer set search_path = public, app as $$
declare
  r users;
begin
  select * into r from users where id = p_user and tenant_id = app.tenant_id();
  if not found then raise exception 'Staff member not found' using errcode = 'P0002'; end if;
  return r;
end $$;

-- ---- Tenant defaults ----------------------------------------------------
-- Roles from the brief's matrix, the owner's role, base units, tax
-- categories (rates are set by the owner / tax adviser), default settings.
create or replace function app.seed_tenant_defaults(p_tenant uuid, p_owner uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  tpl record;
  rid uuid;
begin
  for tpl in select * from (values
      ('owner', 'Owner', 'مالک'), ('manager', 'Manager', 'منیجر'), ('pharmacist', 'Pharmacist', 'فارماسسٹ'),
      ('salesman', 'Salesman', 'سیلز مین'), ('storekeeper', 'Store keeper', 'اسٹور کیپر'),
      ('accountant', 'Accountant', 'اکاؤنٹنٹ')) as v(code, name, name_ur)
  loop
    insert into roles (tenant_id, name, name_ur, template_code, created_by)
    values (p_tenant, tpl.name, tpl.name_ur, tpl.code, p_owner)
    returning id into rid;
    insert into role_permissions (tenant_id, role_id, permission_code, allowed, needs_approval, limit_value, created_by)
    select p_tenant, rid, permission_code, allowed, needs_approval, limit_value, p_owner
    from role_template_permissions where template_code = tpl.code;
    if tpl.code = 'owner' then
      insert into user_roles (tenant_id, user_id, role_id, branch_id, created_by)
      values (p_tenant, p_owner, rid, null, p_owner);
    end if;
  end loop;

  insert into units (tenant_id, code, name, name_ur, created_by)
  select p_tenant, code, name, name_ur, p_owner from (values
    ('tablet', 'Tablet', 'گولی'), ('capsule', 'Capsule', 'کیپسول'), ('strip', 'Strip', 'پتّا'),
    ('box', 'Box', 'ڈبہ'), ('bottle', 'Bottle', 'بوتل'), ('tube', 'Tube', 'ٹیوب'),
    ('sachet', 'Sachet', 'ساشے'), ('vial', 'Vial', 'وائل'), ('ampoule', 'Ampoule', 'ایمپول'),
    ('piece', 'Piece', 'عدد')) as u(code, name, name_ur);

  insert into tax_categories (tenant_id, code, name, is_exempt, created_by) values
    (p_tenant, 'exempt_medicine', 'Medicines (exempt)', true, p_owner),
    (p_tenant, 'taxable', 'Taxable goods', false, p_owner);

  -- Defaults from docs/DECISIONS.md (D15-D25); the owner can change them.
  insert into settings (tenant_id, key, value, created_by) values
    (p_tenant, 'pos.recent_bills_days', '7', p_owner),
    (p_tenant, 'pos.bill_rounding_minor', '100', p_owner),
    (p_tenant, 'pos.loose_price_rounding', '"half_up_minor"', p_owner),
    (p_tenant, 'udhaar.default_due_days', '30', p_owner),
    (p_tenant, 'tax.prices_include_tax', 'true', p_owner),
    (p_tenant, 'tax.pos_service_charge_enabled', 'false', p_owner),
    (p_tenant, 'security.pin_max_attempts', '5', p_owner),
    (p_tenant, 'security.pin_lock_minutes', '15', p_owner),
    (p_tenant, 'compliance.controlled_retention_years', '5', p_owner);
end $$;

-- ---- Platform admin -----------------------------------------------------
create or replace function public.platform_provision_tenant(
  p_name text, p_owner_name text, p_owner_phone text, p_owner_email text,
  p_plan_code text, p_branch_code text, p_branch_name text,
  p_city text default '', p_currency char(3) default 'PKR', p_language text default 'en',
  p_time_zone text default 'Asia/Karachi')
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  admin_id uuid;
  pl plans;
  tid uuid;
  owner_id uuid;
  bid uuid;
begin
  select id into admin_id from platform_admins where auth_user_id = auth.uid() and is_active;
  if admin_id is null or not app.is_platform_admin() then
    raise exception 'Platform admin sign-in with 2FA is required' using errcode = '42501';
  end if;
  select * into pl from plans where code = p_plan_code and archived_at is null;
  if not found then raise exception 'Unknown plan %', p_plan_code using errcode = 'P0002'; end if;
  if p_branch_code !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'Branch code must be 2-8 capital letters or digits' using errcode = '22023';
  end if;

  insert into tenants (name, owner_name, owner_phone, owner_email, city, currency, default_language,
                       time_zone, status, plan_id, trial_ends_at)
  values (p_name, p_owner_name, p_owner_phone, lower(p_owner_email), p_city, p_currency, p_language,
          p_time_zone, 'trial', pl.id, now() + make_interval(days => pl.trial_days))
  returning id into tid;

  insert into users (tenant_id, kind, is_primary_owner, full_name, phone, email, status, preferred_language)
  values (tid, 'owner', true, p_owner_name, p_owner_phone, lower(p_owner_email), 'invited', p_language)
  returning id into owner_id;

  insert into branches (tenant_id, code, name, city, created_by)
  values (tid, p_branch_code, p_branch_name, p_city, owner_id)
  returning id into bid;

  perform app.seed_tenant_defaults(tid, owner_id);

  insert into platform_audit_log (admin_id, tenant_id, action, details)
  values (admin_id, tid, 'tenant.provision',
          jsonb_build_object('plan', p_plan_code, 'owner_email', lower(p_owner_email)));

  return jsonb_build_object('tenant_id', tid, 'owner_user_id', owner_id, 'branch_id', bid);
end $$;

-- Called only by the invite-owner Edge Function (service role) after it has
-- created the Supabase Auth user and sent the invitation email.
create or replace function public.platform_link_owner_auth(p_user uuid, p_auth_user uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  update users set auth_user_id = p_auth_user
  where id = p_user and kind = 'owner' and auth_user_id is null;
  if not found then raise exception 'Owner not found or already linked' using errcode = 'P0002'; end if;
end $$;

-- Called only by the register-device Edge Function (service role).
create or replace function public.platform_attach_device_auth(p_device uuid, p_auth_user uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  update devices set auth_user_id = p_auth_user, status = 'active'
  where id = p_device and status = 'pending' and auth_user_id is null;
  if not found then raise exception 'Device not found or not pending' using errcode = 'P0002'; end if;
end $$;

-- ---- Owner: account -----------------------------------------------------
-- First sign-in after the invite, once 2FA is set up.
create or replace function public.accept_owner_invite() returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid;
begin
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'Set up two-factor sign-in first' using errcode = '42501';
  end if;
  update users set status = 'active'
  where auth_user_id = auth.uid() and kind = 'owner' and status = 'invited'
    and tenant_id = nullif(auth.jwt() ->> 'tenant_id', '')::uuid
  returning id into uid;
  if uid is null then raise exception 'No pending invitation' using errcode = 'P0002'; end if;
  perform set_config('app.user_id', uid::text, true);
  perform app.log_event('owner.invite_accepted', 'users', uid);
  return uid;
end $$;

-- ---- Owner: branches and settings --------------------------------------
create or replace function public.create_branch(p_code text, p_name text, p_kind text default 'shop',
                                                p_city text default '', p_address text default '')
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('settings.manage');
  tid uuid := app.tenant_id();
  bid uuid;
begin
  if p_kind = 'warehouse' and not coalesce((select enabled from app.tenant_feature(tid, 'warehouse')), false) then
    raise exception 'Warehouses are not in your plan' using errcode = 'P0001', hint = 'plan_feature';
  end if;
  perform app.assert_within_limit(tid, 'max_branches',
    (select count(*) from branches where tenant_id = tid and archived_at is null));
  if p_code !~ '^[A-Z0-9]{2,8}$' then
    raise exception 'Branch code must be 2-8 capital letters or digits' using errcode = '22023';
  end if;
  insert into branches (tenant_id, code, name, kind, city, address, created_by)
  values (tid, p_code, p_name, p_kind, p_city, p_address, uid)
  returning id into bid;
  return bid;
end $$;

create or replace function public.set_setting(p_key text, p_value jsonb, p_branch uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('settings.manage');
  tid uuid := app.tenant_id();
begin
  if p_branch is not null and not exists (select 1 from branches where id = p_branch and tenant_id = tid) then
    raise exception 'Branch not found' using errcode = 'P0002';
  end if;
  insert into settings (tenant_id, branch_id, key, value, created_by)
  values (tid, p_branch, p_key, p_value, uid)
  on conflict (tenant_id, branch_id, key) do update set value = excluded.value;
end $$;

-- ---- Owner: roles and permissions ---------------------------------------
create or replace function public.create_role(p_name text, p_copy_from_role uuid default null,
                                              p_template text default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('roles.manage');
  tid uuid := app.tenant_id();
  rid uuid;
begin
  insert into roles (tenant_id, name, template_code, created_by)
  values (tid, p_name, null, uid) returning id into rid;
  if p_copy_from_role is not null then
    if not exists (select 1 from roles where id = p_copy_from_role and tenant_id = tid) then
      raise exception 'Role not found' using errcode = 'P0002';
    end if;
    insert into role_permissions (tenant_id, role_id, permission_code, allowed, needs_approval, limit_value, created_by)
    select tid, rid, permission_code, allowed, needs_approval, limit_value, uid
    from role_permissions where role_id = p_copy_from_role;
  elsif p_template is not null then
    insert into role_permissions (tenant_id, role_id, permission_code, allowed, needs_approval, limit_value, created_by)
    select tid, rid, permission_code, allowed, needs_approval, limit_value, uid
    from role_template_permissions where template_code = p_template;
  end if;
  return rid;
end $$;

create or replace function public.rename_role(p_role uuid, p_name text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('roles.manage');
begin
  update roles set name = p_name where id = p_role and tenant_id = app.tenant_id();
  if not found then raise exception 'Role not found' using errcode = 'P0002'; end if;
end $$;

create or replace function public.archive_role(p_role uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('roles.manage');
begin
  if exists (select 1 from user_roles where role_id = p_role and archived_at is null) then
    raise exception 'Remove this role from all staff first' using errcode = 'P0001';
  end if;
  update roles set archived_at = now() where id = p_role and tenant_id = app.tenant_id() and archived_at is null;
  if not found then raise exception 'Role not found' using errcode = 'P0002'; end if;
end $$;

create or replace function public.set_role_permission(p_role uuid, p_code text, p_allowed boolean,
                                                      p_needs_approval boolean default false,
                                                      p_limit bigint default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('roles.manage');
  tid uuid := app.tenant_id();
begin
  if not exists (select 1 from roles where id = p_role and tenant_id = tid and archived_at is null) then
    raise exception 'Role not found' using errcode = 'P0002';
  end if;
  if p_limit is not null and p_limit < 0 then
    raise exception 'Limit cannot be negative' using errcode = '22023';
  end if;
  insert into role_permissions (tenant_id, role_id, permission_code, allowed, needs_approval, limit_value, created_by)
  values (tid, p_role, p_code, p_allowed, p_needs_approval, p_limit, uid)
  on conflict (role_id, permission_code) do update
    set allowed = excluded.allowed, needs_approval = excluded.needs_approval, limit_value = excluded.limit_value;
end $$;

-- ---- Owner: staff -------------------------------------------------------
-- Staff never get a cloud login (D11): they work on pharmacy PCs by PIN.
create or replace function public.create_staff(p_full_name text, p_phone text default null,
                                               p_full_name_ur text default null,
                                               p_language text default 'ur')
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('staff.manage');
  tid uuid := app.tenant_id();
  sid uuid;
begin
  perform app.assert_within_limit(tid, 'max_staff',
    (select count(*) from users where tenant_id = tid and status <> 'disabled' and archived_at is null));
  insert into users (tenant_id, kind, full_name, full_name_ur, phone, preferred_language, status, created_by)
  values (tid, 'staff', p_full_name, p_full_name_ur, p_phone, p_language, 'active', uid)
  returning id into sid;
  return sid;
end $$;

create or replace function public.assign_role(p_user uuid, p_role uuid, p_branch uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('staff.manage');
  tid uuid := app.tenant_id();
  target users := app.own_user(p_user);
  urid uuid;
begin
  if not exists (select 1 from roles where id = p_role and tenant_id = tid and archived_at is null) then
    raise exception 'Role not found' using errcode = 'P0002';
  end if;
  insert into user_roles (tenant_id, user_id, role_id, branch_id, created_by)
  values (tid, target.id, p_role, p_branch, uid)
  on conflict (user_id, role_id, branch_id) do update set archived_at = null
  returning id into urid;
  return urid;
end $$;

create or replace function public.unassign_role(p_user_role uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('staff.manage');
begin
  update user_roles ur set archived_at = now()
  from users u
  where ur.id = p_user_role and ur.tenant_id = app.tenant_id() and ur.archived_at is null
    and u.id = ur.user_id and not u.is_primary_owner;
  if not found then raise exception 'Role assignment not found' using errcode = 'P0002'; end if;
end $$;

create or replace function public.set_permission_override(p_user uuid, p_code text, p_allowed boolean,
                                                          p_branch uuid default null,
                                                          p_needs_approval boolean default false,
                                                          p_limit bigint default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('roles.manage');
  tid uuid := app.tenant_id();
  target users := app.own_user(p_user);
begin
  if target.is_primary_owner then
    raise exception 'The primary owner always has every permission' using errcode = 'P0001';
  end if;
  insert into user_permission_overrides (tenant_id, user_id, branch_id, permission_code, allowed,
                                         needs_approval, limit_value, created_by)
  values (tid, target.id, p_branch, p_code, p_allowed, p_needs_approval, p_limit, uid)
  on conflict (user_id, branch_id, permission_code) do update
    set allowed = excluded.allowed, needs_approval = excluded.needs_approval, limit_value = excluded.limit_value;
end $$;

-- The hash is made on the device (packages/core/src/pin.ts); the PIN itself
-- never leaves the screen it was typed on.
create or replace function public.set_staff_pin(p_user uuid, p_pin_hash text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('staff.manage');
  target users := app.own_user(p_user);
begin
  if p_pin_hash !~ '^pbkdf2-sha256\$[0-9]{6,7}\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$' then
    raise exception 'PIN hash is not in the expected format' using errcode = '22023';
  end if;
  insert into user_pins (user_id, tenant_id, pin_hash)
  values (target.id, target.tenant_id, p_pin_hash)
  on conflict (user_id) do update set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null;
  perform app.log_event('staff.pin_set', 'users', target.id);
end $$;

create or replace function public.disable_user(p_user uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('staff.manage');
  target users := app.own_user(p_user);
begin
  if target.is_primary_owner then
    raise exception 'The primary owner cannot be disabled' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  update users set status = 'disabled', disabled_at = now(), disabled_reason = p_reason where id = target.id;
  update user_sessions set ended_at = now(), end_reason = 'disabled', revoked_by = uid
  where user_id = target.id and ended_at is null;
end $$;

create or replace function public.enable_user(p_user uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('staff.manage');
  target users := app.own_user(p_user);
begin
  update users set status = 'active', disabled_at = null, disabled_reason = null
  where id = target.id and status = 'disabled';
end $$;

-- Remote log-out of PC sessions. Revoking a partner owner's cloud sessions
-- also needs the Supabase Auth admin API; that arrives with the web app.
create or replace function public.end_user_sessions(p_user uuid) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('staff.manage');
  target users := app.own_user(p_user);
  n int;
begin
  if target.is_primary_owner and target.id <> uid then
    raise exception 'Only the primary owner can sign themselves out everywhere' using errcode = '42501';
  end if;
  update user_sessions set ended_at = now(), end_reason = 'remote_revoke', revoked_by = uid
  where user_id = target.id and ended_at is null;
  get diagnostics n = row_count;
  perform app.log_event('staff.sessions_revoked', 'users', target.id, jsonb_build_object('count', n));
  return n;
end $$;

-- ---- Owner: devices -----------------------------------------------------
-- Step 1 of registering a pharmacy PC. The register-device Edge Function
-- then creates the PC's own sign-in and calls platform_attach_device_auth.
create or replace function public.register_device(p_branch uuid, p_code text, p_name text,
                                                  p_kind text default 'counter')
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('devices.manage');
  tid uuid := app.tenant_id();
  br branches;
  did uuid;
  prefix text;
begin
  select * into br from branches where id = p_branch and tenant_id = tid and archived_at is null;
  if not found then raise exception 'Branch not found' using errcode = 'P0002'; end if;
  if p_code !~ '^[A-Z0-9]{1,4}$' then
    raise exception 'Device code must be 1-4 capital letters or digits' using errcode = '22023';
  end if;
  if p_kind = 'counter' then
    perform app.assert_within_limit(tid, 'max_counters',
      (select count(*) from devices where tenant_id = tid and kind = 'counter' and status <> 'disabled'));
  end if;
  prefix := br.code || '-' || p_code;
  insert into devices (tenant_id, branch_id, code, invoice_prefix, name, kind, status, created_by)
  values (tid, br.id, p_code, prefix, p_name, p_kind, 'pending', uid)
  returning id into did;
  return jsonb_build_object('device_id', did, 'invoice_prefix', prefix);
end $$;

create or replace function public.disable_device(p_device uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('devices.manage');
begin
  update devices set status = 'disabled', disabled_at = now()
  where id = p_device and tenant_id = app.tenant_id() and status <> 'disabled';
  if not found then raise exception 'Device not found' using errcode = 'P0002'; end if;
  update device_licences set revoked_at = now() where device_id = p_device and revoked_at is null;
  perform app.log_event('device.disabled', 'devices', p_device, jsonb_build_object('reason', p_reason));
end $$;

-- ---- Counter: staff sessions --------------------------------------------
-- The PC has already checked the PIN offline. The server re-checks that the
-- person is active and allowed on this PC/branch, and records attendance.
create or replace function public.start_staff_session(p_user uuid, p_session_id uuid default null,
                                                      p_started_at timestamptz default now())
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  did uuid := app.rpc_begin_device();
  br uuid := app.device_branch_id();
  target users := app.own_user(p_user);
  sid uuid := coalesce(p_session_id, app.uuid_v7());
begin
  if target.status <> 'active' or target.archived_at is not null then
    raise exception 'This staff member is disabled' using errcode = '42501';
  end if;
  if not exists (select 1 from user_roles
                 where user_id = target.id and archived_at is null
                   and (branch_id is null or branch_id = br)) then
    raise exception 'This staff member does not work at this branch' using errcode = '42501';
  end if;
  if exists (select 1 from user_allowed_devices where user_id = target.id)
     and not exists (select 1 from user_allowed_devices where user_id = target.id and device_id = did) then
    raise exception 'This staff member may not use this PC' using errcode = '42501';
  end if;
  perform set_config('app.user_id', target.id::text, true);
  insert into user_sessions (id, tenant_id, user_id, branch_id, device_id, method, started_at, last_active_at)
  values (sid, target.tenant_id, target.id, br, did, 'pin', p_started_at, p_started_at)
  on conflict (id) do nothing;
  perform app.log_event('login', 'user_sessions', sid, jsonb_build_object('method', 'pin'), br);
  return sid;
end $$;

create or replace function public.end_staff_session(p_session uuid, p_reason text default 'logout',
                                                    p_ended_at timestamptz default now())
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  did uuid := app.rpc_begin_device();
  s user_sessions;
begin
  if p_reason not in ('logout', 'idle_lock', 'expired') then
    raise exception 'Unknown reason %', p_reason using errcode = '22023';
  end if;
  update user_sessions set ended_at = p_ended_at, end_reason = p_reason
  where id = p_session and device_id = did and ended_at is null
  returning * into s;
  if found then
    perform set_config('app.user_id', s.user_id::text, true);
    perform app.log_event('logout', 'user_sessions', s.id, jsonb_build_object('reason', p_reason), s.branch_id);
  end if;
end $$;

-- Wrong PINs typed on a PC are reported here, so the owner sees them.
create or replace function public.record_pin_failure(p_user uuid, p_at timestamptz default now()) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  did uuid := app.rpc_begin_device();
  target users := app.own_user(p_user);
  max_attempts int := coalesce((select (value #>> '{}')::int from settings
                                where tenant_id = target.tenant_id and branch_id is null
                                  and key = 'security.pin_max_attempts'), 5);
  lock_minutes int := coalesce((select (value #>> '{}')::int from settings
                                where tenant_id = target.tenant_id and branch_id is null
                                  and key = 'security.pin_lock_minutes'), 15);
begin
  update user_pins
  set failed_attempts = failed_attempts + 1,
      locked_until = case when failed_attempts + 1 >= max_attempts
                          then p_at + make_interval(mins => lock_minutes) else locked_until end
  where user_id = target.id;
  perform app.log_event('login_failed', 'users', target.id, jsonb_build_object('method', 'pin'),
                        app.device_branch_id());
end $$;

-- Generic audited event from an owner session or a counter (export, drawer
-- opened without a sale, report printed, ...).
create or replace function public.log_activity(p_action text, p_context jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public, app as $$
begin
  if app.tenant_id() is null then
    raise exception 'Sign-in required' using errcode = '42501';
  end if;
  if p_action !~ '^[a-z_]+(\.[a-z_]+)*$' then
    raise exception 'Invalid action name' using errcode = '22023';
  end if;
  perform app.log_event(p_action, null, null, p_context,
                        coalesce(app.device_branch_id(), nullif(p_context ->> 'branch_id', '')::uuid));
end $$;

-- ---- Grants ---------------------------------------------------------------
-- New functions are executable by PUBLIC by default; revoke that for every
-- MedFlow function (extension functions such as pg_trgm's are left alone).
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
  public.accept_owner_invite(),
  public.create_branch(text, text, text, text, text),
  public.set_setting(text, jsonb, uuid),
  public.create_role(text, uuid, text),
  public.rename_role(uuid, text),
  public.archive_role(uuid),
  public.set_role_permission(uuid, text, boolean, boolean, bigint),
  public.create_staff(text, text, text, text),
  public.assign_role(uuid, uuid, uuid),
  public.unassign_role(uuid),
  public.set_permission_override(uuid, text, boolean, uuid, boolean, bigint),
  public.set_staff_pin(uuid, text),
  public.disable_user(uuid, text),
  public.enable_user(uuid),
  public.end_user_sessions(uuid),
  public.register_device(uuid, text, text, text),
  public.disable_device(uuid, text),
  public.start_staff_session(uuid, uuid, timestamptz),
  public.end_staff_session(uuid, text, timestamptz),
  public.record_pin_failure(uuid, timestamptz),
  public.log_activity(text, jsonb),
  public.platform_provision_tenant(text, text, text, text, text, text, text, text, char, text, text)
  to authenticated;

revoke all on function public.platform_link_owner_auth(uuid, uuid) from authenticated;
revoke all on function public.platform_attach_device_auth(uuid, uuid) from authenticated;
grant execute on function public.platform_link_owner_auth(uuid, uuid) to service_role;
grant execute on function public.platform_attach_device_auth(uuid, uuid) to service_role;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- Helpers used inside RLS policies must stay callable.
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;

select app.assert_rls_everywhere();
