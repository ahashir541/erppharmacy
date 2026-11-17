-- 0021: Phase 7 — compliance: prescriptions and the pharmacist's confirmation, the controlled
-- drugs register, branch licences, recalls pushed by the platform to every pharmacy, and the
-- scheduled checks. MedFlow has no sales tax and no FBR / tax authority link (D55).

-- ---- Prescriptions ---------------------------------------------------------------------------
-- p: id (made on the device), customer_id, patient_name, patient_age_years, doctor_id | doctor_name,
--    prescribed_on, photo_paths [], notes, pharmacist_id (when the pharmacist confirms at once)
create or replace function app.save_prescription(p jsonb, p_actor uuid, p_branch uuid) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  rid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  pharm uuid := (p ->> 'pharmacist_id')::uuid;
begin
  if exists (select 1 from prescriptions where id = rid) then return rid; end if;
  if coalesce(trim(p ->> 'patient_name'), '') = '' then raise exception 'The patient''s name is required' using errcode = '22023'; end if;
  if (p ->> 'doctor_id') is null and coalesce(trim(p ->> 'doctor_name'), '') = '' then
    raise exception 'The doctor''s name is required' using errcode = '22023';
  end if;
  -- Only a person allowed to confirm prescriptions counts as the pharmacist.
  if pharm is not null and app.permission_decision(pharm, 'prescriptions.confirm', p_branch) <> 'allow' then pharm := null; end if;
  insert into prescriptions (id, tenant_id, branch_id, customer_id, patient_name, patient_age_years, doctor_id, doctor_name,
                             prescribed_on, photo_paths, notes, pharmacist_confirmed_by, pharmacist_confirmed_at, created_by, device_id)
  values (rid, app.tenant_id(), p_branch, (p ->> 'customer_id')::uuid, trim(p ->> 'patient_name'), (p ->> 'patient_age_years')::int,
          (p ->> 'doctor_id')::uuid, nullif(trim(p ->> 'doctor_name'), ''), (p ->> 'prescribed_on')::date,
          coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'photo_paths') x), '{}'), p ->> 'notes',
          pharm, case when pharm is not null then now() end, p_actor, app.ctx_device_id());
  return rid;
end $$;

create or replace function public.save_prescription(p jsonb, p_session uuid default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  br uuid := coalesce(app.device_branch_id(), (p ->> 'branch_id')::uuid);
begin
  perform app.assert_branch(br);
  perform app.require_decision(uid, 'sales.create', br, null, null, 'other');
  return app.save_prescription(p, uid, br);
end $$;

create or replace function public.confirm_prescription(p_prescription uuid, p_session uuid default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  rx prescriptions;
begin
  select * into rx from prescriptions where id = p_prescription and tenant_id = app.tenant_id() for update;
  if not found then raise exception 'Prescription not found' using errcode = 'P0002'; end if;
  perform app.require_decision(uid, 'prescriptions.confirm', rx.branch_id, null, null, 'other');
  update prescriptions set pharmacist_confirmed_by = uid, pharmacist_confirmed_at = now() where id = rx.id;
end $$;

-- A bill can carry its prescription with it (p_sale.prescription = {...}), so an offline sale and its
-- prescription arrive as one command.
alter function app.record_sale(jsonb, uuid, text) rename to record_sale_core;
create or replace function app.record_sale(p_sale jsonb, p_actor uuid, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  br uuid := coalesce(app.device_branch_id(), (p_sale ->> 'branch_id')::uuid);
  rid uuid;
begin
  if jsonb_typeof(p_sale -> 'prescription') = 'object' and not exists (select 1 from sales where id = (p_sale ->> 'id')::uuid) then
    rid := app.save_prescription(p_sale -> 'prescription', p_actor, br);
    p_sale := (p_sale - 'prescription') || jsonb_build_object('prescription_id', rid);
  end if;
  return app.record_sale_core(p_sale, p_actor, p_mode);
end $$;

-- ---- Controlled drugs register ------------------------------------------------------------
-- In the inspector's layout: per medicine, the balance before the period, then every receipt and
-- sale with the supplier or patient and prescriber, and the running balance.
create or replace function public.controlled_register(p_branch uuid, p_from date, p_to date, p_product uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare b uuid[] := app.report_branches('reports.controlled', p_branch);
begin
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', pr.id, 'medicine', pr.brand_name || coalesce(' ' || pr.strength, ''),
      'opening_balance', coalesce((select sum(m.qty_base) from stock_movements m where m.product_id = pr.id and m.branch_id = p_branch
                                   and app.business_date(p_branch, m.occurred_at) < p_from), 0),
      'entries', (select coalesce(jsonb_agg(jsonb_build_object(
          'date', app.business_date(p_branch, r.occurred_at), 'time', r.occurred_at, 'batch', r.batch_number, 'type', r.movement_type,
          'qty_in', r.qty_in, 'qty_out', r.qty_out, 'balance', r.running_balance, 'invoice', coalesce(r.invoice_number, r.supplier_invoice_number),
          'patient', r.patient_name, 'prescriber', r.prescriber, 'supplier', r.supplier_name,
          'by', (select full_name from users where id = r.created_by)) order by r.occurred_at), '[]')
        from controlled_drug_register r
        where r.product_id = pr.id and r.branch_id = p_branch and app.business_date(p_branch, r.occurred_at) between p_from and p_to),
      'closing_balance', coalesce((select sum(m.qty_base) from stock_movements m where m.product_id = pr.id and m.branch_id = p_branch
                                   and app.business_date(p_branch, m.occurred_at) <= p_to), 0))
      order by pr.brand_name), '[]')
    from products pr
    where pr.tenant_id = app.tenant_id() and pr.is_controlled and (p_product is null or pr.id = p_product)
      and p_branch = any (b)
      and exists (select 1 from stock_movements m where m.product_id = pr.id and m.branch_id = p_branch));
