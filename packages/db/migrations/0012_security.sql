-- 0012: identity helpers, Row Level Security and grants.
--
-- Model
--   * Reads: RLS. A restrictive tenant_isolation policy on every tenant table,
--     plus one permissive read policy per table naming the permission needed.
--   * Writes: none directly. Clients call SECURITY DEFINER RPCs (online) or
--     upload through the PowerSync upload handler (offline queue), both of
--     which re-check permissions and post ledger rows.
--   * Principals: a signed-in user (owner / staff with an auth account) or a
--     counter device principal (devices.auth_user_id). A device principal can
--     read only what permissions.counter_safe allows, never sensitive data.
--   * Platform admins never pass tenant_isolation; the console reads tenant
--     health through definer functions that return non-financial data.
--   * Policies wrap helpers in (select ...) so Postgres evaluates them once
--     per query, not once per row.

create or replace function app.current_user_id() returns uuid
language sql stable security definer set search_path = public, app as $$
  select u.id
  from users u
  join tenants t on t.id = u.tenant_id
  where u.auth_user_id = auth.uid()
    and u.tenant_id = nullif(auth.jwt() ->> 'tenant_id', '')::uuid
    and u.status = 'active' and u.archived_at is null
    and t.status <> 'cancelled'
$$;

create or replace function app.current_device_id() returns uuid
language sql stable security definer set search_path = public, app as $$
  select d.id
  from devices d
  join tenants t on t.id = d.tenant_id
  where d.auth_user_id = auth.uid()
    and d.status = 'active' and d.archived_at is null
    and t.status <> 'cancelled'
$$;

create or replace function app.is_device() returns boolean
language sql stable as $$
  select app.current_user_id() is null and app.current_device_id() is not null
$$;

create or replace function app.device_branch_id() returns uuid
language sql stable security definer set search_path = public, app as $$
  select branch_id from devices where id = app.current_device_id()
$$;

create or replace function app.tenant_id() returns uuid
language sql stable security definer set search_path = public, app as $$
  select coalesce(
    (select tenant_id from users where id = app.current_user_id()),
    (select tenant_id from devices where id = app.current_device_id()))
$$;

create or replace function app.is_primary_owner() returns boolean
language sql stable security definer set search_path = public, app as $$
  select coalesce((select is_primary_owner from users where id = app.current_user_id()), false)
$$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from platform_admins
                 where auth_user_id = auth.uid() and is_active)
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'   -- 2FA required
$$;

-- Branches where the caller holds a permission. Primary owner: all. Device:
-- its own branch, for counter-safe non-sensitive permissions only. Staff:
-- role grants (branch null = every branch) plus per-user overrides, minus
-- per-user denials.
create or replace function app.branches_with(p_code text) returns uuid[]
language sql stable security definer set search_path = public, app as $$
  with me as (
    select app.current_user_id() as uid, app.current_device_id() as did, app.tenant_id() as tid
  ),
  all_branches as (
    select b.id from branches b, me where b.tenant_id = me.tid and b.archived_at is null
  ),
  granted as (
    select a.id from all_branches a where app.is_primary_owner()
    union
    select d.branch_id from devices d, me
    where me.uid is null and d.id = me.did
      and exists (select 1 from permissions p
                  where p.code = p_code and p.counter_safe and not p.is_sensitive)
    union
    select coalesce(ur.branch_id, a.id)
    from me
    join user_roles ur on ur.user_id = me.uid and ur.archived_at is null
    join roles r on r.id = ur.role_id and r.archived_at is null
    join role_permissions rp on rp.role_id = ur.role_id and rp.permission_code = p_code and rp.allowed
    left join all_branches a on ur.branch_id is null
    union
    select coalesce(o.branch_id, a.id)
    from me
    join user_permission_overrides o on o.user_id = me.uid and o.permission_code = p_code and o.allowed
    left join all_branches a on o.branch_id is null
  ),
  denied as (
    select coalesce(o.branch_id, a.id)
    from me
    join user_permission_overrides o on o.user_id = me.uid and o.permission_code = p_code and not o.allowed
    left join all_branches a on o.branch_id is null
    where not app.is_primary_owner()
  )
  select coalesce(array_agg(id), '{}')
  from (select id from granted where id is not null except select * from denied) x
$$;

create or replace function app.has_perm(p_code text) returns boolean
language sql stable as $$
  select app.is_primary_owner() or cardinality(app.branches_with(p_code)) > 0
$$;

-- Branches the caller works in at all (any role).
create or replace function app.visible_branches() returns uuid[]
language sql stable security definer set search_path = public, app as $$
  select case
    when app.is_primary_owner() then
      (select coalesce(array_agg(id), '{}') from branches where tenant_id = app.tenant_id())
    when app.is_device() then array[app.device_branch_id()]
    else (select coalesce(array_agg(distinct coalesce(ur.branch_id, b.id)), '{}')
          from user_roles ur
          left join branches b on ur.branch_id is null and b.tenant_id = ur.tenant_id
          where ur.user_id = app.current_user_id() and ur.archived_at is null)
  end
