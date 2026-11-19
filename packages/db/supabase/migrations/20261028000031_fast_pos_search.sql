-- 0031: faster counter search, same answer.
-- Before: every matching medicine had its shelf stock worked out three or more times, and for all
-- matches before the limit was applied, so a short search in a 10,000-medicine pharmacy did thousands
-- of stock look-ups on each key press. Now: pick the best matches by name first (the limit applies
-- here), then work out each one's stock once.
create or replace function public.pos_search(p_query text, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = public, app as $$
declare
  br uuid := app.device_branch_id();
  q text := trim(coalesce(p_query, ''));
  tid uuid := app.tenant_id();
begin
  if br is null then raise exception 'A registered pharmacy PC is required' using errcode = '42501'; end if;
  if length(q) = 0 then return '[]'; end if;
  return (select coalesce(jsonb_agg(r.j order by r.rank, r.name), '[]') from (
    select c.name, c.rank,
           jsonb_build_object(
             'product_id', p.id, 'name', p.brand_name, 'name_ur', p.brand_name_ur, 'strength', p.strength,
             'dosage_form', p.dosage_form, 'generic', g.name, 'manufacturer', m.name, 'rack', p.rack_location,
             'is_controlled', p.is_controlled, 'rx_required', p.rx_required, 'max_qty_per_sale', p.max_qty_per_sale,
             'barcode_unit_id', c.barcode_unit_id,
             'stock_base', coalesce(st.qty, 0),
             'nearest_expiry', st.nearest,
             'units', (select coalesce(jsonb_agg(jsonb_build_object(
                          'product_unit_id', pu.id, 'unit', u.code, 'unit_name', u.name, 'unit_name_ur', u.name_ur,
                          'factor', pu.factor_to_base,
                          'price', app.unit_price(pu.id, st.first_batch, br, 'retail'))
                          order by pu.factor_to_base desc), '[]')
                       from product_units pu join units u on u.id = pu.unit_id
                       where pu.product_id = p.id and pu.archived_at is null and pu.is_sellable)) as j
    from (
      -- 1. The best matches by name, barcode first (cheap: no stock yet).
      -- (generics that match are found once, not looked up again for every medicine; a barcode is one look-up)
      select p.id, p.brand_name as name, bc.product_unit_id as barcode_unit_id,
             case when bc.product_id is not null then 0 when p.brand_name ilike q || '%' then 1 else 2 end as rank
      from products p
      left join (select distinct on (x.product_id) x.product_id, x.product_unit_id from barcodes x
                 where x.tenant_id = tid and x.code = q and x.archived_at is null order by x.product_id) bc on bc.product_id = p.id
      where p.tenant_id = tid and p.archived_at is null and p.is_active
        and (bc.product_id is not null or p.brand_name ilike '%' || q || '%'
             or p.generic_id = any (array(select g.id from generics g where g.tenant_id = tid and g.name ilike '%' || q || '%')))
      order by 4, p.brand_name
      limit least(greatest(coalesce(p_limit, 20), 1), 50)
    ) c
    join products p on p.id = c.id
    left join generics g on g.id = p.generic_id
    left join manufacturers m on m.id = p.manufacturer_id
    -- 2. Each match's shelf stock, once: total, nearest expiry, and the batch sold first (its price).
    left join lateral (select sum(s.qty_base) as qty, min(s.expiry_date) as nearest,
                              (array_agg(s.batch_id order by s.expiry_date, s.batch_id))[1] as first_batch
                       from app.pos_stock(p.id, br) s) st on true
  ) r);
end $$;

-- The price look-up (app.unit_price, used by search and by every sale) finds a medicine's prices by
-- product; the existing index starts with tenant_id, so each look-up read the whole price list.
create index if not exists product_prices_by_product on product_prices (product_id, price_kind, effective_from desc);
