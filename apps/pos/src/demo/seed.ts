// Demo Pharmacy for trying the POS in a browser: one branch, one counter PC, four staff with PINs,
// 28 common medicines with pack sizes and two batches each, three khata customers.
// Names of medicines are ordinary market names used as sample catalogue data.
import { hashPin } from '@medflow/core';

export const DEMO = {
  tenant: '0195f000-0000-7000-8000-000000000001',
  branch: '0195f000-0000-7000-8000-000000000002',
  device: '0195f000-0000-7000-8000-000000000003',
  deviceAuth: '0195f000-0000-7000-8000-000000000004',
  drawer: '0195f000-0000-7000-8000-000000000005',
  ownerAuth: '0195f000-0000-7000-8000-000000000006',
  bank: '0195f000-0000-7000-8000-000000000007',
  wallet: '0195f000-0000-7000-8000-000000000008',
  staff: [
    { id: '0195f000-0000-7000-8000-000000000010', name: 'Syed Hashir Ali', kind: 'owner', role: 'owner', pin: '1470' },
    { id: '0195f000-0000-7000-8000-000000000011', name: 'Sana Malik', kind: 'staff', role: 'manager', pin: '2580' },
    { id: '0195f000-0000-7000-8000-000000000012', name: 'Dr. Ayesha Khan', kind: 'staff', role: 'pharmacist', pin: '2469' },
    { id: '0195f000-0000-7000-8000-000000000013', name: 'Bilal Ahmad', kind: 'staff', role: 'salesman', pin: '1357' },
  ],
} as const;

// name, generic, strength, form, company, per strip, strips per box, box price (Rs), flags
type Row = [string, string, string, string, string, number, number, number, ('rx' | 'controlled')?];
const PRODUCTS: Row[] = [
  ['Panadol 500mg Tablet', 'Paracetamol', '500mg', 'tablet', 'Haleon', 10, 20, 380],
  ['Panadol Extra Tablet', 'Paracetamol + Caffeine', '500/65mg', 'tablet', 'Haleon', 10, 10, 300],
  ['Brufen 400mg Tablet', 'Ibuprofen', '400mg', 'tablet', 'Abbott', 10, 3, 165],
  ['Augmentin 625mg Tablet', 'Co-amoxiclav', '625mg', 'tablet', 'GSK', 6, 1, 590, 'rx'],
  ['Amoxil 500mg Capsule', 'Amoxicillin', '500mg', 'capsule', 'GSK', 10, 2, 260, 'rx'],
  ['Flagyl 400mg Tablet', 'Metronidazole', '400mg', 'tablet', 'Sanofi', 10, 2, 130],
  ['Risek 20mg Capsule', 'Omeprazole', '20mg', 'capsule', 'Getz Pharma', 7, 2, 390],
  ['Nexum 40mg Tablet', 'Esomeprazole', '40mg', 'tablet', 'Getz Pharma', 7, 2, 590],
  ['Glucophage 500mg Tablet', 'Metformin', '500mg', 'tablet', 'Merck', 10, 5, 210, 'rx'],
  ['Lipiget 20mg Tablet', 'Atorvastatin', '20mg', 'tablet', 'Getz Pharma', 10, 1, 450, 'rx'],
  ['Concor 5mg Tablet', 'Bisoprolol', '5mg', 'tablet', 'Merck', 10, 3, 520, 'rx'],
  ['Norvasc 5mg Tablet', 'Amlodipine', '5mg', 'tablet', 'Pfizer', 10, 2, 480, 'rx'],
  ['Arinac Forte Tablet', 'Ibuprofen + Pseudoephedrine', '400/60mg', 'tablet', 'Abbott', 10, 2, 220],
  ['Disprin Tablet', 'Aspirin', '300mg', 'tablet', 'Reckitt', 10, 10, 250],
  ['Gravinate Tablet', 'Dimenhydrinate', '50mg', 'tablet', 'Searle', 10, 10, 280],
  ['Motilium 10mg Tablet', 'Domperidone', '10mg', 'tablet', 'Janssen', 10, 2, 320],
  ['Leflox 500mg Tablet', 'Levofloxacin', '500mg', 'tablet', 'Getz Pharma', 5, 2, 420, 'rx'],
  ['Softin 10mg Tablet', 'Loratadine', '10mg', 'tablet', 'Hilton Pharma', 10, 1, 210],
  ['Dicloran 50mg Tablet', 'Diclofenac', '50mg', 'tablet', 'Sami Pharma', 10, 2, 90],
  ['Entamizole Tablet', 'Metronidazole + Diloxanide', '200/250mg', 'tablet', 'Abbott', 10, 2, 120],
  ['Surbex-Z Tablet', 'Multivitamin + Zinc', '', 'tablet', 'Abbott', 10, 3, 1050],
  ['Xanax 0.5mg Tablet', 'Alprazolam', '0.5mg', 'tablet', 'Pfizer', 10, 3, 330, 'controlled'],
  ['Lexotanil 3mg Tablet', 'Bromazepam', '3mg', 'tablet', 'Roche', 10, 3, 280, 'controlled'],
  // Single packs: per strip = 1 and strips per box = 1 means only the pack itself is sold.
  ['Calpol Syrup 120mg/5ml', 'Paracetamol', '120mg/5ml', 'bottle', 'Haleon', 1, 1, 145],
  ['Hydryllin Syrup 120ml', 'Diphenhydramine + Ammonium chloride', '120ml', 'bottle', 'Searle', 1, 1, 165],
  ['Ventolin Inhaler', 'Salbutamol', '100mcg', 'piece', 'GSK', 1, 1, 640, 'rx'],
  ['Polyfax Ointment 20g', 'Polymyxin B + Bacitracin', '20g', 'tube', 'GSK', 1, 1, 230],
  ['ORS-L Sachet', 'Oral rehydration salts', '', 'sachet', 'Searle', 1, 20, 300],
];