$$;

revoke all on all functions in schema app from public;
grant usage on schema app to authenticated;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.branches_with(text), app.has_perm(text), app.visible_branches()
  to authenticated;

-- Clients read via RLS and write via RPCs only.
revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
revoke all on all tables in schema private from anon, authenticated;

-- Apply the standard pair of policies.
--   mode 'any'     : any member of the tenant (and its counter devices)
--   mode 'perm'    : tenant-level permission
--   mode 'branch'  : row's branch_id must be in branches_with(perm)
--   mode 'visible' : branch_id null (tenant-wide) or a branch the caller works in
--   mode 'custom'  : isolation only here; read policy written below
create or replace function app.apply_rls(tbl regclass, mode text, perm text default null) returns void
language plpgsql as $$
declare
  expr text;
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('create policy tenant_isolation on %s as restrictive for all to authenticated
                  using (tenant_id = (select app.tenant_id()))', tbl);
  expr := case mode
    when 'any'     then 'true'
    when 'perm'    then format('(select app.has_perm(%L))', perm)
    when 'branch'  then format('branch_id = any ((select app.branches_with(%L))::uuid[])', perm)
    when 'visible' then 'branch_id is null or branch_id = any ((select app.visible_branches())::uuid[])'
    when 'custom'  then null
  end;
  if mode not in ('any', 'perm', 'branch', 'visible', 'custom') then
    raise exception 'unknown rls mode %', mode;
  end if;
  if expr is not null then
    execute format('create policy read on %s for select to authenticated using (%s)', tbl, expr);
  end if;
end $$;

-- The table -> permission map (review this list together with 0013).
select app.apply_rls(t::regclass, m, p) from (values
  -- organisation & access
  ('users', 'any', null), ('branches', 'custom', null), ('devices', 'visible', null),
  ('device_licences', 'custom', null), ('user_allowed_devices', 'any', null),
  ('settings', 'visible', null), ('roles', 'any', null), ('role_permissions', 'any', null),
  ('user_roles', 'any', null), ('user_permission_overrides', 'any', null),
  ('user_pins', 'custom', null), ('approval_requests', 'custom', null),
  ('user_sessions', 'custom', null), ('audit_log', 'perm', 'audit.view'),
  ('api_keys', 'perm', 'settings.manage'),
  -- catalogue
  ('tax_categories', 'any', null), ('tax_category_rates', 'any', null), ('generics', 'any', null),
  ('manufacturers', 'any', null), ('categories', 'any', null), ('units', 'any', null),
  ('products', 'any', null), ('product_units', 'any', null), ('barcodes', 'any', null),
  ('product_prices', 'custom', null),
  -- stock
  ('batches', 'any', null), ('batch_cost_layers', 'perm', 'product.view_cost'),
  ('batch_blocks', 'visible', null),
  ('stock_movements', 'branch', 'stock.view'), ('stock_balances', 'branch', 'stock.view'),
  ('stock_counts', 'branch', 'stock.count'), ('stock_count_lines', 'perm', 'stock.count'),
  ('stock_count_results', 'perm', 'stock.view_variance'),
  ('transfers', 'custom', null), ('transfer_lines', 'perm', 'stock.transfer'),
  -- parties
  ('customer_accounts', 'perm', 'customers.view'), ('customers', 'perm', 'customers.view'),
  ('credit_limits', 'perm', 'udhaar.view_balance'), ('doctors', 'any', null),
  ('suppliers', 'perm', 'suppliers.view'), ('supplier_manufacturers', 'perm', 'suppliers.view'),
  -- sales & tax
  ('prescriptions', 'branch', 'prescriptions.view'), ('sales', 'custom', null),
  ('sale_lines', 'custom', null), ('sale_line_costs', 'perm', 'sales.view_profit'),
  ('sale_payments', 'custom', null), ('sale_returns', 'custom', null), ('return_lines', 'custom', null),
  ('held_bills', 'branch', 'sales.create'), ('sync_flags', 'branch', 'flags.view'),
  ('tax_profiles', 'perm', 'tax.manage'), ('tax_submissions', 'custom', null),
  -- purchasing
  ('purchase_orders', 'branch', 'purchases.orders'), ('po_lines', 'perm', 'purchases.orders'),
  ('grns', 'branch', 'purchases.receive'), ('grn_lines', 'perm', 'purchases.receive'),
  ('grn_line_costs', 'perm', 'purchases.view_cost'),
  ('purchase_invoices', 'branch', 'purchases.invoices'),
  ('purchase_returns', 'branch', 'purchases.returns'), ('purchase_return_lines', 'perm', 'purchases.returns'),
  ('supplier_claims', 'perm', 'payables.view'),
  -- udhaar & money
  ('ledger_entries', 'custom', null), ('ledger_allocations', 'custom', null),
  ('party_balances', 'custom', null), ('customer_credit_status', 'perm', 'udhaar.check_status'),
  ('cheques', 'custom', null), ('supplier_reconciliations', 'perm', 'payables.view'),
  ('supplier_reconciliation_lines', 'perm', 'payables.view'),
  ('bank_accounts', 'visible', null), ('cash_drawers', 'visible', null),
  ('drawer_sessions', 'custom', null),
  ('drawer_session_reconciliations', 'perm', 'cash.view_variance'),
  ('cash_movements', 'custom', null), ('money_balances', 'perm', 'cash.view'),
  ('expense_categories', 'any', null), ('recurring_expenses', 'perm', 'expenses.manage'),
  ('expenses', 'branch', 'expenses.view'),
  ('salary_rates', 'perm', 'payroll.view'), ('staff_advances', 'perm', 'payroll.view'),
  ('salaries', 'perm', 'payroll.view'), ('salary_advance_recoveries', 'perm', 'payroll.view'),
  ('gl_accounts', 'perm', 'accounting.view'), ('gl_journals', 'perm', 'accounting.view'),
  ('gl_entries', 'perm', 'accounting.view'),
  -- compliance & engagement
  ('branch_licences', 'perm', 'compliance.view'),
  ('loyalty_rules', 'any', null), ('loyalty_points', 'perm', 'customers.view'),
  ('outbound_messages', 'perm', 'messages.view'), ('reminders_log', 'perm', 'udhaar.view_balance'),
  ('customer_regular_medicines', 'perm', 'customers.view'),
  ('alert_rules', 'perm', 'settings.manage'), ('notifications', 'custom', null),
  ('push_subscriptions', 'custom', null), ('receipt_templates', 'visible', null),
  ('data_exports', 'custom', null),
  -- platform rows that belong to one tenant
  ('subscriptions', 'perm', 'billing.view'), ('platform_invoices', 'perm', 'billing.view'),
  ('platform_payments', 'perm', 'billing.view'), ('tenant_feature_overrides', 'any', null),
  ('support_tickets', 'perm', 'support.use'), ('support_access_grants', 'perm', 'settings.manage'),
  ('tenant_backups', 'custom', null)
) as m(t, m, p);

-- ---- custom read policies ------------------------------------------------

create policy read on branches for select to authenticated
  using (id = any ((select app.visible_branches())::uuid[]));

create policy read on device_licences for select to authenticated
  using (device_id = (select app.current_device_id()) or (select app.has_perm('devices.manage')));

-- A counter downloads PIN hashes only for staff allowed on it.
create policy read on user_pins for select to authenticated
  using (
    user_id = (select app.current_user_id())
    or ((select app.is_device())
        and exists (select 1 from user_roles ur
                    where ur.user_id = user_pins.user_id and ur.archived_at is null
                      and (ur.branch_id is null or ur.branch_id = (select app.device_branch_id())))
        and (not exists (select 1 from user_allowed_devices x where x.user_id = user_pins.user_id)
             or exists (select 1 from user_allowed_devices x
                        where x.user_id = user_pins.user_id and x.device_id = (select app.current_device_id())))));

create policy read on approval_requests for select to authenticated
  using (created_by = (select app.current_user_id())
         or device_id = (select app.current_device_id())
         or branch_id = any ((select app.branches_with('approvals.decide'))::uuid[]));

create policy read on user_sessions for select to authenticated
  using (user_id = (select app.current_user_id()) or (select app.has_perm('staff.manage')));

-- Trade price reveals cost; retail and minimum prices do not.
create policy read on product_prices for select to authenticated
  using (price_kind <> 'trade' or (select app.has_perm('product.view_cost')));

create policy read on transfers for select to authenticated
  using (from_branch_id = any ((select app.branches_with('stock.transfer'))::uuid[])
         or to_branch_id = any ((select app.branches_with('stock.transfer'))::uuid[]));

-- Sales: everything with sales.view_all; otherwise your own bills, or the
-- branch's recent bills for a counter (reprint/returns). See Question 5.
create policy read on sales for select to authenticated
  using (branch_id = any ((select app.branches_with('sales.view_all'))::uuid[])
         or created_by = (select app.current_user_id())
         or (branch_id = any ((select app.branches_with('sales.lookup_recent'))::uuid[])
             and sold_at > now() - interval '7 days'));

create policy read on sale_lines for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_lines.sale_id));
create policy read on sale_payments for select to authenticated
  using (exists (select 1 from sales s where s.id = sale_payments.sale_id));

