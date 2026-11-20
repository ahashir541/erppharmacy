-- 0036: roles that work at the counter.
-- * Pharmacists can see whether a customer may take udhaar, and give udhaar with the owner's approval
--   above their limit (Rs 0 until the owner sets one), like salesmen and managers. Before, a
--   pharmacist could not sell on udhaar at all, not even with approval.
-- * office_roles() says which roles can work at the counter (sell), so "Add staff" offers only those:
--   staff use the counter screen; Storekeeper and Accountant work needs the back office, which only the
--   owner opens for now.

insert into role_template_permissions (template_code, permission_code, allowed, needs_approval, limit_value)
values ('pharmacist', 'udhaar.check_status', true, false, null), ('pharmacist', 'udhaar.give', true, false, 0)
on conflict (template_code, permission_code) do update set allowed = true, needs_approval = false, limit_value = excluded.limit_value;

insert into role_permissions (tenant_id, role_id, permission_code, allowed, needs_approval, limit_value)
select r.tenant_id, r.id, x.code, true, false, x.lim
from roles r
cross join (values ('udhaar.check_status', null::bigint), ('udhaar.give', 0::bigint)) as x(code, lim)
where r.template_code = 'pharmacist'
  and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_code = x.code);

create or replace function public.office_roles() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'template', x.template_code, 'counter', x.counter)
                            order by x.rank, x.name))
  from (
    select r.id, r.name, r.template_code,
           exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_code = 'sales.create' and rp.allowed) as counter,
           case r.template_code when 'salesman' then 1 when 'pharmacist' then 2 when 'manager' then 3 else 4 end as rank
    from roles r where r.archived_at is null and r.template_code is distinct from 'owner'
  ) x
$$;
