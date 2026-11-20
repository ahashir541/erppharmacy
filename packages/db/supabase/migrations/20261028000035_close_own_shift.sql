-- 0035: whoever may sell may close their own shift.
-- Managers and pharmacists could open a shift (sales.create) but not close it: "Permission
-- cash.close_shift is required" at the end of the day. Their role templates now include it, the
-- roles that pharmacies already have get it too, and closing one's own shift is allowed for anyone
-- who holds cash.close_shift or sales.create (so a custom role can never be stuck with an open drawer).
-- Closing someone else's shift still needs cash.view, as before.

insert into role_template_permissions (template_code, permission_code, allowed, needs_approval)
values ('manager', 'cash.close_shift', true, false), ('pharmacist', 'cash.close_shift', true, false)
on conflict (template_code, permission_code) do update set allowed = true, needs_approval = false;

insert into role_permissions (tenant_id, role_id, permission_code, allowed, needs_approval)
select r.tenant_id, r.id, 'cash.close_shift', true, false
from roles r
where r.template_code in ('manager', 'pharmacist')
  and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_code = 'cash.close_shift');

create or replace function public.close_drawer(p_drawer_session uuid, p_counted bigint,
                                               p_denominations jsonb default null, p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  ds drawer_sessions;
  expected bigint;
begin
  select * into ds from drawer_sessions where id = p_drawer_session and tenant_id = app.tenant_id() for update;
  if not found or ds.status <> 'open' then raise exception 'Drawer is not open' using errcode = 'P0001'; end if;
  perform app.assert_branch(ds.branch_id);
  if ds.opened_by <> uid then
    perform app.require_decision(uid, 'cash.view', ds.branch_id, null, null, 'other');
  elsif app.permission_decision(uid, 'cash.close_shift', ds.branch_id) is distinct from 'allow'
        and app.permission_decision(uid, 'sales.create', ds.branch_id) is distinct from 'allow' then
    raise exception 'Permission cash.close_shift is required' using errcode = '42501';
  end if;
  if p_counted is null or p_counted < 0 then raise exception 'Counted cash must be 0 or more' using errcode = '22023'; end if;
  select coalesce(sum(amount), 0) into expected from cash_movements where drawer_session_id = ds.id;
  update drawer_sessions set status = 'closed', closed_by = uid, closed_at = now(), counted_cash = p_counted,
                             counted_denominations = p_denominations
  where id = ds.id;
  insert into drawer_session_reconciliations (drawer_session_id, tenant_id, expected_cash, variance)
  values (ds.id, ds.tenant_id, expected, p_counted - expected)
  on conflict (drawer_session_id) do update
    set expected_cash = excluded.expected_cash, variance = excluded.variance, computed_at = now();
end $$;
