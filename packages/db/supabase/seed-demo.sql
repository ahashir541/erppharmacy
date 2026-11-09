-- Demo client for testing and sales demos (local development only; never on a real project):
-- "Demo Pharmacy", 2 branches, 500 products, 30 days of sales. Everything goes through the real
-- functions (import, opening stock, staff sign-in on a counter PC, drawers, sales), so the demo
-- data obeys every rule the real data does. All names and numbers are made up.
do $$
declare
  tid uuid := '00000000-0000-4000-8000-00000000d000';
  owner_auth uuid := '00000000-0000-4000-8000-00000000d001';
  owner_id uuid := '00000000-0000-4000-8000-00000000d002';
  plan uuid;
  b record;
  dev record;
  sess uuid;
  drawer uuid;
  dsess uuid;
  day date;
  n int;
  i int;
  seq bigint;
  pick record;
  qty int;
  rows jsonb;
  generics text[] := array['Paracetamol','Ibuprofen','Amoxicillin','Azithromycin','Cetirizine','Loratadine','Omeprazole','Esomeprazole',
    'Metformin','Glimepiride','Amlodipine','Losartan','Atorvastatin','Rosuvastatin','Ciprofloxacin','Levofloxacin','Diclofenac',
    'Naproxen','Montelukast','Salbutamol','Prednisolone','Ranitidine','Domperidone','Ondansetron','Loperamide','Metronidazole',
    'Fluconazole','Clopidogrel','Aspirin','Vitamin D3','Calcium','Iron','Folic Acid','Multivitamin','Zinc','ORS','Cough Syrup',
    'Antacid','Lactulose','Mebeverine','Tramadol','Alprazolam','Sertraline','Escitalopram','Insulin','Hydrocortisone','Mupirocin',
    'Clotrimazole','Betamethasone','Chlorpheniramine'];
  makers text[] := array['Demo Pharma','Sample Labs','Example Healthcare','Test Remedies','Model Biotech','Placeholder Pharma','Mock Medica','Specimen Labs'];
