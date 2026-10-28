-- 0015 (Phase 2): catalogue and stock — product import (10,000 rows per
-- call), product edits and prices, opening stock, adjustments, disposal,
-- batch blocks, stock counts, expiry dashboard, balance verification.
--
-- Staff work only on pharmacy PCs (D11), so stock actions come either from
-- an owner session or from a PC on behalf of a signed-in staff member
-- (p_session = their open user_sessions row). app.rpc_actor() resolves who
-- is acting; app.require_decision() applies that person's permissions.

-- ---- Small helpers ------------------------------------------------------
create or replace function app.try_bigint(t text) returns bigint
language plpgsql immutable as $$
begin
  return nullif(trim(t), '')::bigint;
exception when others then
  return null;
end $$;

create or replace function app.try_bool(t text) returns boolean
language sql immutable as $$
  select case
    when t is null or trim(t) = '' then null
    when lower(trim(t)) in ('true', 't', 'yes', 'y', '1', 'haan', 'ہاں') then true
    when lower(trim(t)) in ('false', 'f', 'no', 'n', '0', 'nahi', 'نہیں') then false
  end
$$;

create or replace function app.try_date(t text) returns date
language plpgsql immutable as $$
begin
  return nullif(trim(t), '')::date;
exception when others then
  return null;
end $$;

-- Approvals can be used once.
alter table approval_requests add column used_at timestamptz;
alter table approval_requests add column used_for uuid;

-- Counter PCs need these to work (they hold no money data).
update permissions set counter_safe = true
where code in ('stock.count', 'suppliers.view', 'prescriptions.view', 'purchases.receive');

alter table categories add constraint categories_tenant_name unique (tenant_id, name);
alter table stock_count_lines add constraint stock_count_lines_one_per_batch unique (stock_count_id, batch_id);

-- Import matching: same brand + strength + manufacturer = same product.
alter table products add column match_key text generated always as (
  lower(brand_name) || '|' || lower(coalesce(strength, '')) || '|' || coalesce(manufacturer_id::text, '')
) stored;
create index products_match_key on products (tenant_id, match_key) where archived_at is null;

-- ---- Who is acting -------------------------------------------------------
-- Owner session: the owner. Pharmacy PC: the staff member of the open
-- session on this PC. Sets the audit context either way.
create or replace function app.rpc_actor(p_session uuid) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.current_user_id();
  did uuid;
  s user_sessions;
begin
  if uid is null then
    did := app.current_device_id();
    if did is null then
      raise exception 'Sign-in required' using errcode = '42501';
    end if;
    if p_session is null then
      raise exception 'A staff member must be signed in on this PC' using errcode = '42501';
    end if;
    select * into s from user_sessions where id = p_session and device_id = did and ended_at is null;
    if not found then
      raise exception 'The staff session has ended; sign in again' using errcode = '42501';
    end if;
    if not exists (select 1 from users where id = s.user_id and status = 'active' and archived_at is null) then
      raise exception 'This staff member is disabled' using errcode = '42501';
    end if;
    uid := s.user_id;
    perform set_config('app.device_id', did::text, true);
  end if;
  perform set_config('app.user_id', uid::text, true);
  perform app.assert_tenant_writable(app.tenant_id());
  return uid;
end $$;

-- A PC may act only on its own branch; an owner on any branch of theirs.
create or replace function app.assert_branch(p_branch uuid) returns void
language plpgsql stable security definer set search_path = public, app as $$
begin
  if not exists (select 1 from branches where id = p_branch and tenant_id = app.tenant_id() and archived_at is null)
     or (app.current_user_id() is null and p_branch is distinct from app.device_branch_id()) then
    raise exception 'Branch not found' using errcode = 'P0002';
  end if;
end $$;

