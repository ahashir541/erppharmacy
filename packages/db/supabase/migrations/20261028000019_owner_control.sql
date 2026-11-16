-- 0019: Phase 6 — owner control. Money columns hidden from everyone but the owner's views,
-- approvals to the owner's phone (or the owner's PIN at the counter), alerts, expenses,
-- salaries and advances.

-- ---- Money stays off the counter, even through the API (brief, Phase 6 "done when") --------
-- A counter PC may look up a recent bill (to reprint or take a return), but adding up bills
-- would show the day's sales and the drawer's expected cash. So the amount columns of bills are
-- not readable by signed-in clients at all; owners read them through the owner_* views below,
-- which check sales.view_totals. A single bill's receipt comes from get_receipt.
do $$
declare
  t text;
  cols text;
begin
  foreach t in array array['sales', 'sale_lines', 'sale_payments', 'sale_returns', 'return_lines'] loop
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
    where table_schema = 'public' and table_name = t
      and not (data_type in ('bigint', 'integer', 'numeric')
               and column_name ~ '(amount|total|price|paid|change|udhaar|refund|discount|tax|rounding|value)');
    execute format('revoke select on %I from authenticated', t);
    execute format('grant select (%s) on %I to authenticated', cols, t);
  end loop;
end $$;

-- Owner views: full rows, for people allowed to see sales totals at that branch.
create view owner_sales with (security_barrier) as
  select s.* from sales s
  where s.tenant_id = app.tenant_id() and app.current_user_id() is not null
    and s.branch_id = any (app.branches_with('sales.view_totals'));
create view owner_sale_lines with (security_barrier) as
  select l.* from sale_lines l where exists (select 1 from owner_sales s where s.id = l.sale_id);
create view owner_sale_payments with (security_barrier) as
  select p.* from sale_payments p where exists (select 1 from owner_sales s where s.id = p.sale_id);
create view owner_sale_returns with (security_barrier) as
  select r.* from sale_returns r
  where r.tenant_id = app.tenant_id() and app.current_user_id() is not null
    and r.branch_id = any (app.branches_with('sales.view_totals'));
create view owner_return_lines with (security_barrier) as
  select l.* from return_lines l where exists (select 1 from owner_sale_returns r where r.id = l.sale_return_id);
grant select on owner_sales, owner_sale_lines, owner_sale_payments, owner_sale_returns, owner_return_lines to authenticated;

-- ---- Notifications to the owner -------------------------------------------------------
-- Alert rules with their defaults. A pharmacy changes them in settings (set_alert_rule).
create or replace function app.alert_rule(p_tenant uuid, p_kind text, out enabled boolean, out threshold bigint, out recipients uuid[])
language sql stable security definer set search_path = public, app as $$
  select coalesce(r.enabled, true),
         coalesce(r.threshold, case p_kind
           when 'large_discount' then 50000      -- Rs 500 off one bill
           when 'cash_short' then 10000          -- Rs 100 short in a drawer
           when 'device_offline' then 24         -- hours
           when 'expiring_batches' then 90       -- days
           else null end),
         coalesce(r.recipients, '{}')
  from (select 1) one
  left join alert_rules r on r.tenant_id = p_tenant and r.kind = p_kind
$$;

-- Writes a notification for each recipient (empty list = every active owner). The push worker
-- (Edge Function) sends those with pushed_at null to the owners' phones. Duplicate alerts about
-- the same thing within p_quiet are skipped.
create or replace function app.notify(p_tenant uuid, p_kind text, p_title text, p_body text,
                                      p_ref_type text default null, p_ref_id uuid default null,
                                      p_rule text default null, p_quiet interval default null,
                                      p_recipients uuid[] default null) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  rule record;
  rule_recipients uuid[] := '{}';
  n int;