end $$;

-- ---- Licences ----------------------------------------------------------------------------------
create or replace function public.save_branch_licence(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('licences.manage');
  lid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
begin
  perform app.assert_branch((p ->> 'branch_id')::uuid);
  if coalesce(trim(p ->> 'licence_number'), '') = '' then raise exception 'The licence number is required' using errcode = '22023'; end if;
  insert into branch_licences (id, tenant_id, branch_id, licence_type, licence_number, qualified_person_name, qualified_person_reg_no,
                               issued_on, expires_on, remind_days_before, document_paths, created_by)
  values (lid, app.tenant_id(), (p ->> 'branch_id')::uuid, coalesce(p ->> 'licence_type', 'drug_sale'), trim(p ->> 'licence_number'),
          p ->> 'qualified_person_name', p ->> 'qualified_person_reg_no', (p ->> 'issued_on')::date, (p ->> 'expires_on')::date,
          coalesce((p ->> 'remind_days_before')::int, 30),
          coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'document_paths') x), '{}'), uid)
  on conflict (id) do update set licence_number = excluded.licence_number, qualified_person_name = excluded.qualified_person_name,
    qualified_person_reg_no = excluded.qualified_person_reg_no, issued_on = excluded.issued_on, expires_on = excluded.expires_on,
    remind_days_before = excluded.remind_days_before, document_paths = excluded.document_paths;
  return lid;
end $$;

create or replace function public.licences_due(p_today date default current_date)
returns table (licence_id uuid, branch text, licence_type text, licence_number text, expires_on date, days_left int)
language plpgsql stable security definer set search_path = public, app as $$
#variable_conflict use_column
begin
  perform app.require_perm('compliance.view');
  return query
  select l.id, b.name, l.licence_type, l.licence_number, l.expires_on, (l.expires_on - p_today)::int
  from branch_licences l join branches b on b.id = l.branch_id
  where l.tenant_id = app.tenant_id() and l.archived_at is null and l.expires_on is not null
    and l.expires_on - p_today <= l.remind_days_before
  order by l.expires_on;
end $$;

-- ---- Recalls ------------------------------------------------------------------------------
-- A recall is lifted by the platform (its audit log has who), not by a person of the pharmacy.
alter table batch_blocks drop constraint batch_blocks_check;
alter table batch_blocks add constraint batch_blocks_lifted_check
  check ((lifted_at is null) = (lifted_by is null) or (source = 'global_recall' and lifted_at is not null and lifted_by is null));

-- The platform owner pushes a banned batch to every pharmacy. Matching stock is frozen at once
-- (or only warned about), and the owners are told. A batch received later with that number is
-- frozen as it arrives.
create or replace function app.apply_recall(p_recall uuid, p_batch uuid default null) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  g global_recalls;
  b record;
  n int := 0;
