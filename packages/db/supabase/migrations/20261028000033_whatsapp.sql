-- WhatsApp from the back office, the same on Nuskha Local and Nuskha Cloud.
-- Nuskha prepares each message and opens WhatsApp (app or WhatsApp Web) with it ready; the
-- person presses Send. No WhatsApp Business account is needed. Every message opened is logged
-- in outbound_messages (provider 'wa_link'), and udhaar reminders also in reminders_log.
--
-- Settings (public.set_setting): whatsapp.number (the pharmacy's WhatsApp, signed under each
-- message), whatsapp.owner_number (daily summary; default the owner's phone),
-- whatsapp.language ('ur' | 'roman' | 'en'), udhaar.reminder_interval_days (default 7),
-- whatsapp.template.udhaar / whatsapp.template.refill (the owner's own wording).

-- "Nexum 40mg Tablet" stays as it is; "Panadol" + "500mg" becomes "Panadol 500mg".
create or replace function app.product_label(p_name text, p_strength text) returns text
language sql immutable as $$
  select case when coalesce(p_strength, '') = '' or position(lower(p_strength) in lower(p_name)) > 0 then p_name else p_name || ' ' || p_strength end
$$;
grant execute on function app.product_label(text, text) to authenticated;

-- ---- Settings ----------------------------------------------------------------------------
create or replace function public.office_whatsapp_settings() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select jsonb_build_object(
    'pharmacy', (select name from tenants where id = app.tenant_id()),
    'owner_phone', (select owner_phone from tenants where id = app.tenant_id()),
    'number', (select value #>> '{}' from settings where key = 'whatsapp.number' and branch_id is null limit 1),
    'owner_number', (select value #>> '{}' from settings where key = 'whatsapp.owner_number' and branch_id is null limit 1),
    'language', coalesce((select value #>> '{}' from settings where key = 'whatsapp.language' and branch_id is null limit 1), 'ur'),
    'interval_days', coalesce((select (value #>> '{}')::int from settings where key = 'udhaar.reminder_interval_days' and branch_id is null limit 1), 7),
    'template_udhaar', (select value #>> '{}' from settings where key = 'whatsapp.template.udhaar' and branch_id is null limit 1),
    'template_refill', (select value #>> '{}' from settings where key = 'whatsapp.template.refill' and branch_id is null limit 1))
$$;

-- ---- Who owes udhaar, since when, and who is due a reminder -------------------------------
create or replace function public.office_udhaar_reminders(p_today date) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  tid uuid := app.tenant_id();
  interval_days int;
  out jsonb := '[]'::jsonb;
  pb record;
  c record;
  oldest date;
  oldest_due date;
  late bigint;
  last_at timestamptz;
begin
  perform app.require_perm('udhaar.reminders');
  interval_days := coalesce((app.setting(tid, null, 'udhaar.reminder_interval_days') #>> '{}')::int, 7);
  for pb in select b.party_id, b.balance from party_balances b
            where b.tenant_id = tid and b.party_type = 'customer_account' and b.balance > 0 loop
    select min(o.entry_date), min(coalesce(o.due_date, o.entry_date)),
           coalesce(sum(o.open_amount) filter (where coalesce(o.due_date, o.entry_date) < p_today), 0)
      into oldest, oldest_due, late
      from app.open_items('customer_account', pb.party_id) o where o.open_amount > 0;
    select cu.id, cu.name, cu.phone, cu.reminders_opt_in into c from customers cu
      where cu.account_id = pb.party_id and cu.tenant_id = tid and cu.archived_at is null
      order by (cu.phone is not null and cu.phone <> '') desc, cu.reminders_opt_in desc, cu.created_at limit 1;
    select max(r.created_at) into last_at from reminders_log r where r.tenant_id = tid and r.customer_account_id = pb.party_id;
    out := out || jsonb_build_object(
      'account_id', pb.party_id, 'customer_id', c.id,
      'account_number', (select account_number from customer_accounts where id = pb.party_id),
      'name', coalesce(c.name, app.party_name('customer_account', pb.party_id)),
      'phone', nullif(c.phone, ''), 'reminders_on', coalesce(c.reminders_opt_in, false),
      'balance', pb.balance, 'overdue', late, 'oldest_bill', oldest,
      'days', case when oldest is null then 0 else greatest(p_today - oldest, 0) end,
      'days_late', case when oldest_due is null then 0 else greatest(p_today - oldest_due, 0) end,
      'last_reminded_at', last_at,
      'due', coalesce(c.reminders_opt_in, false) and coalesce(c.phone, '') <> '' and late > 0
             and (last_at is null or last_at < now() - make_interval(days => interval_days)));
  end loop;
  return (select coalesce(jsonb_agg(x order by (x ->> 'due')::boolean desc, (x ->> 'days')::int desc, (x ->> 'balance')::bigint desc), '[]'::jsonb)
          from jsonb_array_elements(out) x);
end $$;

-- One account: name, phone and what they owe now (khata reminder and payment receipt).
create or replace function public.office_customer_contact(p_account uuid) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  tid uuid := app.tenant_id();
  r jsonb;
begin
  perform app.require_perm('udhaar.view_balance');
  select jsonb_build_object('account_id', a.id, 'customer_id', cu.id, 'account_number', a.account_number,
           'name', coalesce(cu.name, app.party_name('customer_account', a.id)), 'phone', nullif(cu.phone, ''),
           'balance', coalesce((select balance from party_balances where party_type = 'customer_account' and party_id = a.id), 0),
           'oldest_bill', (select min(o.entry_date) from app.open_items('customer_account', a.id) o where o.open_amount > 0),
           'last_reminded_at', (select max(created_at) from reminders_log where customer_account_id = a.id))
    into r
    from customer_accounts a
    left join lateral (select * from customers c where c.account_id = a.id and c.archived_at is null
                       order by (c.phone is not null and c.phone <> '') desc, c.created_at limit 1) cu on true
    where a.id = p_account and a.tenant_id = tid;
  if r is null then raise exception 'Account not found' using errcode = 'P0002'; end if;
  return r;
end $$;

-- ---- Log a message that was opened in WhatsApp ---------------------------------------------
-- p: { kind, to_phone, body, related_type?, related_id?, balance? }
create or replace function public.log_whatsapp(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  kind text := coalesce(p ->> 'kind', '');
  uid uuid;
  mid uuid;
begin
  if kind not in ('udhaar_reminder', 'payment_receipt', 'refill_reminder', 'reorder', 'daily_summary', 'bill') then
    raise exception 'Unknown message kind %', kind using errcode = '22023';
  end if;
  uid := app.rpc_begin(case kind when 'udhaar_reminder' then 'udhaar.reminders' when 'refill_reminder' then 'customers.view' else null end);
  if coalesce(p ->> 'to_phone', '') !~ '^[0-9]{10,15}$' then
    raise exception 'Enter a mobile number like 03001234567' using errcode = '22023';
  end if;
  if length(coalesce(p ->> 'body', '')) not between 1 and 4000 then
    raise exception 'The message is empty or too long' using errcode = '22023';
  end if;
  insert into outbound_messages (tenant_id, channel, provider, to_phone, body_rendered, related_type, related_id, status, sent_at, created_by)
  values (app.tenant_id(), 'whatsapp', 'wa_link', p ->> 'to_phone', p ->> 'body', coalesce(p ->> 'related_type', kind),
          (p ->> 'related_id')::uuid, 'sent', now(), uid)
  returning id into mid;
  if kind = 'udhaar_reminder' then
    if not exists (select 1 from customer_accounts where id = (p ->> 'related_id')::uuid and tenant_id = app.tenant_id()) then
      raise exception 'Account not found' using errcode = 'P0002';
    end if;
    insert into reminders_log (tenant_id, customer_account_id, outbound_message_id, balance_at_send, created_by)
    values (app.tenant_id(), (p ->> 'related_id')::uuid, mid, coalesce((p ->> 'balance')::bigint, 0), uid);
  end if;
  return mid;
end $$;

create or replace function public.office_whatsapp_log(p_limit int) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.created_at desc)) from (
    select m.id, m.created_at, m.to_phone, m.related_type kind, m.body_rendered body, u.full_name who
    from outbound_messages m left join users u on u.id = m.created_by
    where m.provider = 'wa_link'
    order by m.created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) x
$$;

-- ---- Regular medicines and refill reminders -------------------------------------------------
create or replace function public.office_regular_medicines(p_customer uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(jsonb_build_object('id', r.id, 'product_id', r.product_id,
           'name', app.product_label(p.brand_name, p.strength), 'interval_days', r.interval_days,
           'last_bought', (select max(s.business_date) from sales s join sale_lines sl on sl.sale_id = s.id
                           where s.customer_id = r.customer_id and s.status = 'completed' and sl.product_id = r.product_id))
         order by p.brand_name))
  from customer_regular_medicines r join products p on p.id = r.product_id
  where r.customer_id = p_customer and r.archived_at is null
$$;

-- p: { customer_id, product_id, interval_days }
create or replace function public.save_regular_medicine(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('customers.manage');
  tid uuid := app.tenant_id();
  days int := (p ->> 'interval_days')::int;
  rid uuid;
begin
  if days is null or days not between 1 and 365 then raise exception 'Refill every 1 to 365 days' using errcode = '22023'; end if;
  if not exists (select 1 from customers where id = (p ->> 'customer_id')::uuid and tenant_id = tid) then
    raise exception 'Customer not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from products where id = (p ->> 'product_id')::uuid and tenant_id = tid) then
    raise exception 'Medicine not found' using errcode = 'P0002';
  end if;
  select id into rid from customer_regular_medicines
    where tenant_id = tid and customer_id = (p ->> 'customer_id')::uuid and product_id = (p ->> 'product_id')::uuid and archived_at is null;
  if rid is null then
    insert into customer_regular_medicines (tenant_id, customer_id, product_id, interval_days, created_by)
    values (tid, (p ->> 'customer_id')::uuid, (p ->> 'product_id')::uuid, days, uid) returning id into rid;
  else
    update customer_regular_medicines set interval_days = days where id = rid;
  end if;
  return rid;
end $$;

create or replace function public.archive_regular_medicine(p_id uuid) returns void
language plpgsql security definer set search_path = public, app as $$
declare uid uuid := app.rpc_begin('customers.manage');
begin
  update customer_regular_medicines set archived_at = now() where id = p_id and tenant_id = app.tenant_id() and archived_at is null;
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
end $$;

-- Refills due within p_days_ahead: next due = last purchase (or the day it was added) + interval.
-- A refill already reminded in this cycle is marked reminded.
create or replace function public.office_refills_due(p_today date, p_days_ahead int) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.next_due, x.name)) from (
    select r.id, c.id customer_id, c.name, nullif(c.phone, '') phone, app.product_label(p.brand_name, p.strength) medicine,
           r.interval_days, lb.last_bought, (coalesce(lb.last_bought, r.created_at::date) + r.interval_days) next_due,
           (coalesce(lb.last_bought, r.created_at::date) + r.interval_days) - p_today days_left,
           (select max(m.created_at) from outbound_messages m where m.related_type = 'regular_medicine' and m.related_id = r.id
              and m.created_at::date >= coalesce(lb.last_bought, r.created_at::date)) reminded_at
    from customer_regular_medicines r
    join customers c on c.id = r.customer_id and c.archived_at is null
    join products p on p.id = r.product_id
    left join lateral (select max(s.business_date) last_bought from sales s join sale_lines sl on sl.sale_id = s.id
                       where s.customer_id = r.customer_id and s.status = 'completed' and sl.product_id = r.product_id) lb on true
    where r.archived_at is null
      and coalesce(lb.last_bought, r.created_at::date) + r.interval_days <= p_today + greatest(coalesce(p_days_ahead, 3), 0)) x
$$;

-- ---- Low stock, grouped by the supplier who last delivered it -------------------------------
create or replace function public.office_reorder_list(p_branch uuid) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.supplier nulls last, x.name)) from (
    select p.id product_id, app.product_label(p.brand_name, p.strength) name, coalesce(ps.qty_base, 0)::bigint stock, p.reorder_level,
           (select code from units where id = p.base_unit_id) base_unit,
           ls.supplier_id, ls.supplier, ls.supplier_whatsapp
    from products p
    left join product_stock ps on ps.product_id = p.id and ps.branch_id = p_branch
    left join lateral (select s.id supplier_id, s.name supplier, nullif(coalesce(s.whatsapp, s.phone), '') supplier_whatsapp
                       from grn_lines gl join grns g on g.id = gl.grn_id join suppliers s on s.id = g.supplier_id
                       where gl.product_id = p.id order by g.received_at desc limit 1) ls on true
    where p.archived_at is null
      and ((p.reorder_level is not null and coalesce(ps.qty_base, 0) <= p.reorder_level)
           or (coalesce(ps.qty_base, 0) <= 0 and exists (
                 select 1 from sale_lines sl join sales s on s.id = sl.sale_id
                 where sl.product_id = p.id and s.status = 'completed' and s.business_date >= current_date - 60)))
    limit 500) x
$$;

-- ---- Grants -------------------------------------------------------------------------------
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('office_whatsapp_settings', 'office_udhaar_reminders', 'office_customer_contact',
             'log_whatsapp', 'office_whatsapp_log', 'office_regular_medicines', 'save_regular_medicine', 'archive_regular_medicine',
             'office_refills_due', 'office_reorder_list')
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