begin
  if p_rule is not null then
    select * into rule from app.alert_rule(p_tenant, p_rule);
    if not rule.enabled then return 0; end if;
    rule_recipients := rule.recipients;
  end if;
  if p_quiet is not null and exists (select 1 from notifications where tenant_id = p_tenant and kind = p_kind
       and reference_id is not distinct from p_ref_id and created_at > now() - p_quiet) then
    return 0;
  end if;
  insert into notifications (tenant_id, user_id, kind, title, body, reference_type, reference_id)
  select p_tenant, u.id, p_kind, p_title, p_body, p_ref_type, p_ref_id
  from users u
  where u.tenant_id = p_tenant and u.status = 'active' and u.archived_at is null
    and (case when coalesce(cardinality(p_recipients), 0) > 0 then u.id = any (p_recipients)
              when coalesce(cardinality(rule_recipients), 0) > 0 then u.id = any (rule_recipients)
              else u.kind = 'owner' end);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function app.money_text(p bigint) returns text
language sql immutable as $$ select 'Rs ' || to_char(p / 100.0, 'FM999,999,999,990.00') $$;

create or replace function public.set_alert_rule(p_kind text, p_enabled boolean, p_threshold bigint default null,
                                                 p_recipients uuid[] default '{}') returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin('settings.manage');
begin
  insert into alert_rules (tenant_id, kind, enabled, threshold, recipients, created_by)
  values (app.tenant_id(), p_kind, p_enabled, p_threshold, coalesce(p_recipients, '{}'), uid)
  on conflict (tenant_id, kind) do update
    set enabled = excluded.enabled, threshold = excluded.threshold, recipients = excluded.recipients;
end $$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin(null);
  n int;
begin
  update notifications set read_at = now()
  where user_id = uid and read_at is null and (p_ids is null or id = any (p_ids));
  get diagnostics n = row_count;
  return n;
end $$;