begin
  select * into g from global_recalls where id = p_recall and lifted_at is null;
  if not found then return 0; end if;
  for b in select bt.id, bt.tenant_id, pr.brand_name from batches bt join products pr on pr.id = bt.product_id
           where upper(bt.batch_number) = upper(trim(g.batch_number))
             and (p_batch is null or bt.id = p_batch)
             and (pr.brand_name ilike '%' || g.brand_name || '%' or g.brand_name ilike '%' || pr.brand_name || '%')
             and not exists (select 1 from batch_blocks bb where bb.batch_id = bt.id and bb.global_recall_id = g.id and bb.lifted_at is null) loop
    if g.action = 'freeze' then
      insert into batch_blocks (tenant_id, batch_id, source, global_recall_id, reason)
      values (b.tenant_id, b.id, 'global_recall', g.id, 'Recall: ' || g.reason);
    end if;
    perform app.notify(b.tenant_id, 'recall', 'Recall: ' || b.brand_name || ' batch ' || upper(g.batch_number),
                       g.reason || case when g.action = 'freeze' then ' — this batch is frozen and cannot be sold.' else '' end
                       || coalesce(' (' || g.authority_reference || ')', ''), 'batch', b.id);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function app.recall_new_batch() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare g uuid;
begin
  for g in select id from global_recalls where lifted_at is null and upper(batch_number) = upper(new.batch_number) loop
    perform app.apply_recall(g, new.id);
  end loop;
  return null;
end $$;
create trigger trg_recall_new_batch after insert on batches for each row execute function app.recall_new_batch();