begin
  if exists (select 1 from tenants where id = tid) then return; end if;
  select id into plan from plans where code = 'pro';
  insert into auth.users (id, email) values (owner_auth, 'owner@demo-pharmacy.example');
  insert into tenants (id, name, owner_name, owner_phone, owner_email, plan_id, status, city)
  values (tid, 'Demo Pharmacy', 'Demo Owner', '03000000000', 'owner@demo-pharmacy.example', plan, 'active', 'Karachi');
  insert into users (id, tenant_id, auth_user_id, kind, is_primary_owner, full_name, status)
  values (owner_id, tid, owner_auth, 'owner', true, 'Demo Owner', 'active');
  insert into branches (id, tenant_id, code, name, city, closing_time) values
    ('00000000-0000-4000-8000-00000000d010', tid, 'KHI1', 'Saddar', 'Karachi', '23:00'),
    ('00000000-0000-4000-8000-00000000d011', tid, 'LHR1', 'Gulberg', 'Lahore', '23:00');
  perform app.seed_tenant_defaults(tid, owner_id);

  -- As the owner (signed in with 2FA): 500 products, 10 generics x 50 strengths/makers.
  perform set_config('request.jwt.claims', json_build_object('sub', owner_auth, 'tenant_id', tid, 'aal', 'aal2')::text, true);
  select jsonb_agg(jsonb_build_object(
           'brand_name', 'Demo ' || generics[1 + (g % 50)] || ' ' || chr(65 + (g / 50)),
           'generic', generics[1 + (g % 50)],
           'strength', (array['50 mg','100 mg','250 mg','500 mg','5 mg','10 mg','20 mg','1 g'])[1 + (g % 8)],
           'dosage_form', (array['tablet','capsule','syrup','tablet','cream'])[1 + (g % 5)],
           'manufacturer', makers[1 + (g % 8)],
           'category', (array['Pain relief','Antibiotics','Allergy','Stomach','Diabetes','Heart','Vitamins','Skin'])[1 + (g % 8)],
           'barcode', '200' || lpad(g::text, 10, '0'),
           'base_unit', 'tablet',
           'units', jsonb_build_array(jsonb_build_object('unit', 'strip', 'factor', 10), jsonb_build_object('unit', 'box', 'factor', 100)),
           'retail_price', (2 + (g * 37) % 40) * 500,       -- Rs 10 to Rs 205 a strip
           'retail_unit', 'strip',
           'reorder_level', 50,
           'is_controlled', g % 97 = 0, 'rx_required', g % 13 = 0)) into rows
  from generate_series(0, 499) g;
  perform public.import_products(rows);

  -- Opening stock in both branches: two batches each (one expiring sooner), cost ~70% of retail.
  for b in select id from branches where tenant_id = tid loop
    select jsonb_agg(x.r) into rows from (
      select jsonb_build_object('product_id', p.id, 'batch_number', 'D' || lpad(row_number() over ()::text, 4, '0') || k,
               'expiry_date', (current_date + (case k when 'A' then 75 + (row_number() over ()) % 60 else 400 end)::int)::text,
               'qty', 300, 'unit', 'tablet',
               'total_cost', (pp.amount * 300 * 7 / 100)) as r
      from products p
      join product_units pu on pu.product_id = p.id join units u on u.id = pu.unit_id and u.code = 'strip'
      join product_prices pp on pp.product_unit_id = pu.id and pp.price_kind = 'retail'
      cross join (values ('A'), ('B')) as kk(k)
      where p.tenant_id = tid) x;
    perform public.receive_opening_stock(b.id, rows);
  end loop;

  -- A counter PC, a drawer and a salesman per branch.
  for b in select id, code from branches where tenant_id = tid loop
    insert into auth.users (id, email) values (gen_random_uuid(), 'pc-' || lower(b.code) || '@devices.demo.example')
    returning id into sess;
    insert into devices (tenant_id, branch_id, auth_user_id, code, invoice_prefix, name, kind)
    values (tid, b.id, sess, 'C1', b.code || '-C1', b.code || ' counter 1', 'counter');
    insert into cash_drawers (tenant_id, branch_id, device_id, name)
    select tid, b.id, d.id, 'Drawer 1' from devices d where d.branch_id = b.id;
    insert into users (tenant_id, kind, full_name, status) values (tid, 'staff', 'Demo Salesman ' || b.code, 'active');
    insert into user_roles (tenant_id, user_id, role_id, branch_id)
    select tid, u.id, r.id, b.id from users u, roles r
    where u.tenant_id = tid and u.full_name = 'Demo Salesman ' || b.code and r.tenant_id = tid and r.template_code = 'salesman';
  end loop;

  -- 30 days of sales on each counter: open the drawer, 15–25 bills, close the drawer (counted = expected).
  for dev in select d.id, d.auth_user_id, d.branch_id, d.invoice_prefix, u.id as staff, c.id as drawer
             from devices d join users u on u.tenant_id = tid and u.full_name = 'Demo Salesman ' || split_part(d.invoice_prefix, '-', 1)
             join cash_drawers c on c.device_id = d.id where d.tenant_id = tid loop
    perform set_config('request.jwt.claims', json_build_object('sub', dev.auth_user_id, 'aal', 'aal1')::text, true);
    seq := 0;
    for day in select generate_series(current_date - 29, current_date, interval '1 day')::date loop
      sess := public.start_staff_session(dev.staff, gen_random_uuid(), (day + time '09:00') at time zone 'Asia/Karachi');
      dsess := public.open_drawer(dev.drawer, 500000, sess);
      n := 15 + (extract(doy from day)::int * 7) % 11;
      for i in 1 .. n loop
        seq := seq + 1;
        -- FEFO: the sellable batch expiring first, of a product picked by the day and bill number.
        select p.id as product, pu.id as unit, pp.amount as price, sb.batch_id into pick
        from products p
        join product_units pu on pu.product_id = p.id join units u on u.id = pu.unit_id and u.code = 'strip'
        join product_prices pp on pp.product_unit_id = pu.id and pp.price_kind = 'retail'
        join stock_balances sb on sb.product_id = p.id and sb.branch_id = dev.branch_id and sb.qty_base >= 30
        join batches bt on bt.id = sb.batch_id and bt.expiry_date >= day
        where p.tenant_id = tid and not p.rx_required and not p.is_controlled
        order by (hashtext(p.id::text || day::text || i::text)), bt.expiry_date
        limit 1;
        qty := 1 + (i % 3);
        perform app.record_sale(jsonb_build_object(
          'id', gen_random_uuid(), 'local_seq', seq, 'drawer_session_id', dsess,
          'sold_at', ((day + time '10:00' + make_interval(mins => i * 25)) at time zone 'Asia/Karachi')::text,
          'lines', jsonb_build_array(jsonb_build_object('product_unit_id', pick.unit, 'batch_id', pick.batch_id, 'qty', qty, 'unit_price', pick.price)),
          'payments', jsonb_build_array(jsonb_build_object('method', 'cash', 'tendered', qty * pick.price + 100))), dev.staff, 'offline');
      end loop;
      perform public.close_drawer(dsess,
        (select coalesce(sum(amount), 0)::bigint from cash_movements where drawer_session_id = dsess), null, sess);
      perform public.end_staff_session(sess, 'logout', (day + time '22:30') at time zone 'Asia/Karachi');
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true);
end $$;
