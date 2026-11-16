-- 0021: Phase 7 — compliance. The tax queue (every bill and return goes to each tax authority the
-- pharmacy has switched on, strictly in the counter's order, with retries), prescriptions and the
-- pharmacist's confirmation, the controlled drugs register, branch licences, and recalls pushed
-- by the platform to every pharmacy.
--
-- What is sent, field by field, is decided by the provider adapters in packages/tax (TypeScript),
-- from the neutral invoice built here (app.tax_document). Confirm the authority's current
-- specification and the tax treatment with a tax adviser before switching production on (brief).

-- ---- Tax registration ------------------------------------------------------------------
-- The authority's credentials (token / password) never pass through here: they are put in
-- Supabase Vault by the set-tax-credentials Edge Function, and only the secret's id is stored.
create or replace function public.save_tax_profile(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('tax.manage');
  pid uuid;
begin
  if (p ->> 'provider') not in ('fbr', 'srb', 'pra', 'kpra', 'bra') then
    raise exception 'Unknown tax authority %', p ->> 'provider' using errcode = '22023';
  end if;
  if (p ->> 'branch_id') is not null then perform app.assert_branch((p ->> 'branch_id')::uuid); end if;
  -- Only authorities with a sender in packages/tax can be switched on (D50).
  if coalesce((p ->> 'is_enabled')::boolean, false) and (p ->> 'provider') <> 'fbr' then
    raise exception '% sending is not available yet; save the registration and switch it on later', upper(p ->> 'provider')
      using errcode = 'P0001';
  end if;
  if coalesce((p ->> 'is_enabled')::boolean, false) and coalesce(p ->> 'environment', 'sandbox') = 'production'
     and (coalesce(p ->> 'ntn', '') = '' or coalesce(p ->> 'pos_id', '') = '') then
    raise exception 'NTN and POS ID are needed before sending real invoices' using errcode = '22023';
  end if;
  insert into tax_profiles (tenant_id, branch_id, provider, ntn, strn, pos_id, registration_no, environment, is_enabled, created_by)
  values (app.tenant_id(), (p ->> 'branch_id')::uuid, p ->> 'provider', p ->> 'ntn', p ->> 'strn', p ->> 'pos_id',
          p ->> 'registration_no', coalesce(p ->> 'environment', 'sandbox'), coalesce((p ->> 'is_enabled')::boolean, false), uid)
  on conflict (tenant_id, branch_id, provider) do update
    set ntn = excluded.ntn, strn = excluded.strn, pos_id = excluded.pos_id, registration_no = excluded.registration_no,
        environment = excluded.environment, is_enabled = excluded.is_enabled
  returning id into pid;
  perform app.log_event('tax_profile_saved', 'tax_profiles', pid,
                        jsonb_build_object('provider', p ->> 'provider', 'enabled', p ->> 'is_enabled', 'environment', p ->> 'environment'), null);
  return pid;
end $$;

-- The profiles that apply to a branch: one per authority, a branch's own profile winning over the
-- pharmacy-wide one.
create or replace function app.tax_profiles_for(p_branch uuid) returns setof tax_profiles
language sql stable security definer set search_path = public, app as $$
  select distinct on (tp.provider) tp.*
  from tax_profiles tp join branches b on b.id = p_branch and b.tenant_id = tp.tenant_id
  where tp.branch_id = p_branch or tp.branch_id is null
  order by tp.provider, tp.branch_id nulls last
$$;

-- ---- Queueing ------------------------------------------------------------------------------
-- Each counter has its own running number per authority, in the order its documents were made.
-- Offline uploads are replayed in the counter's order (0017), so the queue order is the order the
-- customer received the bills.
create or replace function app.enqueue_tax(p_doc_type text, p_doc uuid, p_branch uuid, p_device uuid, p_at timestamptz)
returns int
language plpgsql security definer set search_path = public, app as $$
declare
  tp tax_profiles;
  n int := 0;
  seq bigint;
begin
  for tp in select * from app.tax_profiles_for(p_branch) x where x.is_enabled loop
    seq := substring(app.next_doc_number(tp.tenant_id, 'tax:' || p_device || ':' || tp.provider, 'x') from 3)::bigint;
    insert into tax_submissions (tenant_id, branch_id, device_id, device_seq, provider, document_type, sale_id, sale_return_id,
                                 status, next_attempt_at, queued_at)
    values (tp.tenant_id, p_branch, p_device, seq, tp.provider, p_doc_type,
            case when p_doc_type = 'sale' then p_doc end, case when p_doc_type = 'return' then p_doc end,
            'queued', now(), p_at);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function app.tax_status_on_sale() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if exists (select 1 from app.tax_profiles_for(new.branch_id) x where x.is_enabled) then
    new.tax_status := 'pending';
  end if;
  return new;
end $$;
create trigger trg_tax_status before insert on sales for each row execute function app.tax_status_on_sale();

create or replace function app.queue_sale_for_tax() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  if new.tax_status = 'pending' then
    perform app.enqueue_tax('sale', new.id, new.branch_id, new.device_id, new.sold_at);
  end if;
  return null;
end $$;
-- The document itself (with its lines) is put together only when it is sent.
create trigger trg_queue_sale_tax after insert on sales for each row execute function app.queue_sale_for_tax();

create or replace function app.queue_return_for_tax() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare dev uuid := (select device_id from sales where id = new.original_sale_id);
begin
  if (select tax_status from sales where id = new.original_sale_id) <> 'not_applicable' then
    perform app.enqueue_tax('return', new.id, new.branch_id, coalesce(new.device_id, dev), new.returned_at);
  end if;
  return null;
end $$;
create trigger trg_queue_return_tax after insert on sale_returns for each row execute function app.queue_return_for_tax();

-- A bill already given to the tax authority (or waiting to be) is corrected with a return, never
-- voided, so both books show the same story (D49).
alter function public.void_sale(uuid, text, uuid, uuid) rename to void_sale_unchecked;
create or replace function public.void_sale(p_sale uuid, p_reason text, p_approval uuid default null, p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
begin
  if (select tax_status from sales where id = p_sale and tenant_id = app.tenant_id()) in ('pending', 'reported', 'failed') then
    raise exception 'This bill is reported to the tax authority; take a return instead of voiding it' using errcode = 'P0001';
  end if;
  perform public.void_sale_unchecked(p_sale, p_reason, p_approval, p_session);
end $$;
revoke all on function public.void_sale_unchecked(uuid, text, uuid, uuid) from public, anon, authenticated;

-- ---- The neutral invoice ------------------------------------------------------------------
-- Everything an authority could need, in plain names. Adapters map it to their own format.
create or replace function app.tax_document(p_submission uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  ts tax_submissions;
  tp tax_profiles;
  s sales;
  r sale_returns;
  items jsonb;
  cust customers;
begin
  select * into ts from tax_submissions where id = p_submission;
  select * into tp from app.tax_profiles_for(ts.branch_id) x where x.provider = ts.provider;
  if ts.document_type = 'sale' then
    select * into s from sales where id = ts.sale_id;
  else
    select * into r from sale_returns where id = ts.sale_return_id;
    select * into s from sales where id = r.original_sale_id;
  end if;
  select * into cust from customers where id = s.customer_id;
  if ts.document_type = 'sale' then
    select jsonb_agg(jsonb_build_object(
             'code', coalesce((select bc.code from barcodes bc where bc.product_unit_id = sl.product_unit_id and bc.archived_at is null
                               order by bc.created_at limit 1), left(sl.product_id::text, 8)),
             'name', p.brand_name || coalesce(' ' || p.strength, ''), 'quantity', sl.qty, 'unit', u.code,
             'item_code', coalesce(tc.provider_item_code, ''), 'tax_rate_bp', sl.tax_rate_bp,
             'sale_value', sl.line_total - sl.tax_amount, 'tax', sl.tax_amount, 'discount', sl.discount_amount,
             'total', sl.line_total) order by sl.line_no)
    into items
    from sale_lines sl join products p on p.id = sl.product_id
    join product_units pu on pu.id = sl.product_unit_id join units u on u.id = pu.unit_id
    left join tax_categories tc on tc.id = coalesce(sl.tax_category_id, p.tax_category_id)
    where sl.sale_id = s.id;
  else
    select jsonb_agg(jsonb_build_object(
             'code', left(sl.product_id::text, 8), 'name', p.brand_name || coalesce(' ' || p.strength, ''),
             'quantity', app.div_round(rl.qty_base::numeric * sl.qty, sl.qty_base), 'unit', u.code,
             'item_code', coalesce(tc.provider_item_code, ''), 'tax_rate_bp', sl.tax_rate_bp,
             'sale_value', rl.refund_amount - coalesce(app.div_round(rl.refund_amount::numeric * sl.tax_amount, nullif(sl.line_total, 0)), 0),
             'tax', coalesce(app.div_round(rl.refund_amount::numeric * sl.tax_amount, nullif(sl.line_total, 0)), 0),
             'discount', 0, 'total', rl.refund_amount) order by sl.line_no)
    into items
    from return_lines rl join sale_lines sl on sl.id = rl.sale_line_id join products p on p.id = sl.product_id
    join product_units pu on pu.id = sl.product_unit_id join units u on u.id = pu.unit_id
    left join tax_categories tc on tc.id = coalesce(sl.tax_category_id, p.tax_category_id)
    where rl.sale_return_id = r.id;
  end if;
  return jsonb_build_object(
    'submission_id', ts.id, 'provider', ts.provider, 'environment', tp.environment, 'sequence', ts.device_seq,
    'document_type', ts.document_type,
    'invoice_number', case when ts.document_type = 'sale' then s.invoice_number else r.return_number end,
    'original_invoice_number', case when ts.document_type = 'return' then s.invoice_number end,
    'original_authority_number', case when ts.document_type = 'return' then s.authority_invoice_number end,
    'issued_at', case when ts.document_type = 'sale' then s.sold_at else r.returned_at end,
    'seller', jsonb_build_object('ntn', tp.ntn, 'strn', tp.strn, 'pos_id', tp.pos_id, 'registration_no', tp.registration_no,
                                 'name', (select name from tenants where id = ts.tenant_id),
                                 'branch', (select name from branches where id = ts.branch_id)),
    'buyer', jsonb_build_object('name', cust.name, 'phone', cust.phone, 'cnic', cust.cnic),
    'payment_mode', case when ts.document_type = 'return' then r.refund_method
                         when s.udhaar_amount > 0 then 'credit'
                         when (select count(distinct method) from sale_payments where sale_id = s.id) > 1 then 'mixed'
                         else coalesce((select min(method) from sale_payments where sale_id = s.id), 'cash') end,
    'items', coalesce(items, '[]'),
    'totals', jsonb_build_object(
      'quantity', (select coalesce(sum((i ->> 'quantity')::numeric), 0) from jsonb_array_elements(coalesce(items, '[]')) i),
      'sale_value', (select coalesce(sum((i ->> 'sale_value')::bigint), 0) from jsonb_array_elements(coalesce(items, '[]')) i),
      'tax', (select coalesce(sum((i ->> 'tax')::bigint), 0) from jsonb_array_elements(coalesce(items, '[]')) i),
      'discount', (select coalesce(sum((i ->> 'discount')::bigint), 0) from jsonb_array_elements(coalesce(items, '[]')) i),
      'total', case when ts.document_type = 'sale' then s.grand_total else r.refund_total end));
end $$;

-- ---- The sender (Edge Function tax-worker, service role) -------------------------------------
-- Gives out the next document of each counter and authority, and only once the one before it has
-- its answer: a counter's invoices always reach the authority in order. A send left hanging (the
-- worker died) is taken back after 5 minutes.
create or replace function public.tax_claim_batch(p_limit int default 50) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  ids uuid[];
  out jsonb := '[]';
  t tax_submissions;
begin
  update tax_submissions set status = 'retrying', next_attempt_at = now(), last_error = 'send timed out'
  where status = 'sending' and updated_at < now() - interval '5 minutes';

  select coalesce(array_agg(z.id), '{}') into ids from (
    select h.id from (
      select distinct on (x.device_id, x.provider) x.id, x.tenant_id, x.provider, x.status, x.next_attempt_at, x.queued_at
      from tax_submissions x
      where x.status not in ('accepted', 'rejected')
      order by x.device_id, x.provider, x.device_seq) h
    where h.status in ('queued', 'retrying', 'stuck') and coalesce(h.next_attempt_at, '-infinity') <= now()
      and exists (select 1 from tax_profiles tp where tp.is_enabled and tp.provider = h.provider and tp.tenant_id = h.tenant_id)
    order by h.queued_at
    limit greatest(coalesce(p_limit, 50), 1)) z;

  for t in update tax_submissions set status = 'sending', attempts = attempts + 1
           where id = any (ids) and status in ('queued', 'retrying', 'stuck') returning * loop
    update tax_submissions set request_payload = app.tax_document(t.id) where id = t.id;
    out := out || jsonb_build_object('id', t.id, 'tenant_id', t.tenant_id, 'device_id', t.device_id, 'provider', t.provider,
                                     'attempt', t.attempts, 'vault_secret_id',
                                     (select x.vault_secret_id from app.tax_profiles_for(t.branch_id) x where x.provider = t.provider),
                                     'document', app.tax_document(t.id));
  end loop;
  return out;
end $$;

-- The authority's answer. Accepted: its invoice number and QR go on the bill. A temporary failure
-- (network, 5xx, timeout) is retried after 1, 2, 4 ... minutes, at most an hour apart; a refusal
-- of the document itself is final, and the owner is told.
create or replace function public.tax_record_result(p_submission uuid, p_accepted boolean, p_authority_number text default null,
                                                    p_qr text default null, p_response jsonb default null,
                                                    p_error text default null, p_retryable boolean default true) returns void
language plpgsql security definer set search_path = public, app as $$
declare t tax_submissions;
begin
  select * into t from tax_submissions where id = p_submission for update;
  if not found then raise exception 'Submission not found' using errcode = 'P0002'; end if;
  if t.status <> 'sending' then return; end if;   -- a late, duplicate answer
  if p_accepted then
    if coalesce(p_authority_number, '') = '' then raise exception 'An accepted invoice needs the authority''s number' using errcode = '22023'; end if;
    update tax_submissions set status = 'accepted', authority_invoice_number = p_authority_number, qr_payload = p_qr,
           response_payload = p_response, accepted_at = now(), last_error = null, next_attempt_at = null
    where id = t.id;
    if t.document_type = 'sale' then
      update sales set authority_invoice_number = coalesce(authority_invoice_number, p_authority_number),
             tax_status = case when not exists (select 1 from tax_submissions x where x.sale_id = t.sale_id and x.id <> t.id
                                                and x.status <> 'accepted') then 'reported' else tax_status end
      where id = t.sale_id;
    end if;
  elsif p_retryable then
    update tax_submissions set status = 'retrying', response_payload = p_response, last_error = p_error,
           next_attempt_at = now() + least(interval '1 minute' * power(2, greatest(t.attempts - 1, 0)), interval '1 hour')
    where id = t.id;
  else
    update tax_submissions set status = 'rejected', response_payload = p_response, last_error = p_error, next_attempt_at = null
    where id = t.id;
    if t.document_type = 'sale' then update sales set tax_status = 'failed' where id = t.sale_id; end if;
    perform app.notify(t.tenant_id, 'tax_rejected', upper(t.provider) || ' refused an invoice',
                       coalesce((select invoice_number from sales where id = t.sale_id),
                                (select return_number from sale_returns where id = t.sale_return_id), '') || ': ' || coalesce(p_error, 'no reason given'),
                       'tax_submission', t.id, 'tax_queue_stuck');
  end if;
end $$;

-- The owner sends a refused document again (after fixing, say, a missing tax code).
create or replace function public.retry_tax_submission(p_submission uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin('tax.manage');
begin
  update tax_submissions set status = 'queued', next_attempt_at = now(), last_error = null
  where id = p_submission and tenant_id = app.tenant_id() and status in ('rejected', 'stuck', 'retrying');
  if not found then raise exception 'Submission not found or already sent' using errcode = 'P0002'; end if;
  update sales set tax_status = 'pending'
  where id = (select sale_id from tax_submissions where id = p_submission) and tax_status = 'failed';
end $$;

-- The queue at a glance, and the tax report.
create or replace function public.report_tax(p_from date, p_to date, p_branch uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare b uuid[] := app.report_branches('reports.tax', p_branch);
begin
  return jsonb_build_object(
    'queue', (select coalesce(jsonb_object_agg(provider || ':' || status, n), '{}') from (
               select provider, status, count(*) n from tax_submissions
               where tenant_id = app.tenant_id() and branch_id = any (b) and status <> 'accepted' group by 1, 2) q),
    'oldest_waiting', (select min(queued_at) from tax_submissions where tenant_id = app.tenant_id() and branch_id = any (b)
                       and status not in ('accepted', 'rejected')),
    'sales_tax', (select coalesce(sum(f.tax), 0) from app.sale_facts(p_from, p_to, b) f),
    'taxable_sales', (select coalesce(sum(f.revenue), 0) from app.sale_facts(p_from, p_to, b) f where f.tax <> 0),
    'exempt_sales', (select coalesce(sum(f.revenue), 0) from app.sale_facts(p_from, p_to, b) f where f.tax = 0),
    'not_reported', (select coalesce(jsonb_agg(jsonb_build_object('invoice', coalesce(s.invoice_number, r.return_number),
                       'provider', t.provider, 'status', t.status, 'attempts', t.attempts, 'error', t.last_error,
                       'queued_at', t.queued_at) order by t.queued_at), '[]')
                     from tax_submissions t left join sales s on s.id = t.sale_id left join sale_returns r on r.id = t.sale_return_id
                     where t.tenant_id = app.tenant_id() and t.branch_id = any (b) and t.status in ('rejected', 'stuck', 'retrying')));
end $$;

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
-- Tax queue stuck, licences to renew, PCs offline, batches expiring, low stock, approvals expired.
create or replace function public.run_scheduled_checks(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  r record;
  rule record;
  n_tax int := 0; n_lic int := 0; n_dev int := 0; n_exp int := 0; n_low int := 0; n_appr int;
begin
  update approval_requests set status = 'expired' where status = 'pending' and expires_at < p_now;
  get diagnostics n_appr = row_count;

  -- The oldest unsent document of each counter, waiting longer than the owner's limit (default 6 hours).
  for r in select distinct on (t.device_id, t.provider) t.*, d.name as device_name from tax_submissions t join devices d on d.id = t.device_id
           where t.status not in ('accepted', 'rejected') order by t.device_id, t.provider, t.device_seq loop
    select * into rule from app.alert_rule(r.tenant_id, 'tax_queue_stuck');
    if rule.enabled and r.queued_at < p_now - make_interval(hours => coalesce(rule.threshold, 6)::int) then
      update tax_submissions set status = 'stuck' where id = r.id and status in ('queued', 'retrying');
      n_tax := n_tax + app.notify(r.tenant_id, 'tax_queue_stuck', upper(r.provider) || ' invoices waiting at ' || r.device_name,
                                  'Bills from ' || to_char(r.queued_at at time zone 'Asia/Karachi', 'DD Mon HH24:MI')
                                  || ' have not reached ' || upper(r.provider) || coalesce(' (' || r.last_error || ')', '')
                                  || '. They will keep being sent automatically.', 'device', r.device_id, 'tax_queue_stuck',
                                  interval '12 hours');
    end if;
  end loop;

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

  return jsonb_build_object('approvals_expired', n_appr, 'tax_stuck', n_tax, 'licences', n_lic, 'devices_offline', n_dev,
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
revoke all on function public.void_sale_unchecked(uuid, text, uuid, uuid) from authenticated;
grant execute on function
  public.save_tax_profile(jsonb), public.retry_tax_submission(uuid), public.report_tax(date, date, uuid),
  public.save_prescription(jsonb, uuid), public.confirm_prescription(uuid, uuid), public.controlled_register(uuid, date, date, uuid),
  public.save_branch_licence(jsonb), public.licences_due(date), public.platform_issue_recall(jsonb),
  public.platform_lift_recall(uuid, text), public.void_sale(uuid, text, uuid, uuid), public.get_receipt(uuid)
  to authenticated;
-- Supabase gives new functions to signed-in users by default; these are not theirs.
revoke all on function app.receipt_data(uuid) from authenticated;
revoke all on function public.tax_claim_batch(int), public.tax_record_result(uuid, boolean, text, text, jsonb, text, boolean),
  public.run_scheduled_checks(timestamptz) from authenticated;
-- The sender and the scheduler run with the service role only.
grant execute on function public.tax_claim_batch(int), public.tax_record_result(uuid, boolean, text, text, jsonb, text, boolean),
  public.run_scheduled_checks(timestamptz) to service_role;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;
select app.assert_rls_everywhere();