create or replace function public.platform_issue_recall(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  admin_id uuid;
  rid uuid;
begin
  select id into admin_id from platform_admins where auth_user_id = auth.uid() and is_active;
  if admin_id is null or not app.is_platform_admin() then
    raise exception 'Platform admin sign-in with 2FA is required' using errcode = '42501';
  end if;
  if coalesce(trim(p ->> 'batch_number'), '') = '' or coalesce(trim(p ->> 'brand_name'), '') = '' or coalesce(trim(p ->> 'reason'), '') = '' then
    raise exception 'Brand, batch number and reason are required' using errcode = '22023';
  end if;
  insert into global_recalls (brand_name, manufacturer_name, batch_number, reason, authority_reference, action, created_by)
  values (trim(p ->> 'brand_name'), p ->> 'manufacturer_name', upper(trim(p ->> 'batch_number')), trim(p ->> 'reason'),
          p ->> 'authority_reference', coalesce(p ->> 'action', 'freeze'), admin_id)
  returning id into rid;
  insert into platform_audit_log (admin_id, action, details) values (admin_id, 'recall_issued', p);
  return jsonb_build_object('recall_id', rid, 'batches_matched', app.apply_recall(rid));
end $$;

create or replace function public.platform_lift_recall(p_recall uuid, p_reason text) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  admin_id uuid;
  n int;
begin
  select id into admin_id from platform_admins where auth_user_id = auth.uid() and is_active;
  if admin_id is null or not app.is_platform_admin() then
    raise exception 'Platform admin sign-in with 2FA is required' using errcode = '42501';
  end if;
  update global_recalls set lifted_at = now() where id = p_recall and lifted_at is null;
  update batch_blocks set lifted_at = now(), lift_reason = 'Recall lifted: ' || coalesce(p_reason, '')
  where global_recall_id = p_recall and lifted_at is null;
  get diagnostics n = row_count;
  insert into platform_audit_log (admin_id, action, details)
  values (admin_id, 'recall_lifted', jsonb_build_object('recall_id', p_recall, 'reason', p_reason));
  return n;
end $$;

-- ---- Scheduled checks (cron, every 15 minutes, service role) ----------------------------------
-- Licences to renew, PCs offline, batches expiring, low stock, approvals expired.
create or replace function public.run_scheduled_checks(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  r record;
  rule record;
  n_lic int := 0; n_dev int := 0; n_exp int := 0; n_low int := 0; n_appr int;
begin
  update approval_requests set status = 'expired' where status = 'pending' and expires_at < p_now;
  get diagnostics n_appr = row_count;

  for r in select l.*, b.name as branch_name from branch_licences l join branches b on b.id = l.branch_id
           where l.archived_at is null and l.expires_on is not null and l.expires_on - p_now::date <= l.remind_days_before loop
    n_lic := n_lic + app.notify(r.tenant_id, 'licence_expiry', 'Licence to renew at ' || r.branch_name,
                                replace(r.licence_type, '_', ' ') || ' licence ' || r.licence_number
                                || case when r.expires_on < p_now::date then ' expired on ' else ' expires on ' end
                                || to_char(r.expires_on, 'DD Mon YYYY'), 'branch_licence', r.id, 'licence_expiry', interval '7 days');
  end loop;

  for r in select d.* from devices d where d.status = 'active' and d.last_seen_at is not null loop
    select * into rule from app.alert_rule(r.tenant_id, 'device_offline');
    if r.last_seen_at < p_now - make_interval(hours => coalesce(rule.threshold, 24)::int) then
      n_dev := n_dev + app.notify(r.tenant_id, 'device_offline', r.name || ' is offline',
                                  'Last seen ' || to_char(r.last_seen_at at time zone 'Asia/Karachi', 'DD Mon HH24:MI'),
                                  'device', r.id, 'device_offline', interval '24 hours');
    end if;
  end loop;

  for r in select sb.tenant_id, sb.batch_id, sb.qty_base, bt.batch_number, bt.expiry_date, pr.brand_name, br.name as branch_name
           from stock_balances sb join batches bt on bt.id = sb.batch_id join products pr on pr.id = sb.product_id
           join branches br on br.id = sb.branch_id
           where sb.qty_base > 0 loop
    select * into rule from app.alert_rule(r.tenant_id, 'expiring_batches');
    if r.expiry_date <= p_now::date + coalesce(rule.threshold, 90)::int then
      n_exp := n_exp + app.notify(r.tenant_id, 'expiring_batches', r.brand_name || ' expiring at ' || r.branch_name,
                                  r.qty_base || ' of batch ' || r.batch_number || ' expire on ' || to_char(r.expiry_date, 'DD Mon YYYY'),
                                  'batch', r.batch_id, 'expiring_batches', interval '7 days');
    end if;
  end loop;

  for r in select pr.tenant_id, pr.id, pr.brand_name, pr.reorder_level, br.id as branch_id, br.name as branch_name,
                  coalesce((select sum(sb.qty_base) from stock_balances sb where sb.product_id = pr.id and sb.branch_id = br.id), 0) as qty
           from products pr join branches br on br.tenant_id = pr.tenant_id and br.archived_at is null
           where pr.is_active and pr.archived_at is null and pr.reorder_level is not null loop
    if r.qty <= r.reorder_level then
      n_low := n_low + app.notify(r.tenant_id, 'low_stock', 'Low stock: ' || r.brand_name,
                                  'Only ' || r.qty || ' left at ' || r.branch_name || ' (reorder at ' || r.reorder_level || ')',
                                  'product', r.id, 'low_stock', interval '24 hours');
    end if;
  end loop;

  return jsonb_build_object('approvals_expired', n_appr, 'licences', n_lic, 'devices_offline', n_dev,
                            'expiring', n_exp, 'low_stock', n_low);
end $$;

-- ---- Receipts ----------------------------------------------------------------------------------
-- One bill's receipt, for a bill the caller may look up (the same rule as the sales read policy:
-- the branch's bills of the last 7 days at a counter). Each reprint is logged, so someone pulling
-- receipts one by one to add them up shows in the owner's activity feed.
create or replace function public.get_receipt(p_sale uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare s sales;
begin
  select * into s from sales where id = p_sale and tenant_id = app.tenant_id()
    and (branch_id = any (app.branches_with('sales.view_all'))
         or created_by = app.current_user_id()
         or (branch_id = any (app.branches_with('sales.lookup_recent')) and sold_at > now() - interval '7 days'));
  if not found then return null; end if;
  if app.current_user_id() is null then
    perform app.log_event('receipt_reprint', 'sales', s.id, jsonb_build_object('invoice', s.invoice_number), s.branch_id);
  end if;
  return app.receipt_data(s.id);
end $$;

-- ---- Grants ------------------------------------------------------------------------------------
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
  public.save_prescription(jsonb, uuid), public.confirm_prescription(uuid, uuid), public.controlled_register(uuid, date, date, uuid),
  public.save_branch_licence(jsonb), public.licences_due(date), public.platform_issue_recall(jsonb),
  public.platform_lift_recall(uuid, text), public.get_receipt(uuid)
  to authenticated;
-- Supabase gives new functions to signed-in users by default; these are not theirs.
revoke all on function app.receipt_data(uuid) from authenticated;
revoke all on function public.run_scheduled_checks(timestamptz) from authenticated;
-- The scheduler runs with the service role only.
grant execute on function public.run_scheduled_checks(timestamptz) to service_role;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;
select app.assert_rls_everywhere();