const q = (s: string | null | undefined) => (s === null || s === undefined || s === '' ? 'null' : `'${s.replace(/'/g, "''")}'`);
let n = 100;
const id = () => `0195f000-0000-7000-8000-${String(n++).padStart(12, '0')}`;
const day = (offset: number) => `current_date + ${offset}`;

export async function demoSeedSql(): Promise<string> {
  const T = DEMO.tenant;
  const owner = DEMO.staff[0].id;
  const out: string[] = [];
  out.push(`insert into auth.users (id, email) values ('${DEMO.deviceAuth}', 'counter1@demo.invalid');`);
  out.push(`insert into tenants (id, name, owner_name, owner_phone, owner_email, city, plan_id, status, trial_ends_at)
    select '${T}', 'Demo Pharmacy', 'Syed Hashir Ali', '03000000000', 'owner@demo.invalid', 'Karachi', id, 'trial', now() + interval '14 days'
    from plans where code = 'pro';`);
  out.push(`insert into auth.users (id, email) values ('${DEMO.ownerAuth}', 'owner@demo.invalid');`);
  out.push(`insert into users (id, tenant_id, auth_user_id, kind, is_primary_owner, full_name, status) values ('${owner}', '${T}', '${DEMO.ownerAuth}', 'owner', true, 'Syed Hashir Ali', 'active');`);
  out.push(`insert into branches (id, tenant_id, code, name, address, city, phone, closing_time)
    values ('${DEMO.branch}', '${T}', 'KHI1', 'Saddar Branch', 'Shop 12, Saddar, Karachi', 'Karachi', '021-35550000', '23:00');`);
  out.push(`select app.seed_tenant_defaults('${T}', '${owner}');`);
  out.push(`insert into settings (tenant_id, key, value, created_by) values ('${T}', 'pos.receipt_footer', '"Get well soon. Medicines once sold can be returned within 7 days with the bill."', '${owner}');`);
  out.push(`insert into devices (id, tenant_id, branch_id, auth_user_id, code, invoice_prefix, name, kind, platform)
    values ('${DEMO.device}', '${T}', '${DEMO.branch}', '${DEMO.deviceAuth}', 'C1', 'KHI1-C1', 'Counter 1', 'counter', 'browser');`);
  // The PC's cash drawer is created with the PC (migration 0026).
  for (const s of DEMO.staff.slice(1)) {
    out.push(`insert into users (id, tenant_id, kind, full_name, status) values ('${s.id}', '${T}', 'staff', ${q(s.name)}, 'active');`);
    out.push(`insert into user_roles (tenant_id, user_id, role_id, branch_id) select '${T}', '${s.id}', r.id, '${DEMO.branch}'
      from roles r where r.tenant_id = '${T}' and r.template_code = '${s.role}';`);
  }
  for (const s of DEMO.staff) {
    // Fewer PBKDF2 rounds than a real PIN (600,000), so the demo signs in quickly.
    const hash = await hashPin(s.pin, { iterations: 50_000 });
    out.push(`insert into user_pins (user_id, tenant_id, pin_hash) values ('${s.id}', '${T}', '${hash}');`);
  }

  const companies = new Map<string, string>();
  const generics = new Map<string, string>();
  for (const [, generic, , , company] of PRODUCTS) {
    if (!companies.has(company)) {
      const cid = id();
      companies.set(company, cid);
      out.push(`insert into manufacturers (id, tenant_id, name) values ('${cid}', '${T}', ${q(company)});`);
    }
    if (!generics.has(generic)) {
      const gid = id();
      generics.set(generic, gid);
      out.push(`insert into generics (id, tenant_id, name) values ('${gid}', '${T}', ${q(generic)});`);
    }
  }

  PRODUCTS.forEach(([name, generic, strength, form, company, perStrip, stripsPerBox, boxPrice, flag], i) => {
    const pid = id();
    const base = form === 'capsule' ? 'capsule' : form === 'tablet' ? 'tablet' : form;
    out.push(`insert into products (id, tenant_id, brand_name, generic_id, strength, dosage_form, manufacturer_id, base_unit_id,
        is_controlled, rx_required, max_qty_per_sale, rack_location, reorder_level)
      select '${pid}', '${T}', ${q(name)}, '${generics.get(generic)}', ${q(strength)}, ${q(form)}, '${companies.get(company)}', u.id,
        ${flag === 'controlled'}, ${flag === 'rx' || flag === 'controlled'}, ${flag === 'controlled' ? 30 : 'null'},
        'R${(i % 6) + 1}-S${(i % 4) + 1}', ${perStrip * 5}
      from units u where u.tenant_id = '${T}' and u.code = '${base}';`);
    // Pack ladder: the smallest unit, the strip, the box (when they exist).
    const ladder: Array<[string, number]> = [[base, 1]];
    if (perStrip > 1) ladder.push(['strip', perStrip]);
    if (stripsPerBox > 1) ladder.push(['box', perStrip * stripsPerBox]);
    const boxUnit = ladder[ladder.length - 1]!;
    const unitIds: Record<string, string> = {};
    for (const [code, factor] of ladder) {
      const uid = id();
      unitIds[code] = uid;
      out.push(`insert into product_units (id, tenant_id, product_id, unit_id, factor_to_base)
        select '${uid}', '${T}', '${pid}', u.id, ${factor} from units u where u.tenant_id = '${T}' and u.code = '${code}';`);
    }
    out.push(`insert into barcodes (tenant_id, product_id, product_unit_id, code) values ('${T}', '${pid}', '${unitIds[boxUnit[0]]}', '896${String(1000000 + i * 37).padStart(10, '0')}');`);
    const boxPaisa = boxPrice * 100;
    out.push(`insert into product_prices (tenant_id, product_id, product_unit_id, price_kind, amount)
      values ('${T}', '${pid}', '${unitIds[boxUnit[0]]}', 'retail', ${boxPaisa}),
             ('${T}', '${pid}', '${unitIds[boxUnit[0]]}', 'trade', ${Math.round(boxPaisa * 0.85)});`);
    // Two batches: one sells first (some expired or expiring soon, to show the rules), one later.
    const soon = i === 13 ? -10 : i === 2 ? 5 : i % 5 === 0 ? 45 : 120 + i * 3;
    const batches: Array<[string, number, number]> = [
      [`${name.slice(0, 2).toUpperCase()}${2400 + i}`, soon, i === 7 ? 1 : 2],
      [`${name.slice(0, 2).toUpperCase()}${2600 + i}`, 420 + i * 5, i === 7 ? 0 : 6],
    ];
    for (const [bn, exp, boxes] of batches) {
      if (boxes === 0) continue;
      const bid = id();
      const qty = boxes * boxUnit[1];
      out.push(`insert into batches (id, tenant_id, product_id, batch_number, expiry_date, price_unit_id, retail_price, mrp)
        values ('${bid}', '${T}', '${pid}', '${bn}', ${day(exp)}, '${unitIds[boxUnit[0]]}', ${boxPaisa}, ${boxPaisa});`);
      out.push(`insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, reference_type, reason, occurred_at, created_by)
        values ('${T}', '${DEMO.branch}', '${pid}', '${bid}', 'opening', ${qty}, 'opening', 'opening stock', now() - interval '30 days', '${owner}');`);
      out.push(`insert into batch_cost_layers (tenant_id, batch_id, source, qty_base, total_cost, occurred_at, created_by)
        values ('${T}', '${bid}', 'opening', ${qty}, ${Math.round(boxPaisa * 0.85) * boxes}, now() - interval '30 days', '${owner}');`);
    }
  });

  out.push(`insert into bank_accounts (id, tenant_id, kind, name, bank_name) values
    ('${DEMO.bank}', '${T}', 'bank', 'Meezan Bank current', 'Meezan Bank'), ('${DEMO.wallet}', '${T}', 'jazzcash', 'Shop JazzCash', 'JazzCash');`);
  out.push(`select app.ensure_expense_categories('${T}');`);
  const suppliers: Array<[string, string, number, number]> = [
    ['Muller & Phipps Pakistan', '02132410000', 30, 4_500_000],
    ['Premier Agencies', '02132420000', 15, 1_250_000],
    ['United Distributors', '04235760000', 21, 0],
  ];
  for (const [name, phone, terms, opening] of suppliers) {
    const sid = id();
    out.push(`insert into suppliers (id, tenant_id, name, phone, payment_terms_days) values ('${sid}', '${T}', ${q(name)}, '${phone}', ${terms});`);
    if (opening > 0) {
      out.push(`insert into ledger_entries (tenant_id, branch_id, party_type, supplier_id, entry_type, credit, entry_date, due_date, memo, occurred_at, created_by)
        values ('${T}', '${DEMO.branch}', 'supplier', '${sid}', 'opening', ${opening}, current_date - 20, current_date + 10, 'opening balance', now() - interval '20 days', '${owner}');`);
    }
  }

  const customers: Array<[string, string, number, number]> = [
    ['Khan Family', '03001234567', 2_000_000, 450_000],
    ['Dr. Saima Clinic', '03219876543', 5_000_000, 0],
    ['Ahmed Raza', '03335557777', 500_000, 520_000],
  ];
  customers.forEach(([name, phone, limit, opening], i) => {
    const acc = id();
    const cus = id();
    out.push(`insert into customer_accounts (id, tenant_id, account_number, name) values ('${acc}', '${T}', 'C-00000${i + 1}', ${q(name)});`);
    out.push(`insert into customers (id, tenant_id, account_id, name, phone, reminders_opt_in) values ('${cus}', '${T}', '${acc}', ${q(name)}, '${phone}', true);`);
    out.push(`insert into credit_limits (tenant_id, account_id, limit_amount, reason, created_by) values ('${T}', '${acc}', ${limit}, 'demo', '${owner}');`);
    if (opening > 0) {
      out.push(`insert into ledger_entries (tenant_id, branch_id, party_type, customer_account_id, entry_type, debit, entry_date, due_date, memo, occurred_at, created_by)
        values ('${T}', '${DEMO.branch}', 'customer_account', '${acc}', 'opening', ${opening}, current_date - 40, current_date - 10, 'opening balance', now() - interval '40 days', '${owner}');`);
    }
  });
  return out.join('\n');
}