-- Apply one person's decision for an action. 'needs_approval' passes only
-- with an approved, unexpired, unused approval of the right kind, which is
-- then marked used.
create or replace function app.require_decision(p_user uuid, p_code text, p_branch uuid, p_amount bigint,
                                                p_approval uuid, p_kind text, p_reference uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  d text := app.permission_decision(p_user, p_code, p_branch, p_amount);
begin
  if d = 'allow' then return; end if;
  if d = 'deny' or d is null then
    raise exception 'Permission % is required', p_code using errcode = '42501';
  end if;
  if p_approval is null then
    raise exception 'Owner approval is needed for this' using errcode = 'P0001', hint = 'approval_required';
  end if;
  update approval_requests
  set used_at = now(), used_for = p_reference
  where id = p_approval and tenant_id = app.tenant_id() and status = 'approved'
    and kind = p_kind and permission_code = p_code and used_at is null
    and (expires_at is null or expires_at > now())
    and (amount is null or p_amount is null or amount >= p_amount);
  if not found then
    raise exception 'The approval is not valid for this action' using errcode = 'P0001', hint = 'approval_invalid';
  end if;
end $$;

-- ---- Product import ------------------------------------------------------
-- p_rows: JSON array of up to 10,000 objects (packages/core/src/catalogue
-- builds them from a CSV/Excel file and the column mapping screen):
--   brand_name (required), brand_name_ur, generic, strength, dosage_form,
--   manufacturer, category, barcode, base_unit (default 'tablet'),
--   units [{"unit":"strip","factor":10},{"unit":"box","factor":100}],
--   retail_price (minor units) + retail_unit, rack, reorder_level, min_stock,
--   max_stock (base units), is_controlled, rx_required, tax_category (code)
-- Existing products are matched by barcode, then by brand + strength +
-- manufacturer, and updated (blank cells never erase data). Re-importing
-- the same file changes nothing. Returns counts and per-row problems.
create or replace function public.import_products(p_rows jsonb, p_session uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  n_created int;
  n_updated int;
  n_prices int;
  n_errors int;
  errs jsonb;
begin
  perform app.require_decision(uid, 'product.import', coalesce(app.device_branch_id(),
    (select id from branches where tenant_id = tid order by created_at limit 1)), null, null, 'other');
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Expected a JSON array of rows' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 10000 then
    raise exception 'At most 10,000 rows per call; split the file' using errcode = '22023';
  end if;

  drop table if exists _imp;
  create temp table _imp on commit drop as
  select r.ord::int                                           as row_no,
         nullif(trim(r.v ->> 'brand_name'), '')               as brand_name,
         nullif(trim(r.v ->> 'brand_name_ur'), '')            as brand_name_ur,
         nullif(trim(r.v ->> 'generic'), '')                  as generic,
         nullif(trim(r.v ->> 'strength'), '')                 as strength,
         nullif(trim(r.v ->> 'dosage_form'), '')              as dosage_form,
         nullif(trim(r.v ->> 'manufacturer'), '')             as manufacturer,
         nullif(trim(r.v ->> 'category'), '')                 as category,
         nullif(trim(r.v ->> 'barcode'), '')                  as barcode,
         coalesce(nullif(lower(trim(r.v ->> 'base_unit')), ''), 'tablet') as base_unit,
         case when jsonb_typeof(r.v -> 'units') = 'array' then r.v -> 'units' else '[]'::jsonb end as units,
         r.v ->> 'retail_price'                               as retail_price_raw,
         app.try_bigint(r.v ->> 'retail_price')               as retail_price,
         nullif(lower(trim(r.v ->> 'retail_unit')), '')       as retail_unit,
         nullif(trim(r.v ->> 'rack'), '')                     as rack,
         app.try_bigint(r.v ->> 'reorder_level')              as reorder_level,
         app.try_bigint(r.v ->> 'min_stock')                  as min_stock,
         app.try_bigint(r.v ->> 'max_stock')                  as max_stock,
         app.try_bool(r.v ->> 'is_controlled')                as is_controlled,
         app.try_bool(r.v ->> 'rx_required')                  as rx_required,
         nullif(trim(r.v ->> 'tax_category'), '')             as tax_category,
         null::text  as error,
         null::uuid  as generic_id,
         null::uuid  as manufacturer_id,
         null::uuid  as category_id,
         null::uuid  as base_unit_id,
         null::uuid  as tax_category_id,
         null::text  as match_key,
         null::uuid  as product_id,
         false       as is_new,
         false       as skipped
  from jsonb_array_elements(p_rows) with ordinality as r(v, ord);

  -- 1. row-level checks
  update _imp set error = 'brand_name is required' where brand_name is null;
  update _imp set error = 'retail_price must be a whole number of paisa'
  where error is null and retail_price_raw is not null and trim(retail_price_raw) <> '' and retail_price is null;
  update _imp set error = 'retail_price cannot be negative' where error is null and retail_price < 0;
  update _imp set error = 'reorder / min / max stock cannot be negative'
  where error is null and (reorder_level < 0 or min_stock < 0 or max_stock < 0);
  update _imp i set error = 'each unit needs a name and a whole factor above 1'
  where error is null and exists (
    select 1 from jsonb_array_elements(i.units) u
    where nullif(trim(u ->> 'unit'), '') is null
       or app.try_bigint(u ->> 'factor') is null or app.try_bigint(u ->> 'factor') <= 1
       or lower(trim(u ->> 'unit')) = i.base_unit);
  update _imp i set error = 'retail_unit must be the base unit or one of the units'
  where error is null and retail_unit is not null and retail_unit <> base_unit
    and not exists (select 1 from jsonb_array_elements(i.units) u where lower(trim(u ->> 'unit')) = i.retail_unit)
    and not exists (select 1 from units u where u.tenant_id = tid and u.code = i.retail_unit);
  update _imp i set error = 'unknown tax_category ' || i.tax_category
  where error is null and tax_category is not null
    and not exists (select 1 from tax_categories t where t.tenant_id = tid and t.code = i.tax_category);

  -- 2. dictionaries: create what is missing, then resolve ids
  insert into units (tenant_id, code, name, created_by)
  select distinct tid, code, initcap(code), uid
  from (select base_unit as code from _imp where error is null
        union
        select lower(trim(u ->> 'unit')) from _imp, jsonb_array_elements(units) u where error is null) x
  on conflict (tenant_id, code) do nothing;
  insert into generics (tenant_id, name, created_by)
  select distinct tid, generic, uid from _imp where error is null and generic is not null
  on conflict (tenant_id, name) do nothing;
  insert into manufacturers (tenant_id, name, created_by)
  select distinct tid, manufacturer, uid from _imp where error is null and manufacturer is not null
  on conflict (tenant_id, name) do nothing;
  insert into categories (tenant_id, name, created_by)
  select distinct tid, category, uid from _imp where error is null and category is not null
  on conflict (tenant_id, name) do nothing;

  update _imp i set
    generic_id = (select id from generics g where g.tenant_id = tid and g.name = i.generic),
    manufacturer_id = (select id from manufacturers m where m.tenant_id = tid and m.name = i.manufacturer),
    category_id = (select id from categories c where c.tenant_id = tid and c.name = i.category),
    base_unit_id = (select id from units u where u.tenant_id = tid and u.code = i.base_unit),
    tax_category_id = (select id from tax_categories t where t.tenant_id = tid and t.code = i.tax_category)
  where error is null;
  update _imp set match_key = lower(brand_name) || '|' || lower(coalesce(strength, '')) || '|'
                              || coalesce(manufacturer_id::text, '')
  where error is null;

  -- 3. match existing products: barcode first, then brand + strength + manufacturer
  update _imp i set product_id = b.product_id
  from barcodes b join products p on p.id = b.product_id and p.archived_at is null
  where i.error is null and i.barcode is not null
    and b.tenant_id = tid and b.code = i.barcode and b.archived_at is null;
  update _imp i set product_id = p.id
  from products p
  where i.error is null and i.product_id is null
    and p.tenant_id = tid and p.archived_at is null and p.match_key = i.match_key;
  update _imp i set error = 'base unit differs from the existing product (' || u.code || ')'
  from products p join units u on u.id = p.base_unit_id
  where i.error is null and i.product_id = p.id and p.base_unit_id <> i.base_unit_id;

  -- 4. a product listed twice in the file: the last row wins
  update _imp i set skipped = true
  where i.error is null and exists (
    select 1 from _imp j
    where j.error is null and j.row_no > i.row_no
      and coalesce(j.product_id::text, j.match_key) = coalesce(i.product_id::text, i.match_key));
  -- the same barcode on two different products
  update _imp i set error = 'barcode ' || i.barcode || ' is already used by another product'
  where i.error is null and not i.skipped and i.barcode is not null and exists (
    select 1 from barcodes b
    where b.tenant_id = tid and b.code = i.barcode and b.archived_at is null
      and b.product_id is distinct from i.product_id);
  update _imp i set error = 'barcode ' || i.barcode || ' appears on two different products in this file'
  where i.error is null and not i.skipped and i.barcode is not null and exists (
    select 1 from _imp j
    where j.error is null and not j.skipped and j.row_no <> i.row_no and j.barcode = i.barcode
      and coalesce(j.product_id::text, j.match_key) <> coalesce(i.product_id::text, i.match_key));

  update _imp set product_id = app.uuid_v7(), is_new = true
  where error is null and not skipped and product_id is null;

  -- 5. write
  insert into products (id, tenant_id, brand_name, brand_name_ur, generic_id, strength, dosage_form,
                        manufacturer_id, category_id, tax_category_id, base_unit_id, is_controlled,
                        rx_required, rack_location, min_stock, max_stock, reorder_level, created_by)
  select product_id, tid, brand_name, brand_name_ur, generic_id, strength, dosage_form,
         manufacturer_id, category_id, tax_category_id, base_unit_id, coalesce(is_controlled, false),
         coalesce(rx_required, false), rack, min_stock, max_stock, reorder_level, uid
  from _imp where is_new;
  get diagnostics n_created = row_count;

  update products p set
    brand_name_ur   = coalesce(i.brand_name_ur, p.brand_name_ur),
    generic_id      = coalesce(i.generic_id, p.generic_id),
    dosage_form     = coalesce(i.dosage_form, p.dosage_form),
    category_id     = coalesce(i.category_id, p.category_id),
    tax_category_id = coalesce(i.tax_category_id, p.tax_category_id),
    is_controlled   = coalesce(i.is_controlled, p.is_controlled),
    rx_required     = coalesce(i.rx_required, p.rx_required),
    rack_location   = coalesce(i.rack, p.rack_location),
    min_stock       = coalesce(i.min_stock, p.min_stock),
    max_stock       = coalesce(i.max_stock, p.max_stock),
    reorder_level   = coalesce(i.reorder_level, p.reorder_level)
  from _imp i
  where i.product_id = p.id and i.error is null and not i.skipped and not i.is_new
    -- only rows where a provided value differs from what is stored
    and (coalesce(i.brand_name_ur, p.brand_name_ur), coalesce(i.generic_id, p.generic_id),
         coalesce(i.dosage_form, p.dosage_form), coalesce(i.category_id, p.category_id),
         coalesce(i.tax_category_id, p.tax_category_id), coalesce(i.is_controlled, p.is_controlled),
         coalesce(i.rx_required, p.rx_required), coalesce(i.rack, p.rack_location),
         coalesce(i.min_stock, p.min_stock), coalesce(i.max_stock, p.max_stock),
         coalesce(i.reorder_level, p.reorder_level))
        is distinct from
        (p.brand_name_ur, p.generic_id, p.dosage_form, p.category_id, p.tax_category_id, p.is_controlled,
         p.rx_required, p.rack_location, p.min_stock, p.max_stock, p.reorder_level);
  get diagnostics n_updated = row_count;

  -- pack ladder: base unit (factor 1) + listed units; existing factors are kept
  insert into product_units (tenant_id, product_id, unit_id, factor_to_base, sort_order, created_by)
  select tid, i.product_id, i.base_unit_id, 1, 0, uid from _imp i where i.is_new
  on conflict (product_id, unit_id) do nothing;
  insert into product_units (tenant_id, product_id, unit_id, factor_to_base, sort_order, created_by)
  select tid, i.product_id, u.id, app.try_bigint(x ->> 'factor'), app.try_bigint(x ->> 'factor')::int, uid
  from _imp i
  cross join jsonb_array_elements(i.units) x
  join units u on u.tenant_id = tid and u.code = lower(trim(x ->> 'unit'))
  where i.error is null and not i.skipped
  on conflict (product_id, unit_id) do nothing;

  insert into barcodes (tenant_id, product_id, code, created_by)
  select tid, i.product_id, i.barcode, uid from _imp i
  where i.error is null and not i.skipped and i.barcode is not null
    and not exists (select 1 from barcodes b where b.tenant_id = tid and b.code = i.barcode and b.archived_at is null);

  -- retail price: only when new or changed
  insert into product_prices (tenant_id, product_id, product_unit_id, price_kind, amount, reason, created_by)
  select tid, i.product_id, pu.id, 'retail', i.retail_price, 'import', uid
  from _imp i
  join units u on u.tenant_id = tid and u.code = coalesce(i.retail_unit, i.base_unit)
  join product_units pu on pu.product_id = i.product_id and pu.unit_id = u.id
  where i.error is null and not i.skipped and i.retail_price is not null
    and i.retail_price is distinct from (
      select pp.amount from product_prices pp
      where pp.product_unit_id = pu.id and pp.price_kind = 'retail' and pp.branch_id is null
        and pp.effective_from <= now()
      order by pp.effective_from desc, pp.created_at desc limit 1);
  get diagnostics n_prices = row_count;

  select count(*), coalesce(jsonb_agg(jsonb_build_object('row', row_no, 'error', error) order by row_no)
                            filter (where row_no <= 100000), '[]'::jsonb)
  into n_errors, errs
  from (select row_no, error from _imp where error is not null order by row_no limit 500) e;
  n_errors := (select count(*) from _imp where error is not null);

  perform app.log_event('product.import', 'products', null,
    jsonb_build_object('rows', jsonb_array_length(p_rows), 'created', n_created, 'updated', n_updated,
                       'errors', n_errors));
  return jsonb_build_object(
    'rows', jsonb_array_length(p_rows),
    'created', n_created,
    'updated', n_updated,
    'unchanged', (select count(*) from _imp where error is null and not skipped and not is_new) - n_updated,
    'duplicates_skipped', (select count(*) from _imp where skipped),
    'prices_set', n_prices,
    'error_count', n_errors,
    'errors', errs);
end $$;

-- ---- Product edits and prices --------------------------------------------
create or replace function public.update_product(p_product uuid, p_changes jsonb, p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  allowed text[] := array['brand_name', 'brand_name_ur', 'strength', 'dosage_form', 'drug_schedule', 'rack_location',
                          'is_controlled', 'rx_required', 'max_qty_per_sale', 'min_stock', 'max_stock',
                          'reorder_level', 'lead_time_days', 'is_active'];
  bad text;
begin
  perform app.require_decision(uid, 'product.manage', coalesce(app.device_branch_id(),
    (select id from branches where tenant_id = tid order by created_at limit 1)), null, null, 'other');
  select k into bad from jsonb_object_keys(p_changes) k where k <> all (allowed) limit 1;
  if bad is not null then
    raise exception 'Field % cannot be changed here', bad using errcode = '22023';
  end if;
  update products p set
    brand_name       = coalesce(p_changes ->> 'brand_name', p.brand_name),
    brand_name_ur    = case when p_changes ? 'brand_name_ur' then p_changes ->> 'brand_name_ur' else p.brand_name_ur end,
    strength         = case when p_changes ? 'strength' then p_changes ->> 'strength' else p.strength end,
    dosage_form      = case when p_changes ? 'dosage_form' then p_changes ->> 'dosage_form' else p.dosage_form end,
    drug_schedule    = case when p_changes ? 'drug_schedule' then p_changes ->> 'drug_schedule' else p.drug_schedule end,
    rack_location    = case when p_changes ? 'rack_location' then p_changes ->> 'rack_location' else p.rack_location end,
    is_controlled    = coalesce((p_changes ->> 'is_controlled')::boolean, p.is_controlled),
    rx_required      = coalesce((p_changes ->> 'rx_required')::boolean, p.rx_required),
    max_qty_per_sale = case when p_changes ? 'max_qty_per_sale' then (p_changes ->> 'max_qty_per_sale')::bigint else p.max_qty_per_sale end,
    min_stock        = case when p_changes ? 'min_stock' then (p_changes ->> 'min_stock')::bigint else p.min_stock end,
    max_stock        = case when p_changes ? 'max_stock' then (p_changes ->> 'max_stock')::bigint else p.max_stock end,
    reorder_level    = case when p_changes ? 'reorder_level' then (p_changes ->> 'reorder_level')::bigint else p.reorder_level end,
    lead_time_days   = case when p_changes ? 'lead_time_days' then (p_changes ->> 'lead_time_days')::int else p.lead_time_days end,
    is_active        = coalesce((p_changes ->> 'is_active')::boolean, p.is_active)
  where p.id = p_product and p.tenant_id = tid and p.archived_at is null;
  if not found then raise exception 'Product not found' using errcode = 'P0002'; end if;
end $$;

create or replace function public.archive_product(p_product uuid, p_reason text, p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
begin
  perform app.require_decision(uid, 'product.manage', coalesce(app.device_branch_id(),
    (select id from branches where tenant_id = tid order by created_at limit 1)), null, null, 'other');
  if exists (select 1 from stock_balances where product_id = p_product and qty_base <> 0) then
    raise exception 'This product still has stock; sell, return or dispose of it first' using errcode = 'P0001';
  end if;
  update products set archived_at = now(), is_active = false
  where id = p_product and tenant_id = tid and archived_at is null;
  if not found then raise exception 'Product not found' using errcode = 'P0002'; end if;
  update barcodes set archived_at = now() where product_id = p_product and archived_at is null;
  perform app.log_event('product.archived', 'products', p_product, jsonb_build_object('reason', p_reason));
end $$;

-- Pack ladder change: adds a unit size (existing factors never change, so
-- quantities already counted stay correct).
create or replace function public.add_product_unit(p_product uuid, p_unit_code text, p_factor bigint,
                                                   p_barcode text default null, p_session uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  unit_id uuid;
  pu uuid;
begin
  perform app.require_decision(uid, 'product.manage', coalesce(app.device_branch_id(),
    (select id from branches where tenant_id = tid order by created_at limit 1)), null, null, 'other');
  if not exists (select 1 from products where id = p_product and tenant_id = tid and archived_at is null) then
    raise exception 'Product not found' using errcode = 'P0002';
  end if;
  if p_factor is null or p_factor <= 1 then
    raise exception 'A pack must contain more than one base unit' using errcode = '22023';
  end if;
  insert into units (tenant_id, code, name, created_by)
  values (tid, lower(trim(p_unit_code)), initcap(trim(p_unit_code)), uid)
  on conflict (tenant_id, code) do nothing;
  select id into unit_id from units where tenant_id = tid and code = lower(trim(p_unit_code));
  insert into product_units (tenant_id, product_id, unit_id, factor_to_base, sort_order, created_by)
  values (tid, p_product, unit_id, p_factor, p_factor::int, uid)
  returning id into pu;
  if p_barcode is not null then
    insert into barcodes (tenant_id, product_id, product_unit_id, code, created_by)
    values (tid, p_product, pu, p_barcode, uid);
  end if;
  return pu;
end $$;

-- One price. Trade price is cost-like: it needs product.view_cost too.
create or replace function public.set_price(p_product_unit uuid, p_kind text, p_amount bigint,
                                            p_reason text default '', p_branch uuid default null,
                                            p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  pu product_units;
  ref_branch uuid := coalesce(p_branch, app.device_branch_id(),
                              (select id from branches where tenant_id = tid order by created_at limit 1));
begin
  perform app.require_decision(uid, 'product.price_change', ref_branch, null, null, 'price_change');
  if p_kind = 'trade' then
    perform app.require_decision(uid, 'product.view_cost', ref_branch, null, null, 'other');
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'Price must be zero or more' using errcode = '22023';
  end if;
  select * into pu from product_units where id = p_product_unit and tenant_id = tid and archived_at is null;
  if not found then raise exception 'Product unit not found' using errcode = 'P0002'; end if;
  if p_branch is not null then perform app.assert_branch(p_branch); end if;
  insert into product_prices (tenant_id, product_id, product_unit_id, branch_id, price_kind, amount, reason, created_by,
                              device_id)
  values (tid, pu.product_id, pu.id, p_branch, p_kind, p_amount, coalesce(p_reason, ''), uid, app.ctx_device_id());
end $$;

-- Bulk retail price change by manufacturer or category, e.g. +5% (500 bp).
-- New price = old price x (10000 + bp) / 10000, rounded half-up to the paisa.
create or replace function public.bulk_price_change(p_percent_bp int, p_reason text,
                                                    p_manufacturer uuid default null,
                                                    p_category uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('product.bulk_price');
  tid uuid := app.tenant_id();
  change_id uuid := app.uuid_v7();
  n int;
begin
  if (p_manufacturer is null) = (p_category is null) then
    raise exception 'Choose exactly one manufacturer or one category' using errcode = '22023';
  end if;
  if p_percent_bp is null or p_percent_bp <= -10000 or p_percent_bp > 100000 then
    raise exception 'Percentage out of range' using errcode = '22023';
  end if;
  insert into product_prices (tenant_id, product_id, product_unit_id, price_kind, amount, reason,
                              bulk_change_id, created_by)
  select tid, cur.product_id, cur.product_unit_id, 'retail',
         ((cur.amount * (10000 + p_percent_bp) * 2 + 10000) / 20000),
         coalesce(p_reason, ''), change_id, uid
  from (
    select distinct on (pp.product_unit_id) pp.product_id, pp.product_unit_id, pp.amount
    from product_prices pp
    join products p on p.id = pp.product_id
    where pp.tenant_id = tid and pp.price_kind = 'retail' and pp.branch_id is null
      and pp.effective_from <= now() and p.archived_at is null
      and (p_manufacturer is null or p.manufacturer_id = p_manufacturer)
      and (p_category is null or p.category_id = p_category)
    order by pp.product_unit_id, pp.effective_from desc, pp.created_at desc
  ) cur;
  get diagnostics n = row_count;
  perform app.log_event('price.bulk_change', 'product_prices', change_id,
    jsonb_build_object('percent_bp', p_percent_bp, 'manufacturer', p_manufacturer, 'category', p_category, 'rows', n));
  return jsonb_build_object('bulk_change_id', change_id, 'prices_changed', n);
end $$;

-- Current price per product unit (branch price beats the all-branch price).
create view current_product_prices with (security_invoker = true) as
select distinct on (pp.tenant_id, pp.product_unit_id, pp.price_kind, coalesce(pp.branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
       pp.tenant_id, pp.product_id, pp.product_unit_id, pp.branch_id, pp.price_kind, pp.amount, pp.effective_from
from product_prices pp
where pp.effective_from <= now()
order by pp.tenant_id, pp.product_unit_id, pp.price_kind,
         coalesce(pp.branch_id, '00000000-0000-0000-0000-000000000000'::uuid), pp.effective_from desc, pp.created_at desc;

-- ---- Stock ----------------------------------------------------------------
create or replace function app.get_or_create_batch(p_tenant uuid, p_product uuid, p_batch_number text,
                                                   p_expiry date, p_user uuid,
                                                   p_price_unit uuid default null, p_retail bigint default null,
                                                   p_mrp bigint default null, p_supplier uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  bid uuid;
begin
  if p_batch_number is null or trim(p_batch_number) = '' then
    raise exception 'Batch number is required' using errcode = '22023';
  end if;
  if p_expiry is null then
    raise exception 'Expiry date is required' using errcode = '22023';
  end if;
  select id into bid from batches
  where tenant_id = p_tenant and product_id = p_product and batch_number = upper(trim(p_batch_number))
    and expiry_date = p_expiry;
  if bid is null then
    insert into batches (tenant_id, product_id, batch_number, expiry_date, price_unit_id, retail_price, mrp,
                         first_supplier_id, created_by, device_id)
    values (p_tenant, p_product, upper(trim(p_batch_number)), p_expiry, p_price_unit, p_retail, p_mrp,
            p_supplier, p_user, app.ctx_device_id())
    returning id into bid;
  end if;
  return bid;
end $$;

-- Opening stock when a pharmacy starts on MedFlow.
-- p_rows: [{product_id, batch_number, expiry_date, qty, unit (code; default
-- base unit), total_cost (minor units, optional; needs product.view_cost),
-- retail_price (per that unit, optional), mrp (optional)}]
create or replace function public.receive_opening_stock(p_branch uuid, p_rows jsonb, p_session uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  r jsonb;
  prod products;
  pu product_units;
  bid uuid;
  qty bigint;
  qty_base bigint;
  cost bigint;
  n int := 0;
  can_cost boolean;
begin
  perform app.assert_branch(p_branch);
  perform app.require_decision(uid, 'stock.adjust', p_branch, null, null, 'other');
  can_cost := app.permission_decision(uid, 'product.view_cost', p_branch) = 'allow';
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'Expected a JSON array of rows' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    select * into prod from products where id = (r ->> 'product_id')::uuid and tenant_id = tid and archived_at is null;
    if not found then raise exception 'Product % not found', r ->> 'product_id' using errcode = 'P0002'; end if;
    select pu2.* into pu from product_units pu2 join units u on u.id = pu2.unit_id
    where pu2.product_id = prod.id and pu2.archived_at is null
      and (u.code = lower(r ->> 'unit') or (r ->> 'unit' is null and pu2.unit_id = prod.base_unit_id));
    if not found then raise exception 'Unit % is not set up for %', r ->> 'unit', prod.brand_name using errcode = '22023'; end if;
    qty := app.try_bigint(r ->> 'qty');
    if qty is null or qty <= 0 then raise exception 'Quantity must be a whole number above 0' using errcode = '22023'; end if;
    qty_base := qty * pu.factor_to_base;
    cost := app.try_bigint(r ->> 'total_cost');
    if cost is not null and not can_cost then
      raise exception 'Permission product.view_cost is required to enter costs' using errcode = '42501';
    end if;
    bid := app.get_or_create_batch(tid, prod.id, r ->> 'batch_number', app.try_date(r ->> 'expiry_date'), uid,
                                   pu.id, app.try_bigint(r ->> 'retail_price'), app.try_bigint(r ->> 'mrp'));
    insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base,
                                 reference_type, reason, occurred_at, created_by, device_id)
    values (tid, p_branch, prod.id, bid, 'opening', qty_base, 'opening', 'opening stock', now(), uid, app.ctx_device_id());
    if cost is not null then
      insert into batch_cost_layers (tenant_id, batch_id, source, qty_base, total_cost, occurred_at, created_by, device_id)
      values (tid, bid, 'opening', qty_base, cost, now(), uid, app.ctx_device_id());
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('rows', n);
end $$;

-- Manual correction (found more / fewer on the shelf). Never below zero.
-- stock.adjust may carry a per-day count limit; over it needs approval.
create or replace function public.adjust_stock(p_branch uuid, p_batch uuid, p_qty_change bigint, p_reason text,
                                               p_approval uuid default null, p_session uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  b batches;
  today_count bigint;
  bal bigint;
  mid uuid := app.uuid_v7();
begin
  perform app.assert_branch(p_branch);
  if p_qty_change is null or p_qty_change = 0 then
    raise exception 'Quantity change cannot be zero' using errcode = '22023';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  select * into b from batches where id = p_batch and tenant_id = tid;
  if not found then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  select count(*) + 1 into today_count from stock_movements m
  join branches br on br.id = m.branch_id
  join tenants t on t.id = m.tenant_id
  where m.tenant_id = tid and m.branch_id = p_branch and m.created_by = uid and m.movement_type = 'adjust'
    and (m.occurred_at at time zone coalesce(br.time_zone, t.time_zone))::date
        = (now() at time zone coalesce(br.time_zone, t.time_zone))::date;
  perform app.require_decision(uid, 'stock.adjust', p_branch, today_count, p_approval, 'other', mid);
  select coalesce(qty_base, 0) into bal from stock_balances where branch_id = p_branch and batch_id = p_batch;
  if coalesce(bal, 0) + p_qty_change < 0 then
    raise exception 'Only % in stock; cannot remove %', coalesce(bal, 0), -p_qty_change using errcode = 'P0001';
  end if;
  insert into stock_movements (id, tenant_id, branch_id, product_id, batch_id, movement_type, qty_base,
                               reference_type, reason, occurred_at, created_by, device_id)
  values (mid, tid, p_branch, b.product_id, b.id, 'adjust', p_qty_change, 'adjustment', p_reason, now(), uid,
          app.ctx_device_id());
  return mid;
end $$;

-- Expiry dashboard actions: write off expired stock or dispose of damaged.
create or replace function public.write_off_stock(p_branch uuid, p_batch uuid, p_qty bigint, p_kind text,
                                                  p_reason text, p_session uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  b batches;
  bal bigint;
  mid uuid := app.uuid_v7();
begin
  perform app.assert_branch(p_branch);
  perform app.require_decision(uid, 'stock.expiry_actions', p_branch, null, null, 'other');
  if p_kind not in ('expire', 'dispose') then
    raise exception 'Kind must be expire or dispose' using errcode = '22023';
  end if;
  select * into b from batches where id = p_batch and tenant_id = tid;
  if not found then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  select coalesce(qty_base, 0) into bal from stock_balances where branch_id = p_branch and batch_id = p_batch;
  bal := coalesce(bal, 0);
  if p_qty is null or p_qty <= 0 or p_qty > bal then
    raise exception 'Quantity must be between 1 and % (in stock)', bal using errcode = '22023';
  end if;
  insert into stock_movements (id, tenant_id, branch_id, product_id, batch_id, movement_type, qty_base,
                               reference_type, reason, occurred_at, created_by, device_id)
  values (mid, tid, p_branch, b.product_id, b.id, p_kind, -p_qty, 'write_off', coalesce(p_reason, p_kind), now(), uid,
          app.ctx_device_id());
  return mid;
end $$;

create or replace function public.block_batch(p_batch uuid, p_reason text, p_branch uuid default null,
                                              p_session uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  ref_branch uuid := coalesce(p_branch, app.device_branch_id(),
                              (select id from branches where tenant_id = tid order by created_at limit 1));
  bid uuid;
begin
  perform app.require_decision(uid, 'stock.block_batch', ref_branch, null, null, 'other');
  if p_branch is not null then perform app.assert_branch(p_branch); end if;
  if not exists (select 1 from batches where id = p_batch and tenant_id = tid) then
    raise exception 'Batch not found' using errcode = 'P0002';
  end if;
  insert into batch_blocks (tenant_id, batch_id, branch_id, source, reason, created_by, device_id)
  values (tid, p_batch, p_branch, 'owner', p_reason, uid, app.ctx_device_id())
  returning id into bid;
  return bid;
end $$;

-- Recall blocks are lifted only by the platform (when the recall is lifted).
create or replace function public.unblock_batch(p_block uuid, p_reason text, p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  tid uuid := app.tenant_id();
  blk batch_blocks;
begin
  select * into blk from batch_blocks where id = p_block and tenant_id = tid and lifted_at is null;
  if not found then raise exception 'Block not found' using errcode = 'P0002'; end if;
  if blk.source = 'global_recall' then
    raise exception 'A recall can only be lifted by the authority / MedFlow' using errcode = '42501';
  end if;
  perform app.require_decision(uid, 'stock.block_batch',
    coalesce(blk.branch_id, app.device_branch_id(), (select id from branches where tenant_id = tid order by created_at limit 1)),
    null, null, 'other');
  update batch_blocks set lifted_at = now(), lifted_by = uid, lift_reason = p_reason where id = p_block;
end $$;

-- ---- Stock counts (blind) --------------------------------------------------
create or replace function public.start_stock_count(p_branch uuid, p_kind text, p_rack text default null,
                                                    p_session uuid default null)
returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  cid uuid;
begin
  perform app.assert_branch(p_branch);
  perform app.require_decision(uid, 'stock.count', p_branch, null, null, 'other');
  insert into stock_counts (tenant_id, branch_id, kind, rack_filter, created_by, device_id)
  values (app.tenant_id(), p_branch, p_kind, p_rack, uid, app.ctx_device_id())
  returning id into cid;
  return cid;
end $$;

create or replace function public.record_count(p_count uuid, p_batch uuid, p_counted bigint,
                                               p_session uuid default null)
returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  sc stock_counts;
  b batches;
begin
  select * into sc from stock_counts where id = p_count and tenant_id = app.tenant_id();
  if not found or sc.status <> 'open' then raise exception 'Count is not open' using errcode = 'P0001'; end if;
  perform app.assert_branch(sc.branch_id);
  perform app.require_decision(uid, 'stock.count', sc.branch_id, null, null, 'other');
  select * into b from batches where id = p_batch and tenant_id = sc.tenant_id;
  if not found then raise exception 'Batch not found' using errcode = 'P0002'; end if;
  if p_counted is null or p_counted < 0 then raise exception 'Count must be 0 or more' using errcode = '22023'; end if;
  insert into stock_count_lines (tenant_id, stock_count_id, product_id, batch_id, counted_qty, counted_at,
                                 created_by, device_id)
  values (sc.tenant_id, sc.id, b.product_id, b.id, p_counted, now(), uid, app.ctx_device_id())
  on conflict (stock_count_id, batch_id) do update
    set counted_qty = excluded.counted_qty, counted_at = excluded.counted_at, created_by = excluded.created_by;
end $$;

create or replace function public.submit_stock_count(p_count uuid, p_session uuid default null) returns void
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_actor(p_session);
  sc stock_counts;
begin
  select * into sc from stock_counts where id = p_count and tenant_id = app.tenant_id();
  if not found or sc.status <> 'open' then raise exception 'Count is not open' using errcode = 'P0001'; end if;
  perform app.require_decision(uid, 'stock.count', sc.branch_id, null, null, 'other');
  update stock_counts set status = 'submitted', submitted_at = now() where id = sc.id;
end $$;

-- Approve: compare with the system, store the variance (owner-only), and post
-- the difference as count_variance movements. A full count treats every
-- batch with stock that was not counted as counted 0.
create or replace function public.approve_stock_count(p_count uuid) returns jsonb
language plpgsql security definer set search_path = public, app as $$
declare
  uid uuid := app.rpc_begin('stock.view_variance');
  sc stock_counts;
  n_lines int;
  n_moves int;
begin
  select * into sc from stock_counts where id = p_count and tenant_id = app.tenant_id();
  if not found or sc.status <> 'submitted' then raise exception 'Count is not submitted' using errcode = 'P0001'; end if;
  perform app.require_decision(uid, 'stock.adjust', sc.branch_id, null, null, 'other');

  if sc.kind = 'full' then
    insert into stock_count_lines (tenant_id, stock_count_id, product_id, batch_id, counted_qty, counted_at, created_by)
    select sb.tenant_id, sc.id, sb.product_id, sb.batch_id, 0, now(), uid
    from stock_balances sb
    left join products p on p.id = sb.product_id
    where sb.branch_id = sc.branch_id and sb.qty_base <> 0
      and (sc.rack_filter is null or p.rack_location = sc.rack_filter)
    on conflict (stock_count_id, batch_id) do nothing;
  end if;

  insert into stock_count_results (stock_count_line_id, tenant_id, expected_qty, variance_qty)
  select l.id, l.tenant_id, coalesce(sb.qty_base, 0), l.counted_qty - coalesce(sb.qty_base, 0)
  from stock_count_lines l
  left join stock_balances sb on sb.branch_id = sc.branch_id and sb.batch_id = l.batch_id
  where l.stock_count_id = sc.id;
  get diagnostics n_lines = row_count;

  insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base,
                               reference_type, reference_id, reference_line_id, reason, occurred_at, created_by)
  select l.tenant_id, sc.branch_id, l.product_id, l.batch_id, 'count_variance', r.variance_qty,
         'stock_count', sc.id, l.id, 'stock count', now(), uid
  from stock_count_lines l join stock_count_results r on r.stock_count_line_id = l.id
  where l.stock_count_id = sc.id and r.variance_qty <> 0;
  get diagnostics n_moves = row_count;

  update stock_counts set status = 'approved', approved_by = uid, approved_at = now() where id = sc.id;
  return jsonb_build_object('lines', n_lines, 'corrections', n_moves);
end $$;

-- ---- Views for screens ---------------------------------------------------
-- Stock per product per branch, with the nearest sellable expiry (counter
-- search shows this while typing).
create view product_stock with (security_invoker = true) as
select sb.tenant_id, sb.branch_id, sb.product_id,
       sum(sb.qty_base)::bigint as qty_base,
       sum(sb.qty_base) filter (where b.expiry_date >= current_date)::bigint as sellable_qty_base,
       min(b.expiry_date) filter (where sb.qty_base > 0 and b.expiry_date >= current_date) as nearest_expiry
from stock_balances sb
join batches b on b.id = sb.batch_id
group by sb.tenant_id, sb.branch_id, sb.product_id;

-- Expiry dashboard: every batch with stock, in buckets.
create view expiry_dashboard with (security_invoker = true) as
select sb.tenant_id, sb.branch_id, sb.product_id, p.brand_name, p.strength, p.rack_location,
       b.id as batch_id, b.batch_number, b.expiry_date, sb.qty_base,
       (b.expiry_date - current_date) as days_left,
       case
         when b.expiry_date < current_date then 'expired'
         when b.expiry_date <= current_date + 30 then 'within_30'
         when b.expiry_date <= current_date + 60 then 'within_60'
         when b.expiry_date <= current_date + 90 then 'within_90'
         else 'later'
       end as bucket,
       exists (select 1 from batch_blocks bb
               where bb.batch_id = b.id and bb.lifted_at is null
                 and (bb.branch_id is null or bb.branch_id = sb.branch_id)) as is_blocked
from stock_balances sb
join batches b on b.id = sb.batch_id
join products p on p.id = sb.product_id
where sb.qty_base > 0;

grant select on current_product_prices, product_stock, expiry_dashboard to authenticated;

-- ---- Self-check: cached balances must equal the ledger ----------------------
create or replace function app.stock_balance_mismatches(p_tenant uuid default null)
returns table (branch_id uuid, batch_id uuid, cached bigint, ledger bigint)
language sql stable security definer set search_path = public, app as $$
  with ledger as (
    select m.branch_id, m.batch_id, sum(m.qty_base)::bigint as qty
    from stock_movements m
    where p_tenant is null or m.tenant_id = p_tenant
    group by m.branch_id, m.batch_id
  )
  select coalesce(sb.branch_id, l.branch_id), coalesce(sb.batch_id, l.batch_id), sb.qty_base, l.qty
  from stock_balances sb
  full join ledger l on l.branch_id = sb.branch_id and l.batch_id = sb.batch_id
  where (p_tenant is null or coalesce(sb.tenant_id, p_tenant) = p_tenant)
    and coalesce(sb.qty_base, 0) is distinct from coalesce(l.qty, 0)
$$;

-- Repair job (nightly / support): rebuild cached balances from the ledger.
create or replace function app.rebuild_stock_balances(p_tenant uuid) returns int
language plpgsql security definer set search_path = public, app as $$
declare
  n int;
begin
  insert into stock_balances as sb (tenant_id, branch_id, batch_id, product_id, qty_base, last_movement_at)
  select tenant_id, branch_id, batch_id, product_id, sum(qty_base), max(occurred_at)
  from stock_movements where tenant_id = p_tenant
  group by tenant_id, branch_id, batch_id, product_id
  on conflict (branch_id, batch_id) do update
    set qty_base = excluded.qty_base, last_movement_at = excluded.last_movement_at, updated_at = now()
    where sb.qty_base is distinct from excluded.qty_base;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---- Grants ---------------------------------------------------------------
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
  public.import_products(jsonb, uuid),
  public.update_product(uuid, jsonb, uuid),
  public.archive_product(uuid, text, uuid),
  public.add_product_unit(uuid, text, bigint, text, uuid),
  public.set_price(uuid, text, bigint, text, uuid, uuid),
  public.bulk_price_change(int, text, uuid, uuid),
  public.receive_opening_stock(uuid, jsonb, uuid),
  public.adjust_stock(uuid, uuid, bigint, text, uuid, uuid),
  public.write_off_stock(uuid, uuid, bigint, text, text, uuid),
  public.block_batch(uuid, text, uuid, uuid),
  public.unblock_batch(uuid, text, uuid),
  public.start_stock_count(uuid, text, text, uuid),
  public.record_count(uuid, uuid, bigint, uuid),
  public.submit_stock_count(uuid, uuid),
  public.approve_stock_count(uuid)
  to authenticated;

grant execute on function
  app.current_user_id(), app.current_device_id(), app.is_device(), app.device_branch_id(),
  app.tenant_id(), app.is_primary_owner(), app.is_platform_admin(),
  app.effective_permission(uuid, text, uuid), app.branches_with(text), app.has_perm(text),
  app.visible_branches()
  to authenticated;

select app.assert_rls_everywhere();