create policy read on sale_returns for select to authenticated
  using (branch_id = any ((select app.branches_with('sales.view_all'))::uuid[])
         or created_by = (select app.current_user_id())
         or (branch_id = any ((select app.branches_with('sales.lookup_recent'))::uuid[])
             and returned_at > now() - interval '7 days'));
create policy read on return_lines for select to authenticated
  using (exists (select 1 from sale_returns r where r.id = return_lines.sale_return_id));

-- Counters see their own queue (to print FBR numbers and show "pending FBR").
create policy read on tax_submissions for select to authenticated
  using (device_id = (select app.current_device_id())
         or branch_id = any ((select app.branches_with('tax.view'))::uuid[]));

create policy read on ledger_entries for select to authenticated
  using ((party_type = 'customer_account' and (select app.has_perm('udhaar.view_balance')))
         or (party_type = 'supplier' and (select app.has_perm('payables.view'))));
create policy read on ledger_allocations for select to authenticated
  using (exists (select 1 from ledger_entries e where e.id = ledger_allocations.payment_entry_id));
create policy read on party_balances for select to authenticated
  using ((party_type = 'customer_account' and (select app.has_perm('udhaar.view_balance')))
         or (party_type = 'supplier' and (select app.has_perm('payables.view'))));
create policy read on cheques for select to authenticated
  using ((party_type = 'customer_account' and (select app.has_perm('udhaar.view_balance')))
         or (party_type = 'supplier' and (select app.has_perm('payables.view'))));

