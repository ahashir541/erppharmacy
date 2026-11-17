-- 0026: going live on the cloud. Every new counter PC gets its cash drawer, the owner's back
-- office knows its pharmacy and branches without a PC, and the very first pharmacy can be set up
-- from the Supabase SQL editor.

-- A counter PC comes with its own drawer.
create or replace function app.drawer_for_new_counter() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.kind = 'counter' and not exists (select 1 from cash_drawers where device_id = new.id) then
    insert into cash_drawers (tenant_id, branch_id, device_id, name, created_by)
    values (new.tenant_id, new.branch_id, new.id, 'Drawer ' || new.code, new.created_by);
  end if;
  return null;
end $$;
create trigger trg_drawer_for_counter after insert on devices for each row execute function app.drawer_for_new_counter();

-- The owner's back office, from any phone or browser: the pharmacy, its branches and today.
create or replace function public.owner_context() returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  uid uuid := app.current_user_id();
  t tenants;
begin
  if uid is null then raise exception 'Owner sign-in with 2FA is required' using errcode = '42501'; end if;
  select * into t from tenants where id = app.tenant_id();
  return jsonb_build_object(
    'pharmacy', t.name, 'language', t.default_language, 'status', t.status, 'trial_ends_at', t.trial_ends_at,
    'owner', (select jsonb_build_object('id', id, 'name', full_name) from users where id = uid),
    'branches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'code', b.code, 'name', b.name, 'address', b.address, 'phone', b.phone,
                   'today', app.business_date(b.id)) order by b.code), '[]')
                 from branches b where b.tenant_id = t.id and b.archived_at is null and b.id = any (app.visible_branches())));
end $$;
revoke all on function public.owner_context() from public, anon;
grant execute on function public.owner_context() to authenticated;

-- First pharmacy (run once in the Supabase SQL editor, as the project owner):
--   1. Authentication → Users → Add user: your email and a strong password.
--   2. select app.setup_pharmacy('My Pharmacy', 'Syed Hashir Ali', '03xxxxxxxxx', 'you@example.com', 'Karachi', 'KHI1', 'Main Branch');
-- Then sign in to MedFlow with that email; it asks you to set up the 6-digit 2FA code.
create or replace function app.setup_pharmacy(p_name text, p_owner_name text, p_owner_phone text, p_owner_email text,
                                              p_city text, p_branch_code text, p_branch_name text, p_plan text default 'pro')
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  auth_id uuid;
  tid uuid;
  owner_id uuid;
  bid uuid;
begin
  select id into auth_id from auth.users where lower(email) = lower(trim(p_owner_email));
  if auth_id is null then raise exception 'First add the user % in Authentication → Users', p_owner_email; end if;
  if exists (select 1 from users where auth_user_id = auth_id) then raise exception 'This email already owns a pharmacy'; end if;
  if p_branch_code !~ '^[A-Z0-9]{2,8}$' then raise exception 'Branch code must be 2-8 capital letters or digits'; end if;
  insert into tenants (name, owner_name, owner_phone, owner_email, city, status, plan_id, trial_ends_at)
  select p_name, p_owner_name, p_owner_phone, p_owner_email, p_city, 'trial', id, now() + make_interval(days => trial_days)
  from plans where code = p_plan
  returning id into tid;
  if tid is null then raise exception 'Unknown plan %', p_plan; end if;
  insert into users (tenant_id, auth_user_id, kind, is_primary_owner, full_name, phone, status)
  values (tid, auth_id, 'owner', true, p_owner_name, p_owner_phone, 'active') returning id into owner_id;
  insert into branches (tenant_id, code, name, city, created_by) values (tid, p_branch_code, p_branch_name, p_city, owner_id) returning id into bid;
  perform app.seed_tenant_defaults(tid, owner_id);
  perform app.ensure_expense_categories(tid);
  return jsonb_build_object('tenant_id', tid, 'owner_id', owner_id, 'branch_id', bid);
end $$;
revoke all on function app.setup_pharmacy(text, text, text, text, text, text, text, text) from public;

select app.assert_rls_everywhere();
