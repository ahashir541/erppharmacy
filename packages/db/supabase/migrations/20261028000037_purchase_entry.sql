-- 0037: client feedback (1.0.3).
--   * Expiry (and batch number) are optional everywhere; nothing is refused for a missing or past expiry.
--   * Each supplier can carry its usual discount (e.g. 13%); deliveries apply it to every line.
--   * Purchase search finds products by name, generic or barcode and returns the last cost, price and batch.

alter table batches alter column expiry_date drop not null;
-- One batch without an expiry per product and batch number (the table's unique key treats empty expiries as different).
create unique index if not exists batches_no_expiry_unique on batches (tenant_id, product_id, batch_number) where expiry_date is null;

alter table suppliers add column if not exists discount_pct numeric(5,2) not null default 0 check (discount_pct between 0 and 100);

create or replace function app.get_or_create_batch(p_tenant uuid, p_product uuid, p_batch_number text,
                                                   p_expiry date, p_user uuid,
                                                   p_price_unit uuid default null, p_retail bigint default null,
                                                   p_mrp bigint default null, p_supplier uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  bid uuid;
begin
  -- Batch and expiry are optional: a blank batch is kept as '-', a blank expiry stays empty.
  if p_batch_number is null or trim(p_batch_number) = '' then p_batch_number := '-'; end if;
  select id into bid from batches
  where tenant_id = p_tenant and product_id = p_product and batch_number = upper(trim(p_batch_number))
    and expiry_date is not distinct from p_expiry;
  if bid is null then
    insert into batches (tenant_id, product_id, batch_number, expiry_date, price_unit_id, retail_price, mrp,
                         first_supplier_id, created_by, device_id)
    values (p_tenant, p_product, upper(trim(p_batch_number)), p_expiry, p_price_unit, p_retail, p_mrp,
            p_supplier, p_user, app.ctx_device_id())
    returning id into bid;
  end if;
  return bid;
end $$;

create or replace function public.post_grn(p jsonb, p_session uuid default null) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  br uuid := coalesce((p ->> 'branch_id')::uuid, app.device_branch_id());
  gid uuid := coalesce((p ->> 'id')::uuid, app.uuid_v7());
  sup suppliers;
  po purchase_orders;
  l jsonb;
  pu product_units;
  pol po_lines;
  bid uuid;
  lid uuid;
  exp date;
  num text;
  received timestamptz := coalesce((p ->> 'received_at')::timestamptz, now());
  min_days int;
  warnings jsonb := '[]';
  has_cost boolean;
  can_cost boolean;
  inv jsonb;
begin
  perform app.assert_branch(br);
  perform app.require_decision(uid, 'purchases.receive', br, null, null, 'other');
  if exists (select 1 from grns where id = gid) then
    return jsonb_build_object('grn_id', gid, 'grn_number', (select grn_number from grns where id = gid), 'duplicate', true);
  end if;
  select * into sup from suppliers where id = (p ->> 'supplier_id')::uuid and tenant_id = tid and archived_at is null;
  if not found then raise exception 'Supplier not found' using errcode = 'P0002'; end if;
  if (p ->> 'purchase_order_id') is not null then
    select * into po from purchase_orders where id = (p ->> 'purchase_order_id')::uuid and tenant_id = tid for update;
    if not found or po.supplier_id <> sup.id or po.branch_id <> br then
      raise exception 'That order is not from this supplier for this branch' using errcode = 'P0002';
    end if;
    if po.status in ('received', 'cancelled') then raise exception 'That order is already %', po.status using errcode = 'P0001'; end if;
  end if;
  if jsonb_array_length(coalesce(p -> 'lines', '[]')) = 0 then raise exception 'Add at least one item' using errcode = '22023'; end if;
  can_cost := app.permission_decision(uid, 'purchases.view_cost', br) = 'allow';
  min_days := coalesce((app.setting(tid, br, 'purchases.min_expiry_days') #>> '{}')::int, 90);

  num := app.next_doc_number(tid, 'grn', 'GRN');
  insert into grns (id, tenant_id, branch_id, supplier_id, purchase_order_id, grn_number, supplier_invoice_number, received_at,
                    status, posted_at, notes, created_by, device_id)
  values (gid, tid, br, sup.id, po.id, num, nullif(trim(p ->> 'supplier_invoice_number'), ''), received, 'posted', now(),
          p ->> 'notes', uid, app.ctx_device_id());

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    select * into pu from product_units where id = (l ->> 'product_unit_id')::uuid and tenant_id = tid and archived_at is null;
    if not found then raise exception 'Item not found' using errcode = 'P0002'; end if;
    if coalesce((l ->> 'qty')::bigint, 0) < 0 or coalesce((l ->> 'bonus_qty')::bigint, 0) < 0
       or coalesce((l ->> 'qty')::bigint, 0) + coalesce((l ->> 'bonus_qty')::bigint, 0) = 0 then
      raise exception 'Enter how many arrived' using errcode = '22023';
    end if;
    exp := app.try_date(l ->> 'expiry_date');
    -- Expiry is optional. An expired or short-dated batch is received with a warning, never refused.
    if exp is not null and exp <= app.business_date(br, received) then
      warnings := warnings || jsonb_build_object('kind', 'expired', 'batch_number', upper(trim(coalesce(l ->> 'batch_number', '-'))), 'expiry_date', exp);
    elsif exp is not null and exp < app.business_date(br, received) + min_days then
      warnings := warnings || jsonb_build_object('kind', 'short_dated', 'batch_number', upper(trim(l ->> 'batch_number')),
                                                 'expiry_date', exp, 'days_left', exp - app.business_date(br, received));
    end if;
    if (l ->> 'po_line_id') is not null then
      select * into pol from po_lines where id = (l ->> 'po_line_id')::uuid and purchase_order_id = po.id;
      if not found or pol.product_id <> pu.product_id then
        raise exception 'That order line is for another item' using errcode = 'P0001';
      end if;
    end if;
    has_cost := (l ->> 'unit_cost') is not null;
    if has_cost and not can_cost then
      raise exception 'Permission purchases.view_cost is required to enter costs' using errcode = '42501';
    end if;
    bid := app.get_or_create_batch(tid, pu.product_id, l ->> 'batch_number', exp, uid, pu.id,
                                   app.try_bigint(l ->> 'retail_price'), app.try_bigint(l ->> 'mrp'), sup.id);
    lid := coalesce((l ->> 'id')::uuid, app.uuid_v7());
    insert into grn_lines (id, tenant_id, grn_id, po_line_id, product_id, product_unit_id, batch_id, qty, bonus_qty,
                           qty_base, bonus_qty_base, created_by, device_id)
    values (lid, tid, gid, (l ->> 'po_line_id')::uuid, pu.product_id, pu.id, bid, coalesce((l ->> 'qty')::bigint, 0),
            coalesce((l ->> 'bonus_qty')::bigint, 0), coalesce((l ->> 'qty')::bigint, 0) * pu.factor_to_base,
            coalesce((l ->> 'bonus_qty')::bigint, 0) * pu.factor_to_base, uid, app.ctx_device_id());
    insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type,
                                 reference_id, reference_line_id, occurred_at, created_by, device_id)
    values (tid, br, pu.product_id, bid, 'purchase',
            (coalesce((l ->> 'qty')::bigint, 0) + coalesce((l ->> 'bonus_qty')::bigint, 0)) * pu.factor_to_base,
            'grn', gid, lid, received, uid, app.ctx_device_id());
    if has_cost then
      perform app.set_grn_line_cost(lid, l, uid);
    end if;
  end loop;

  if po.id is not null then perform app.refresh_po_status(po.id); end if;
  perform app.log_event('grn_posted', 'grns', gid, jsonb_build_object('grn_number', num, 'supplier', sup.name), br);

  if p ? 'invoice' then
    inv := public.post_purchase_invoice((p -> 'invoice') || jsonb_build_object('grn_id', gid), p_session);
  end if;
  return jsonb_build_object('grn_id', gid, 'grn_number', num, 'warnings', warnings, 'invoice', inv, 'duplicate', false);
end $$;

create or replace function public.save_supplier(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('suppliers.manage');
  tid uuid := app.tenant_id();
  sid uuid := (p ->> 'id')::uuid;
begin
  if sid is null or not exists (select 1 from suppliers where id = sid and tenant_id = tid) then
    if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'Supplier name is required' using errcode = '22023'; end if;
    if exists (select 1 from suppliers where tenant_id = tid and lower(name) = lower(trim(p ->> 'name'))) then
      raise exception 'A supplier with this name already exists' using errcode = '23505';
    end if;
    insert into suppliers (id, tenant_id, name, contact_name, phone, whatsapp, email, address, city, ntn, strn,
                           payment_terms_days, credit_limit, lead_time_days, created_by)
    values (coalesce(sid, app.uuid_v7()), tid, trim(p ->> 'name'), p ->> 'contact_name', p ->> 'phone', p ->> 'whatsapp',
            p ->> 'email', p ->> 'address', p ->> 'city', p ->> 'ntn', p ->> 'strn', (p ->> 'payment_terms_days')::int,
            (p ->> 'credit_limit')::bigint, (p ->> 'lead_time_days')::int, uid)
    returning id into sid;
  else
    update suppliers set
      name = coalesce(nullif(trim(p ->> 'name'), ''), name),
      contact_name = case when p ? 'contact_name' then p ->> 'contact_name' else contact_name end,
      phone = case when p ? 'phone' then p ->> 'phone' else phone end,
      whatsapp = case when p ? 'whatsapp' then p ->> 'whatsapp' else whatsapp end,
      email = case when p ? 'email' then p ->> 'email' else email end,
      address = case when p ? 'address' then p ->> 'address' else address end,
      city = case when p ? 'city' then p ->> 'city' else city end,
      ntn = case when p ? 'ntn' then p ->> 'ntn' else ntn end,
      strn = case when p ? 'strn' then p ->> 'strn' else strn end,
      payment_terms_days = case when p ? 'payment_terms_days' then (p ->> 'payment_terms_days')::int else payment_terms_days end,
      credit_limit = case when p ? 'credit_limit' then (p ->> 'credit_limit')::bigint else credit_limit end,
      lead_time_days = case when p ? 'lead_time_days' then (p ->> 'lead_time_days')::int else lead_time_days end,
      is_active = coalesce((p ->> 'is_active')::boolean, is_active)
    where id = sid;
  end if;
  if p ? 'discount_pct' then
    if coalesce((p ->> 'discount_pct')::numeric, 0) not between 0 and 100 then
      raise exception 'Discount must be between 0 and 100%%' using errcode = '22023';
    end if;
    update suppliers set discount_pct = coalesce((p ->> 'discount_pct')::numeric, 0) where id = sid;
  end if;
  return sid;
end $$;

create or replace function public.office_suppliers() returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.balance desc, x.name)) from (
    select s.id, s.name, s.phone, coalesce(s.whatsapp, s.phone) whatsapp, s.payment_terms_days, s.discount_pct, coalesce(pb.balance, 0)::bigint balance
    from suppliers s left join party_balances pb on pb.party_type = 'supplier' and pb.party_id = s.id
    where s.archived_at is null) x
$$;

-- Search for the delivery screen: name, generic name or barcode; with what was paid and charged last time.
create or replace function public.office_product_search(p_q text) returns jsonb
language sql stable security invoker set search_path = public, app as $$
  select app.rows(jsonb_agg(to_jsonb(x) order by x.rank, x.brand_name)) from (
    select p.id, p.brand_name,
           case when lower(p.brand_name) like lower(p_q) || '%' then 0 else 1 end rank,
           (select json_agg(json_build_object('id', pu.id, 'name', u.name, 'factor', pu.factor_to_base) order by pu.factor_to_base desc)
              from product_units pu join units u on u.id = pu.unit_id where pu.product_id = p.id and pu.archived_at is null) units,
           last.product_unit_id last_unit_id, last.unit_cost last_cost, last.batch_number last_batch, last.expiry_date last_expiry,
           last.retail_price last_retail
    from products p
    left join lateral (
      select gl.product_unit_id, glc.unit_cost, b.batch_number, b.expiry_date, b.retail_price
      from grn_lines gl join batches b on b.id = gl.batch_id left join grn_line_costs glc on glc.grn_line_id = gl.id
      where gl.product_id = p.id order by gl.created_at desc limit 1) last on true
    where p.archived_at is null
      and (p.brand_name ilike '%' || p_q || '%'
           or exists (select 1 from generics g where g.id = p.generic_id and g.name ilike '%' || p_q || '%')
           or exists (select 1 from barcodes bc where bc.product_id = p.id and bc.code = trim(p_q) and bc.archived_at is null))
    order by 3, p.brand_name limit 12) x
$$;

-- The pharmacy's letterhead for udhaar reminder letters: address and phone of the first branch.
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
    'template_refill', (select value #>> '{}' from settings where key = 'whatsapp.template.refill' and branch_id is null limit 1),
    'address', (select nullif(address, '') from branches where tenant_id = app.tenant_id() order by created_at limit 1),
    'phone', (select phone from branches where tenant_id = app.tenant_id() order by created_at limit 1))
$$;