-- Drawer sessions carry no expected amount, so the counter may read its own.
create policy read on drawer_sessions for select to authenticated
  using (branch_id = any ((select app.branches_with('cash.view'))::uuid[])
         or opened_by = (select app.current_user_id())
         or exists (select 1 from cash_drawers cd
                    where cd.id = drawer_sessions.cash_drawer_id
                      and cd.device_id = (select app.current_device_id())));

-- Cash rows would let anyone sum the expected drawer total: cash.view only.
create policy read on cash_movements for select to authenticated
  using (branch_id = any ((select app.branches_with('cash.view'))::uuid[])
         or (branch_id is null and (select app.has_perm('cash.view'))));

create policy read on notifications for select to authenticated
  using (user_id = (select app.current_user_id()));
create policy read on push_subscriptions for select to authenticated
  using (user_id = (select app.current_user_id()));
create policy read on data_exports for select to authenticated
  using (created_by = (select app.current_user_id()) or (select app.has_perm('data.export')));
create policy read on tenant_backups for select to authenticated using (false);

-- ---- platform tables (no tenant isolation; admins or public catalogue) ----

alter table tenants enable row level security;
create policy read on tenants for select to authenticated
  using (id = (select app.tenant_id()) or (select app.is_platform_admin()));

alter table platform_admins enable row level security;
create policy read on platform_admins for select to authenticated using ((select app.is_platform_admin()));
alter table platform_audit_log enable row level security;
create policy read on platform_audit_log for select to authenticated using ((select app.is_platform_admin()));
alter table feature_rollouts enable row level security;
create policy read on feature_rollouts for select to authenticated using ((select app.is_platform_admin()));
alter table support_ticket_messages enable row level security;
create policy read on support_ticket_messages for select to authenticated
  using (exists (select 1 from support_tickets t where t.id = support_ticket_messages.ticket_id));

alter table announcements enable row level security;
create policy read on announcements for select to authenticated
  using ((select app.is_platform_admin())
         or (starts_at <= now() and (ends_at is null or ends_at > now())
             and (audience = 'all'
                  or (audience = 'tenant' and tenant_id = (select app.tenant_id()))
                  or (audience = 'plan' and plan_id = (select plan_id from tenants where id = (select app.tenant_id()))))));

alter table app_releases enable row level security;
create policy read on app_releases for select to authenticated
  using (published_at is not null or (select app.is_platform_admin()));

-- Reference data every signed-in principal may read.
do $$
declare t text;
begin
  foreach t in array array['features', 'plans', 'plan_features', 'platform_settings', 'permissions',
                           'global_generics', 'global_manufacturers', 'global_catalogue', 'global_recalls',
                           'role_template_permissions'] loop
    if to_regclass(t) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('create policy read on %I for select to authenticated using (true)', t);
    end if;
  end loop;
end $$;

-- Platform default templates (tenant_id null) are readable by every tenant.
alter table message_templates enable row level security;
create policy read on message_templates for select to authenticated
  using (tenant_id is null or tenant_id = (select app.tenant_id()));

-- Fail closed: any public table left without RLS stops the migration.
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if missing is not null then
    raise exception 'RLS not enabled on: %', missing;
  end if;
end $$;