-- A phone (web push) for the owner's alerts.
create or replace function public.register_push_subscription(p_endpoint text, p_keys jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin(null);
  sid uuid;
begin
  insert into push_subscriptions (tenant_id, user_id, endpoint, keys)
  values (app.tenant_id(), uid, p_endpoint, p_keys)
  on conflict (endpoint) do update set keys = excluded.keys, revoked_at = null, user_id = excluded.user_id
  returning id into sid;
  return sid;
end $$;

-- ---- Alerts raised by what happens ------------------------------------------------------
create or replace function app.alert_on_sale() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  rule record;
  who text := (select full_name from users where id = new.created_by);
  br text := (select name from branches where id = new.branch_id);
begin
  if tg_op = 'INSERT' then
    select * into rule from app.alert_rule(new.tenant_id, 'large_discount');
    if new.discount_total > 0 and new.discount_total >= rule.threshold then
      perform app.notify(new.tenant_id, 'large_discount', 'Large discount at ' || br,
                         who || ' gave ' || app.money_text(new.discount_total) || ' off bill ' || new.invoice_number,
                         'sale', new.id, 'large_discount');
    end if;
  elsif new.status = 'voided' and old.status <> 'voided' then
    perform app.notify(new.tenant_id, 'void', 'Bill voided at ' || br,
                       'Bill ' || new.invoice_number || ' (' || app.money_text(new.grand_total) || ') voided: ' || new.void_reason,
                       'sale', new.id, 'void');
  end if;
  return null;
end $$;
create trigger trg_alert_sale after insert or update of status on sales for each row execute function app.alert_on_sale();

create or replace function app.alert_on_controlled() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare s sales;
begin
  if exists (select 1 from products where id = new.product_id and is_controlled) then
    select * into s from sales where id = new.sale_id;
    perform app.notify(new.tenant_id, 'controlled_sale', 'Controlled drug sold',
                       (select brand_name from products where id = new.product_id) || ' × ' || new.qty || ' on bill ' || s.invoice_number,
                       'sale', s.id, 'controlled_sale');
  end if;
  return null;
end $$;
create trigger trg_alert_controlled after insert on sale_lines for each row execute function app.alert_on_controlled();

create or replace function app.alert_on_reconciliation() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  rule record;
  ds drawer_sessions;
begin
  select * into rule from app.alert_rule(new.tenant_id, 'cash_short');
  if new.variance < 0 and -new.variance >= rule.threshold then
    select * into ds from drawer_sessions where id = new.drawer_session_id;
    perform app.notify(new.tenant_id, 'cash_short', 'Cash short at ' || (select name from branches where id = ds.branch_id),
                       (select full_name from users where id = coalesce(ds.closed_by, ds.opened_by)) || '''s drawer is '
                       || app.money_text(-new.variance) || ' short', 'drawer_session', ds.id, 'cash_short');
  end if;
  return null;
end $$;
create trigger trg_alert_reconciliation after insert or update of variance on drawer_session_reconciliations
  for each row execute function app.alert_on_reconciliation();

create or replace function app.alert_on_flag() returns trigger
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.notify(new.tenant_id, 'sync_flag',
                     case new.kind when 'over_credit_limit' then 'Udhaar over limit' else 'Needs your attention' end,
                     coalesce(new.details ->> 'message', new.kind), 'sync_flag', new.id,
                     case new.kind when 'over_credit_limit' then 'udhaar_over_limit' else 'sync_flag' end);
  return null;
end $$;
create trigger trg_alert_flag after insert on sync_flags for each row execute function app.alert_on_flag();

-- ---- Approvals ------------------------------------------------------------------------
-- The counter asks; the owner's phone shows it at once; the owner taps approve or reject, or
-- enters their PIN at the counter. An approval is for one action and is used up (D16).
-- p: kind, permission_code, amount, reference_type, reference_id, details {bill, items...}, expires_in_minutes (default 15)
create or replace function public.request_approval(p jsonb, p_session uuid default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  br uuid := coalesce(app.device_branch_id(), (p ->> 'branch_id')::uuid);
  aid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  d text;
  who text := (select full_name from users where id = uid);
begin
  if exists (select 1 from approval_requests where id = aid) then return aid; end if;
  perform app.assert_branch(br);
  if not exists (select 1 from permissions where code = p ->> 'permission_code') then
    raise exception 'Unknown permission %', p ->> 'permission_code' using errcode = '22023';
  end if;
  d := app.permission_decision(uid, p ->> 'permission_code', br, app.try_bigint(p ->> 'amount'));
  if d = 'allow' then raise exception 'No approval is needed for this' using errcode = 'P0001'; end if;
  if d = 'deny' or d is null then raise exception 'Permission % is required', p ->> 'permission_code' using errcode = '42501'; end if;
  insert into approval_requests (id, tenant_id, branch_id, kind, permission_code, reference_type, reference_id, amount, details,
                                 expires_at, created_by, device_id)
  values (aid, app.tenant_id(), br, coalesce(p ->> 'kind', 'other'), p ->> 'permission_code', p ->> 'reference_type',
          (p ->> 'reference_id')::uuid, app.try_bigint(p ->> 'amount'), coalesce(p -> 'details', '{}'),
          now() + make_interval(mins => coalesce((p ->> 'expires_in_minutes')::int, 15)), uid, app.ctx_device_id());
  perform app.notify(app.tenant_id(), 'approval', 'Approval needed: ' || replace(coalesce(p ->> 'kind', 'other'), '_', ' '),
                     who || ' at ' || (select name from branches where id = br) || ' asks'
                     || coalesce(' for ' || app.money_text(app.try_bigint(p ->> 'amount')), '')
                     || coalesce(' — ' || (p -> 'details' ->> 'summary'), ''),
                     'approval_request', aid, null, null,
                     (select coalesce(array_agg(u.id), '{}') from users u
                      where u.tenant_id = app.tenant_id() and u.status = 'active' and u.archived_at is null and u.id <> uid
                        and app.permission_decision(u.id, 'approvals.decide', br) = 'allow'
                        and app.permission_decision(u.id, p ->> 'permission_code', br, app.try_bigint(p ->> 'amount')) = 'allow'));
  return aid;
end $$;

create or replace function app.decide(p_request uuid, p_decider uuid, p_approve boolean, p_note text, p_via text) returns void
language plpgsql security definer set search_path = public, app as $$
declare r approval_requests;
begin
  select * into r from approval_requests where id = p_request and tenant_id = app.tenant_id() for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'This request is already %', r.status using errcode = 'P0001'; end if;
  if r.expires_at is not null and r.expires_at < now() then
    update approval_requests set status = 'expired' where id = r.id;
    raise exception 'This request has expired; ask again' using errcode = 'P0001';
  end if;
  if r.created_by = p_decider then raise exception 'You cannot approve your own request' using errcode = '42501'; end if;
  if app.permission_decision(p_decider, 'approvals.decide', r.branch_id) <> 'allow'
     or app.permission_decision(p_decider, r.permission_code, r.branch_id, r.amount) <> 'allow' then
    raise exception 'You may not approve this' using errcode = '42501';
  end if;
  update approval_requests set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = p_decider, decided_at = now(), decided_via = p_via, decision_note = p_note
  where id = r.id;
  perform app.log_event(case when p_approve then 'approved' else 'rejected' end, 'approval_requests', r.id,
                        jsonb_build_object('kind', r.kind, 'amount', r.amount, 'via', p_via), r.branch_id);
end $$;

-- From the owner's phone or web app.
create or replace function public.decide_approval(p_request uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin(null);
begin
  perform app.decide(p_request, uid, p_approve, p_note, 'app');
end $$;

-- At the counter: the owner (or a manager allowed to approve) types their PIN on the counter PC,
-- which checks it against the PIN hash it holds, as for any sign-in (D34).
create or replace function public.approve_at_counter(p_request uuid, p_approver uuid, p_session uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
begin
  if app.current_device_id() is null or app.current_user_id() is not null then
    raise exception 'Counter approval happens on a registered pharmacy PC' using errcode = '42501';
  end if;
  if not exists (select 1 from user_pins where user_id = p_approver and (locked_until is null or locked_until < now())) then
    raise exception 'This person has no PIN, or it is locked' using errcode = '42501';
  end if;
  perform app.decide(p_request, p_approver, true, 'PIN at the counter', 'counter_pin');
end $$;

create or replace function public.cancel_approval(p_request uuid, p_session uuid default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_actor(p_session);
begin
  update approval_requests set status = 'cancelled'
  where id = p_request and tenant_id = app.tenant_id() and created_by = uid and status = 'pending';
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
end $$;

-- ---- Expenses -------------------------------------------------------------------------
create or replace function app.ensure_expense_categories(p_tenant uuid) returns void
language sql security definer set search_path = public, app as $$
  insert into expense_categories (tenant_id, name, name_ur)
  select p_tenant, c.name, c.name_ur
  from (values ('Rent', 'کرایہ'), ('Salaries', 'تنخواہیں'), ('Electricity', 'بجلی'), ('Generator fuel', 'جنریٹر کا ایندھن'),
               ('Tea and refreshments', 'چائے'), ('Repairs', 'مرمت'), ('Transport', 'کرایہ گاڑی'), ('Other', 'دیگر')) c(name, name_ur)
  where not exists (select 1 from expense_categories where tenant_id = p_tenant)
  on conflict do nothing
$$;

create or replace function public.save_expense_category(p_name text, p_name_ur text default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('expenses.manage');
  cid uuid;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'A name is required' using errcode = '22023'; end if;
  insert into expense_categories (tenant_id, name, name_ur, created_by) values (app.tenant_id(), trim(p_name), p_name_ur, uid)
  on conflict (tenant_id, name) do update set name_ur = coalesce(excluded.name_ur, expense_categories.name_ur), archived_at = null
  returning id into cid;
  return cid;
end $$;

-- p: id?, branch_id, category_id | category (name), description, amount, expense_date,
--    paid_from 'drawer' (drawer_session_id) | 'bank_account' (bank_account_id) | 'unpaid', receipt_paths [], approval_id
create or replace function public.post_expense(p jsonb, p_session uuid default null) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  br uuid := coalesce(app.device_branch_id(), (p ->> 'branch_id')::uuid);
  eid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  amt bigint := app.try_bigint(p ->> 'amount');
  cat uuid;
  ds drawer_sessions;
  paid_from text := coalesce(p ->> 'paid_from', 'drawer');
begin
  if exists (select 1 from expenses where id = eid) then return eid; end if;
  perform app.assert_branch(br);
  if amt is null or amt <= 0 then raise exception 'The amount must be above 0' using errcode = '22023'; end if;
  perform app.require_decision(uid, 'expenses.create', br, amt, (p ->> 'approval_id')::uuid, 'other', eid);
  perform app.ensure_expense_categories(tid);
  cat := coalesce((p ->> 'category_id')::uuid,
                  (select id from expense_categories where tenant_id = tid and lower(name) = lower(trim(p ->> 'category'))));
  if not exists (select 1 from expense_categories where id = cat and tenant_id = tid and archived_at is null) then
    raise exception 'Choose an expense category' using errcode = '22023';
  end if;
  if coalesce(trim(p ->> 'description'), '') = '' then raise exception 'Say what it was for' using errcode = '22023'; end if;
  if paid_from = 'drawer' then
    select * into ds from drawer_sessions where id = (p ->> 'drawer_session_id')::uuid and tenant_id = tid;
    if not found or ds.status <> 'open' or ds.branch_id <> br then
      raise exception 'Paying from the drawer needs an open drawer at this branch' using errcode = 'P0001';
    end if;
  elsif paid_from = 'bank_account' then
    if not exists (select 1 from bank_accounts where id = (p ->> 'bank_account_id')::uuid and tenant_id = tid and archived_at is null) then
      raise exception 'Choose the account it was paid from' using errcode = 'P0002';
    end if;
  elsif paid_from <> 'unpaid' then
    raise exception 'Paid from must be drawer, bank_account or unpaid' using errcode = '22023';
  end if;
  insert into expenses (id, tenant_id, branch_id, category_id, recurring_expense_id, description, amount, expense_date, paid_from,
                        drawer_session_id, bank_account_id, receipt_paths, created_by, device_id)
  values (eid, tid, br, cat, (p ->> 'recurring_expense_id')::uuid, trim(p ->> 'description'), amt,
          coalesce((p ->> 'expense_date')::date, app.business_date(br)), paid_from, ds.id,
          case when paid_from = 'bank_account' then (p ->> 'bank_account_id')::uuid end,
          coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'receipt_paths') x), '{}'), uid, app.ctx_device_id());
  if paid_from <> 'unpaid' then
    insert into cash_movements (tenant_id, branch_id, drawer_session_id, bank_account_id, movement_type, amount, reference_type,
                                reference_id, memo, occurred_at, created_by, device_id)
    values (tid, br, ds.id, case when paid_from = 'bank_account' then (p ->> 'bank_account_id')::uuid end, 'expense', -amt,
            'expense', eid, trim(p ->> 'description'), now(), uid, app.ctx_device_id());
  end if;
  perform app.log_event('expense', 'expenses', eid, jsonb_build_object('amount', amt, 'paid_from', paid_from), br);
  return eid;
end $$;

create or replace function public.void_expense(p_expense uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('expenses.manage');
  e expenses;
  m cash_movements;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'A reason is required' using errcode = '22023'; end if;
  select * into e from expenses where id = p_expense and tenant_id = app.tenant_id() for update;
  if not found or e.status <> 'posted' then raise exception 'Expense not found' using errcode = 'P0002'; end if;
  for m in select * from cash_movements where reference_type = 'expense' and reference_id = e.id loop
    insert into cash_movements (tenant_id, branch_id, drawer_session_id, bank_account_id, movement_type, amount, reference_type,
                                reference_id, reverses_movement_id, memo, occurred_at, created_by)
    values (m.tenant_id, m.branch_id, m.drawer_session_id, m.bank_account_id, 'reversal', -m.amount, 'expense', e.id, m.id,
            p_reason, now(), uid);
  end loop;
  update expenses set status = 'voided', voided_at = now(), void_reason = p_reason where id = e.id;
end $$;

-- Rent, salaries' standing costs, internet...: due ones become unpaid expenses the owner then pays.
create or replace function public.save_recurring_expense(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('expenses.manage');
  rid uuid;
begin
  perform app.ensure_expense_categories(app.tenant_id());
  insert into recurring_expenses (id, tenant_id, branch_id, category_id, description, amount, frequency, next_due_on, created_by)
  values (coalesce((p ->> 'id')::uuid, app.uuid_v7()), app.tenant_id(), (p ->> 'branch_id')::uuid,
          coalesce((p ->> 'category_id')::uuid, (select id from expense_categories where tenant_id = app.tenant_id()
                                                  and lower(name) = lower(trim(p ->> 'category')))),
          p ->> 'description', app.try_bigint(p ->> 'amount'), coalesce(p ->> 'frequency', 'monthly'), (p ->> 'next_due_on')::date, uid)
  on conflict (id) do update set amount = excluded.amount, description = excluded.description, frequency = excluded.frequency,
                                 next_due_on = excluded.next_due_on
  returning id into rid;
  return rid;
end $$;

create or replace function public.post_due_recurring_expenses(p_today date default current_date) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('expenses.manage');
  r recurring_expenses;
  n int := 0;
begin
  for r in select * from recurring_expenses where tenant_id = app.tenant_id() and paused_at is null
             and next_due_on <= p_today and branch_id is not null for update loop
    while r.next_due_on <= p_today loop
      insert into expenses (tenant_id, branch_id, category_id, recurring_expense_id, description, amount, expense_date, paid_from, created_by)
      values (r.tenant_id, r.branch_id, r.category_id, r.id, r.description, r.amount, r.next_due_on, 'unpaid', uid);
      n := n + 1;
      r.next_due_on := r.next_due_on + case r.frequency when 'weekly' then interval '7 days'
                                                         when 'monthly' then interval '1 month' else interval '1 year' end;
    end loop;
    update recurring_expenses set next_due_on = r.next_due_on where id = r.id;
  end loop;
  return n;
end $$;

-- ---- Salaries and advances --------------------------------------------------------------
create or replace function public.set_salary_rate(p_user uuid, p_monthly bigint, p_from date) returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin('payroll.manage');
begin
  perform app.own_user(p_user);
  insert into salary_rates (tenant_id, user_id, monthly_amount, effective_from, created_by)
  values (app.tenant_id(), p_user, p_monthly, p_from, uid)
  on conflict (user_id, effective_from) do nothing;
  if not found then raise exception 'A rate from that date already exists' using errcode = '23505'; end if;
end $$;

-- Money paid out of a drawer or account (cash_movements) for payroll.
create or replace function app.pay_out(p jsonb, p_type text, p_amount bigint, p_ref_type text, p_ref uuid, p_uid uuid, p_memo text)
returns void
language plpgsql security definer set search_path = public, app as $$
declare ds drawer_sessions;
begin
  if (p ->> 'drawer_session_id') is not null then
    select * into ds from drawer_sessions where id = (p ->> 'drawer_session_id')::uuid and tenant_id = app.tenant_id();
    if not found or ds.status <> 'open' then raise exception 'Paying in cash needs an open drawer' using errcode = 'P0001'; end if;
  elsif not exists (select 1 from bank_accounts where id = (p ->> 'bank_account_id')::uuid and tenant_id = app.tenant_id()) then
    raise exception 'Choose the drawer or account it was paid from' using errcode = 'P0002';
  end if;
  insert into cash_movements (tenant_id, branch_id, drawer_session_id, bank_account_id, movement_type, amount, reference_type,
                              reference_id, memo, occurred_at, created_by)
  values (app.tenant_id(), ds.branch_id, ds.id, case when ds.id is null then (p ->> 'bank_account_id')::uuid end, p_type, -p_amount,
          p_ref_type, p_ref, p_memo, now(), p_uid);
end $$;

-- p: user_id, amount, given_on, recovery_per_month (default: all from the next salary), notes,
--    drawer_session_id | bank_account_id
create or replace function public.give_staff_advance(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('payroll.manage');
  aid uuid := app.uuid_v7();
  amt bigint := app.try_bigint(p ->> 'amount');
begin
  perform app.own_user((p ->> 'user_id')::uuid);
  if amt is null or amt <= 0 then raise exception 'The amount must be above 0' using errcode = '22023'; end if;
  insert into staff_advances (id, tenant_id, user_id, amount, given_on, recovery_per_month, notes, created_by)
  values (aid, app.tenant_id(), (p ->> 'user_id')::uuid, amt, coalesce((p ->> 'given_on')::date, current_date),
          app.try_bigint(p ->> 'recovery_per_month'), p ->> 'notes', uid);
  perform app.pay_out(p, 'staff_advance', amt, 'staff_advance', aid, uid, 'Advance to ' || (select full_name from users where id = (p ->> 'user_id')::uuid));
  return aid;
end $$;

-- What a month's salary will be: the rate in force on the 1st, less other deductions, less what is
-- due back on open advances (oldest first, never more than is left to pay).
create or replace function public.salary_preview(p_user uuid, p_month date, p_other_deductions bigint default 0) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  gross bigint;
  room bigint;
  a record;
  take bigint;
  recoveries jsonb := '[]';
  recovered bigint := 0;
  m date := date_trunc('month', p_month)::date;
begin
  perform app.require_perm('payroll.view');
  select monthly_amount into gross from salary_rates where user_id = p_user and tenant_id = app.tenant_id() and effective_from <= m
  order by effective_from desc limit 1;
  if gross is null then raise exception 'No salary rate is set for this person' using errcode = 'P0002'; end if;
  room := gross - coalesce(p_other_deductions, 0);
  if room < 0 then raise exception 'Deductions are more than the salary' using errcode = '22023'; end if;
  for a in select sa.*, sa.amount - coalesce((select sum(r.amount) from salary_advance_recoveries r
                                               join salaries s on s.id = r.salary_id and s.status <> 'voided'
                                               where r.staff_advance_id = sa.id), 0) as remaining
           from staff_advances sa where sa.user_id = p_user and sa.status = 'open' and sa.given_on < m + interval '1 month'
           order by sa.given_on, sa.id loop
    take := least(a.remaining, coalesce(a.recovery_per_month, a.remaining), room);
    continue when take <= 0;
    recoveries := recoveries || jsonb_build_object('staff_advance_id', a.id, 'amount', take, 'remaining_after', a.remaining - take);
    recovered := recovered + take;
    room := room - take;
  end loop;
  return jsonb_build_object('user_id', p_user, 'period_month', m, 'gross_amount', gross, 'other_deductions', coalesce(p_other_deductions, 0),
                            'advance_recovery', recovered, 'net_amount', gross - coalesce(p_other_deductions, 0) - recovered,
                            'recoveries', recoveries);
end $$;

-- p: user_id, month, other_deductions, drawer_session_id | bank_account_id
create or replace function public.pay_salary(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('payroll.manage');
  pv jsonb;
  sid uuid := app.uuid_v7();
  r jsonb;
begin
  pv := public.salary_preview((p ->> 'user_id')::uuid, (p ->> 'month')::date, coalesce(app.try_bigint(p ->> 'other_deductions'), 0));
  if exists (select 1 from salaries where user_id = (p ->> 'user_id')::uuid and period_month = (pv ->> 'period_month')::date
             and status <> 'voided') then
    raise exception 'This month''s salary is already paid' using errcode = 'P0001';
  end if;
  insert into salaries (id, tenant_id, user_id, period_month, gross_amount, other_deductions, advance_recovery, net_amount, status,
                        paid_at, created_by)
  values (sid, app.tenant_id(), (p ->> 'user_id')::uuid, (pv ->> 'period_month')::date, (pv ->> 'gross_amount')::bigint,
          (pv ->> 'other_deductions')::bigint, (pv ->> 'advance_recovery')::bigint, (pv ->> 'net_amount')::bigint, 'paid', now(), uid);
  for r in select * from jsonb_array_elements(pv -> 'recoveries') loop
    insert into salary_advance_recoveries (tenant_id, salary_id, staff_advance_id, amount, created_by)
    values (app.tenant_id(), sid, (r ->> 'staff_advance_id')::uuid, (r ->> 'amount')::bigint, uid);
    if (r ->> 'remaining_after')::bigint = 0 then
      update staff_advances set status = 'recovered' where id = (r ->> 'staff_advance_id')::uuid;
    end if;
  end loop;
  if (pv ->> 'net_amount')::bigint > 0 then
    perform app.pay_out(p, 'salary', (pv ->> 'net_amount')::bigint, 'salary', sid, uid,
                        'Salary ' || to_char((pv ->> 'period_month')::date, 'Mon YYYY'));
  end if;
  return pv || jsonb_build_object('salary_id', sid);
end $$;

-- ---- One bill's receipt -----------------------------------------------------------------
-- Whether the caller may see the bill is decided by the sales read policy (the lookup runs as
-- the caller and reads only the id); the amounts are then read by a definer function, since the
-- columns themselves are no longer readable.
create or replace function app.receipt_data(p_sale uuid) returns jsonb
language sql stable security definer set search_path = public, app as $$
  select jsonb_build_object(
    'invoice_number', s.invoice_number, 'sold_at', s.sold_at, 'status', s.status,
    'branch', jsonb_build_object('name', br.name, 'address', br.address, 'phone', br.phone),
    'pharmacy', t.name,
    'lines', (select jsonb_agg(jsonb_build_object(
                'name', p.brand_name, 'strength', p.strength, 'unit', u.code, 'qty', sl.qty,
                'unit_price', sl.unit_price, 'discount', sl.discount_amount, 'tax', sl.tax_amount,
                'line_total', sl.line_total, 'batch', b.batch_number, 'expiry', b.expiry_date) order by sl.line_no)
              from sale_lines sl join products p on p.id = sl.product_id
              join product_units pu on pu.id = sl.product_unit_id join units u on u.id = pu.unit_id
              join batches b on b.id = sl.batch_id
              where sl.sale_id = s.id),
    'subtotal', s.subtotal, 'discount_total', s.discount_total, 'tax_total', s.tax_total,
    'rounding', s.rounding_adjustment, 'grand_total', s.grand_total, 'paid_total', s.paid_total,
    'udhaar', s.udhaar_amount, 'change', s.change_given,
    'payments', (select jsonb_agg(jsonb_build_object('method', method, 'amount', amount)) from sale_payments where sale_id = s.id),
    'tax_invoice_number', s.authority_invoice_number)
  from sales s join branches br on br.id = s.branch_id join tenants t on t.id = s.tenant_id
  where s.id = p_sale
$$;

create or replace function public.get_receipt(p_sale uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select app.receipt_data(s.id) from sales s where s.id = p_sale
$$;

-- ---- Grants ---------------------------------------------------------------------------
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
  public.set_alert_rule(text, boolean, bigint, uuid[]), public.mark_notifications_read(uuid[]),
  public.register_push_subscription(text, jsonb), public.request_approval(jsonb, uuid),
  public.decide_approval(uuid, boolean, text), public.approve_at_counter(uuid, uuid, uuid), public.cancel_approval(uuid, uuid),
  public.save_expense_category(text, text), public.post_expense(jsonb, uuid), public.void_expense(uuid, text),
  public.save_recurring_expense(jsonb), public.post_due_recurring_expenses(date), public.set_salary_rate(uuid, bigint, date),
  public.give_staff_advance(jsonb), public.salary_preview(uuid, date, bigint), public.pay_salary(jsonb),
  public.get_receipt(uuid), app.receipt_data(uuid)
  to authenticated;
grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;
select app.assert_rls_everywhere();
