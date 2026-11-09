// Runs every migration and every pgTAP test file in PGlite (embedded
// Postgres) — no Docker needed. CI runs the same files with real pgTAP via
// the Supabase CLI. Usage: pnpm --filter @medflow/db test
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const supabaseDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const read = (...parts) => readFileSync(join(supabaseDir, ...parts), 'utf8');
const sqlFiles = (...parts) =>
  readdirSync(join(supabaseDir, ...parts)).filter((f) => f.endsWith('.sql')).sort();

async function freshDatabase() {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(read('test-support', 'local-supabase-stubs.sql'));
  for (const file of sqlFiles('migrations')) {
    try {
      await db.exec(read('migrations', file));
    } catch (err) {
      throw new Error(`migration ${file} failed: ${err.message}`);
    }
  }
  return db;
}

let failed = 0;
let passed = 0;

const db = await freshDatabase();
console.log(`migrations: ${sqlFiles('migrations').length} applied`);

// The development seed must apply cleanly too.
try {
  await db.exec(`begin; ${read('seed.sql')}; rollback;`);
  console.log('seed.sql: ok');
} catch (err) {
  failed++;
  console.log(`seed.sql: FAILED - ${err.message}`);
  await db.exec('rollback').catch(() => {});
}

await db.exec(read('test-support', 'pgtap-shim.sql'));
await db.exec(read('test-support', 'fixtures.sql'));

for (const file of sqlFiles('tests', 'database')) {
  // Real pgTAP is an extension; locally the shim stands in for it.
  const sql = read('tests', 'database', file).replace(/^create extension if not exists pgtap.*$/m, '');
  try {
    const results = await db.exec(sql);
    const oks = results.flatMap((r) => r.rows.map((row) => Object.values(row)[0]))
      .filter((v) => typeof v === 'string' && v.startsWith('ok '));
    passed += oks.length;
    console.log(`ok    ${file} (${oks.length} assertions)`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${file}\n      ${err.message}`);
    await db.exec('rollback').catch(() => {});
  }
}

// The counter decides offline with packages/core; the server re-checks with
// SQL. Both must agree on every person x permission x branch x amount.
try {
  const n = await permissionParity(db);
  passed += n;
  console.log(`ok    permission parity core <-> SQL (${n} combinations)`);
} catch (err) {
  failed++;
  console.log(`FAIL  permission parity\n      ${err.message}`);
  await db.exec('rollback').catch(() => {});
}

// A CSV read by packages/core must be accepted by public.import_products.
try {
  const n = await csvRoundTrip(db);
  passed += n;
  console.log(`ok    CSV import round trip core -> SQL (${n} checks)`);
} catch (err) {
  failed++;
  console.log(`FAIL  CSV import round trip\n      ${err.message}`);
  await db.exec('rollback').catch(() => {});
}

// The counter prints the bill it computes offline; the server must record exactly the same.
try {
  const n = await billParity(db);
  passed += n;
  console.log(`ok    bill parity core <-> SQL (${n} random bills)`);
} catch (err) {
  failed++;
  console.log(`FAIL  bill parity\n      ${err.message}`);
}
// The demo client (2 branches, 500 products, 30 days of sales) builds cleanly on a fresh database.
// Slow in embedded Postgres, so only with --demo (CI builds it on real Postgres via supabase db reset).
if (process.argv.includes('--demo')) try {
  const n = await demoSeed();
  passed += n;
  console.log(`ok    seed-demo.sql: Demo Pharmacy (${n} checks)`);
} catch (err) {
  failed++;
  console.log(`FAIL  seed-demo.sql\n      ${err.message}`);
}
// Phase 4 acceptance: two counters sell the same product offline for an hour, reconnect, and
// stock and cash are exactly right with no lost sale.
try {
  const n = await twoCountersOffline(db);
  passed += n;
  console.log(`ok    offline: two counters, one hour, reconnect (${n} checks)`);
} catch (err) {
  failed++;
  console.log(`FAIL  offline two counters\n      ${err.message}`);
  await db.exec('rollback').catch(() => {});
}
// The sync rules never send money data to a counter PC, and every table and column they name exists.
try {
  const n = await syncRulesCheck(db);
  passed += n;
  console.log(`ok    powersync/sync-rules.yaml (${n} queries checked)`);
} catch (err) {
  failed++;
  console.log(`FAIL  powersync/sync-rules.yaml\n      ${err.message}`);
}
console.log(`\n${passed} assertions passed, ${failed} file(s) failed`);
process.exit(failed ? 1 : 0);

async function permissionParity(db) {
  const { decide } = await import('../../core/src/permissions.ts');
  await db.exec(`
    begin;
    select tests.fixture();
    -- exercise every rule: overrides at both levels, limits, approval,
    -- archived roles, disabled people
    insert into user_permission_overrides (tenant_id, user_id, branch_id, permission_code, allowed, needs_approval, limit_value)
    values (tests.id('tenant_a'), tests.id('storekeeper_a'), null, 'stock.transfer', true, false, null),
           (tests.id('tenant_a'), tests.id('storekeeper_a'), tests.id('branch_a2'), 'stock.transfer', false, false, null),
           (tests.id('tenant_a'), tests.id('salesman_a'), null, 'sales.discount', true, false, 500),
           (tests.id('tenant_a'), tests.id('manager_a'), tests.id('branch_a1'), 'sales.return', true, true, 2000);
    update role_permissions set limit_value = 1000
    where permission_code = 'sales.discount'
      and role_id = (select id from roles where tenant_id = tests.id('tenant_a') and template_code = 'manager');
    insert into roles (id, tenant_id, name) values (tests.id('role_archived'), tests.id('tenant_a'), 'Old role');
    insert into role_permissions (tenant_id, role_id, permission_code, allowed)
    values (tests.id('tenant_a'), tests.id('role_archived'), 'cash.view', true);
    insert into user_roles (tenant_id, user_id, role_id, branch_id)
    values (tests.id('tenant_a'), tests.id('storekeeper_a'), tests.id('role_archived'), null);
    update roles set archived_at = now() where id = tests.id('role_archived');
    -- two roles with different approval settings and limits on one person
    insert into user_roles (tenant_id, user_id, role_id, branch_id)
    select tests.id('tenant_a'), tests.id('manager_a'), id, tests.id('branch_a1') from roles
    where tenant_id = tests.id('tenant_a') and template_code = 'salesman';
    update role_permissions set limit_value = 300
    where permission_code = 'udhaar.give'
      and role_id = (select id from roles where tenant_id = tests.id('tenant_a') and template_code = 'salesman');
    update role_permissions set limit_value = 800
    where permission_code = 'udhaar.give'
      and role_id = (select id from roles where tenant_id = tests.id('tenant_a') and template_code = 'manager');
    insert into users (id, tenant_id, kind, full_name, status)
    values (tests.id('disabled_a'), tests.id('tenant_a'), 'staff', 'Gone', 'disabled');
    insert into user_roles (tenant_id, user_id, role_id, branch_id)
    select tests.id('tenant_a'), tests.id('disabled_a'), id, null from roles
    where tenant_id = tests.id('tenant_a') and template_code = 'manager';
  `);
  const q = async (sql) => (await db.query(sql, [])).rows;
  const ta = (await q(`select tests.id('tenant_a') as id`))[0].id;
  const users = await q(`select id, is_primary_owner, status, archived_at from users where tenant_id = '${ta}'`);
  const assignments = await q(`select ur.user_id, ur.role_id, ur.branch_id, ur.archived_at, r.archived_at as role_archived_at
                               from user_roles ur join roles r on r.id = ur.role_id where ur.tenant_id = '${ta}'`);
  const rolePerms = await q(`select role_id, permission_code, allowed, needs_approval, limit_value
                             from role_permissions where tenant_id = '${ta}'`);
  const overrides = await q(`select user_id, branch_id, permission_code, allowed, needs_approval, limit_value
                             from user_permission_overrides where tenant_id = '${ta}'`);
  const perms = await q(`select code, limit_kind from permissions`);
  const branches = (await q(`select id from branches where tenant_id = '${ta}'`)).map((b) => b.id);
  const amounts = [null, 0, 500, 1000, 1500, 2500];

  const toGrant = (r) => ({
    permissionCode: r.permission_code, allowed: r.allowed, needsApproval: r.needs_approval,
    limitValue: r.limit_value === null ? null : Number(r.limit_value),
  });
  const rolePermissions = {};
  for (const r of rolePerms) (rolePermissions[r.role_id] ??= []).push(toGrant(r));

  const sqlRows = await q(`
    select u.id as user_id, p.code, b.id as branch_id, a.amt,
           app.permission_decision(u.id, p.code, b.id, a.amt) as decision
    from users u cross join permissions p cross join branches b
    cross join (values ${amounts.map((a) => `(${a === null ? 'null::bigint' : a})`).join(',')}) as a(amt)
    where u.tenant_id = '${ta}' and b.tenant_id = '${ta}'`);

  let checked = 0;
  for (const row of sqlRows) {
    const u = users.find((x) => x.id === row.user_id);
    const access = {
      userId: u.id,
      isPrimaryOwner: u.is_primary_owner,
      status: u.status,
      archived: u.archived_at !== null,
      roles: assignments.filter((a) => a.user_id === u.id).map((a) => ({
        roleId: a.role_id, branchId: a.branch_id, archived: a.archived_at !== null, roleArchived: a.role_archived_at !== null,
      })),
      rolePermissions,
      overrides: overrides.filter((o) => o.user_id === u.id).map((o) => ({ ...toGrant(o), branchId: o.branch_id })),
    };
    const perm = perms.find((p) => p.code === row.code);
    const amount = row.amt === null ? undefined : Number(row.amt);
    const ts = decide(access, { code: perm.code, limitKind: perm.limit_kind }, row.branch_id, amount);
    if (ts !== row.decision) {
      throw new Error(`mismatch for user ${u.id} ${row.code} branch ${row.branch_id} amount ${row.amt}: core=${ts} sql=${row.decision}`);
    }
    checked++;
  }
  await db.exec('rollback');
  return checked;
}

async function csvRoundTrip(db) {
  const { parseCsv, suggestMapping, buildImportRows } = await import('../../core/src/catalogue.ts');
  const csv = [
    'Item Name,Salt,Strength,Company,Tabs per strip,Strips per box,MRP,Bar Code,Controlled',
    '"Augmentin 625mg",Co-amoxiclav,625 mg,GSK,6,2,"Rs 1,050.00",8964000123456,no',
    'Xanax 0.5mg,Alprazolam,0.5 mg,Pfizer,10,3,450.50,8964000654321,yes',
  ].join('\r\n');
  const [header, ...data] = parseCsv(csv);
  const { rows, problems } = buildImportRows(data, suggestMapping(header), { priceIsPer: 'strip' });
  if (problems.length) throw new Error(`core rejected rows: ${JSON.stringify(problems)}`);
  await db.exec(`begin; select tests.fixture();
                 select tests.as_owner(tests.id('auth_owner_a'), tests.id('tenant_a'));`);
  const res = (await db.query('select public.import_products($1::jsonb) as r', [JSON.stringify(rows)])).rows[0].r;
  await db.exec('reset role');
  const check = (cond, msg) => { if (!cond) throw new Error(`${msg}: ${JSON.stringify(res)}`); };
  check(res.created === 2 && res.error_count === 0, 'both rows created without errors');
  const [aug] = (await db.query(`
    select pp.amount, u.code as unit, (select count(*) from product_units x where x.product_id = p.id)::int as sizes,
           (select factor_to_base from product_units x join units y on y.id = x.unit_id
            where x.product_id = p.id and y.code = 'box')::int as box
    from products p join product_prices pp on pp.product_id = p.id
    join product_units pu on pu.id = pp.product_unit_id join units u on u.id = pu.unit_id
    where p.brand_name = 'Augmentin 625mg'`)).rows;
  check(aug && Number(aug.amount) === 105000 && aug.unit === 'strip', 'Rs 1,050.00 per strip stored as 105000 paisa');
  check(aug.sizes === 3 && aug.box === 12, 'tablet / strip of 6 / box of 2 strips = 12 tablets');
  const [xanax] = (await db.query(`select is_controlled from products where brand_name = 'Xanax 0.5mg'`)).rows;
  check(xanax?.is_controlled === true, 'controlled flag carried through');
  await db.exec('rollback');
  return 4;
}

async function billParity(db) {
  const { priceBill, settlePayments } = await import('../../core/src/bill.ts');
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const methods = ['card', 'jazzcash', 'easypaisa', 'bank_transfer'];
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const lines = Array.from({ length: 1 + rnd(6) }, () => {
      const qty = 1 + rnd(12);
      const unitPrice = rnd(5) === 0 ? 0 : 50 + rnd(500_000);
      return { qty, unitPrice, lineDiscount: rnd(3) === 0 ? rnd(qty * unitPrice + 1) : 0, taxRateBp: [0, 0, 1700, 1800, 500][rnd(5)] };
    });
    const base = lines.reduce((s, l) => s + l.qty * l.unitPrice - l.lineDiscount, 0);
    const c = { lines, billDiscount: rnd(3) === 0 ? rnd(base + 1) : 0, inclusive: rnd(2) === 0, step: [0, 1, 100, 500, 1000][rnd(5)], pay: rnd(3) };
    const ts = priceBill(c.lines, { billDiscount: c.billDiscount, pricesIncludeTax: c.inclusive, roundingStep: c.step });
    const sqlLines = c.lines.map((l) => ({ qty: l.qty, unit_price: l.unitPrice, line_discount: l.lineDiscount, tax_rate_bp: l.taxRateBp }));
    const [{ b }] = (await db.query('select app.price_bill($1::jsonb, $2, $3, $4) b', [JSON.stringify(sqlLines), c.billDiscount, c.inclusive, c.step])).rows;
    const want = { gross_total: ts.grossTotal, subtotal: ts.subtotal, discount_total: ts.discountTotal, discount_bp: ts.discountBp,
      tax_total: ts.taxTotal, rounding: ts.rounding, grand_total: ts.grandTotal };
    const wantLines = ts.lines.map((l) => ({ gross: l.gross, discount: l.discount, net: l.net, tax: l.tax, line_total: l.lineTotal }));
    for (const [k, v] of Object.entries(want)) {
      if (Number(b[k]) !== v) throw new Error(`bill ${k}: core=${v} sql=${b[k]} for ${JSON.stringify(c)}`);
    }
    wantLines.forEach((w, j) => {
      for (const [k, v] of Object.entries(w)) {
        if (Number(b.lines[j][k]) !== v) throw new Error(`line ${j} ${k}: core=${v} sql=${b.lines[j][k]} for ${JSON.stringify(c)}`);
      }
    });
    const g = ts.grandTotal;
    if (g === 0) { checked++; continue; }
    const payments = c.pay === 0 ? [{ method: 'cash', tendered: g + 1000 }]
      : c.pay === 1 ? [{ method: methods[g % 4], amount: Math.max(1, Math.floor(g / 2)) }, { method: 'cash', tendered: Math.floor(g / 4) }]
      : [{ method: 'cash', tendered: Math.floor(g / 3) }];
    const tsPay = settlePayments(g, payments);
    const [{ p }] = (await db.query('select app.settle_payments($1, $2::jsonb) p', [g, JSON.stringify(payments)])).rows;
    const wantPay = { paid_total: tsPay.paidTotal, cash_applied: tsPay.cashApplied, change: tsPay.change, udhaar: tsPay.udhaar };
    for (const [k, v] of Object.entries(wantPay)) {
      if (Number(p[k]) !== v) throw new Error(`payment ${k}: core=${v} sql=${p[k]} for ${JSON.stringify({ g, payments })}`);
    }
    checked++;
  }
  return checked;
}

async function demoSeed() {
  const demo = await freshDatabase();
  await demo.exec(read('seed.sql'));
  const t0 = Date.now();
  await demo.exec(read('seed-demo.sql'));
  const q = async (sql) => (await demo.query(sql)).rows[0];
  const c = await q(`select (select count(*)::int from branches b join tenants t on t.id = b.tenant_id where t.name = 'Demo Pharmacy') branches,
    (select count(*)::int from products p join tenants t on t.id = p.tenant_id where t.name = 'Demo Pharmacy') products,
    (select count(*)::int from sales s join tenants t on t.id = s.tenant_id where t.name = 'Demo Pharmacy') sales,
    (select count(distinct business_date)::int from sales s join tenants t on t.id = s.tenant_id where t.name = 'Demo Pharmacy') days,
    (select count(*)::int from sync_flags) flags,
    (select count(*)::int from app.stock_balance_mismatches()) mismatches,
    (select count(*)::int from drawer_session_reconciliations where variance <> 0) short`);
  const want = { branches: 2, products: 500, days: 30, flags: 0, mismatches: 0, short: 0 };
  for (const [k, v] of Object.entries(want)) if (c[k] !== v) throw new Error(`${k}: expected ${v}, got ${c[k]} (${JSON.stringify(c)})`);
  if (c.sales < 900) throw new Error(`expected at least 900 sales, got ${c.sales}`);
  console.log(`      ${c.sales} sales over ${c.days} days in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return Object.keys(want).length + 1;
}

async function twoCountersOffline(db) {
  const { Outbox } = await import('../../sync/src/outbox.ts');
  await db.exec(`begin; select tests.fixture();`);
  const id = async (name) => (await db.query('select tests.id($1) id', [name])).rows[0].id;
  const [ta, a1, salesman, dev1, pu, batch] = await Promise.all(['tenant_a', 'branch_a1', 'salesman_a', 'device_a1', 'product_unit_a', 'batch_a'].map(id));
  const dev2Auth = await id('auth_device_a1_c2');
  // A second counter at the same branch, and a fresh drawer on each.
  await db.query(`insert into auth.users (id, email) values ($1, 'c2@test.invalid')`, [dev2Auth]);
  const dev2 = (await db.query(`insert into devices (tenant_id, branch_id, auth_user_id, code, invoice_prefix, name, kind)
    values ($1, $2, $3, 'C2', 'KHI1-C2', 'Saddar counter 2', 'counter') returning id`, [ta, a1, dev2Auth])).rows[0].id;
  const drawer = async (dev) => (await db.query(`insert into cash_drawers (tenant_id, branch_id, device_id, name) values ($1, $2, $3, 'Offline drawer') returning id`, [ta, a1, dev])).rows[0].id;
  const [drawer1, drawer2] = [await drawer(dev1), await drawer(dev2)];
  await db.query(`insert into stock_movements (tenant_id, branch_id, product_id, batch_id, movement_type, qty_base, occurred_at)
    values ($1, $2, $3, $4, 'opening', 300, now())`, [ta, a1, await id('product_a'), batch]);
  const before = Number((await db.query('select qty_base from stock_balances where branch_id = $1 and batch_id = $2', [a1, batch])).rows[0].qty_base);

  // One hour offline on each counter: 60 bills of 1–3 tablets at Rs 2.50, cash.
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const run = (prefix, drawerId) => {
    let t = Date.parse('2026-11-09T10:00:00Z');
    const o = new Outbox({ devicePrefix: prefix, nextCommandSeq: 1, nextInvoiceSeq: 100, nextReturnSeq: 1, staffId: null, sessionId: null,
      drawerSessionId: null, settings: { pricesIncludeTax: true, roundingStep: 100 } }, () => new Date((t += 55_000)));
    o.signIn(salesman);
    o.openDrawer(drawerId, 500_000);
    let cash = 500_000;
    let sold = 0;
    for (let i = 0; i < 60; i++) {
      const qty = 1 + rnd(3);
      const grand = Math.round((qty * 250) / 100) * 100;
      const s = o.sale({ lines: [{ productUnitId: pu, batchId: batch, qty, unitPrice: 250 }], payments: [{ method: 'cash', tendered: grand + rnd(2) * 500 }] });
      cash += s.settlement.cashApplied;
      sold += qty;
    }
    o.closeDrawer(cash);
    o.signOut();
    return { o, cash, sold };
  };
  const c1 = run('KHI1-C1', drawer1);
  const c2 = run('KHI1-C2', drawer2);

  // Reconnect: counter 1 uploads half, counter 2 everything, counter 1 the rest plus a full retry.
  const upload = async (devAuth, cmds) => {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: devAuth, aal: 'aal1' })]);
    const [{ r }] = (await db.query('select public.apply_device_commands($1::jsonb) r', [JSON.stringify(cmds)])).rows;
    return r;
  };
  const dev1Auth = await id('auth_device_a1');
  const half = Math.floor(c1.o.pending.length / 2);
  await upload(dev1Auth, c1.o.pending.slice(0, half));
  await upload(dev2Auth, c2.o.pending);
  await upload(dev1Auth, c1.o.pending.slice(half));
  const retry = await upload(dev1Auth, [...c1.o.pending].reverse());
  await db.query(`select set_config('request.jwt.claims', '', true)`);

  const q = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  const sales = await q(`select count(*)::int n, coalesce(sum(sl.qty_base), 0)::int qty from sales s join sale_lines sl on sl.sale_id = s.id
    where s.device_id = any($1::uuid[]) and s.local_seq >= 100`, [[dev1, dev2]]);
  const stock = Number((await q('select qty_base from stock_balances where branch_id = $1 and batch_id = $2', [a1, batch])).qty_base);
  const drawers = (await db.query(`select r.expected_cash, r.variance from drawer_session_reconciliations r join drawer_sessions d on d.id = r.drawer_session_id
    where d.cash_drawer_id = any($1::uuid[]) order by r.expected_cash`, [[drawer1, drawer2]])).rows;
  const bad = await q(`select (select count(*)::int from device_commands where status <> 'applied') not_applied,
                              (select count(*)::int from app.stock_balance_mismatches()) mismatches,
                              (select count(*)::int from sync_flags where device_id = any($1::uuid[])) flags`, [[dev1, dev2]]);
  await db.exec('rollback');

  const check = (cond, msg) => { if (!cond) throw new Error(msg); };
  check(retry.every((r) => r.duplicate === true), 'a repeated upload must change nothing');
  check(sales.n === 120, `expected 120 bills, got ${sales.n} (a sale was lost or doubled)`);
  check(sales.qty === c1.sold + c2.sold, `sold ${c1.sold + c2.sold} tablets, recorded ${sales.qty}`);
  check(stock === before - c1.sold - c2.sold, `stock ${stock}, expected ${before - c1.sold - c2.sold}`);
  check(drawers.length === 2 && drawers.every((d) => Number(d.variance) === 0), `drawers not exact: ${JSON.stringify(drawers)}`);
  check(JSON.stringify(drawers.map((d) => Number(d.expected_cash))) === JSON.stringify([c1.cash, c2.cash].sort((a, b) => a - b)), 'drawer cash differs from what the counters took');
  check(bad.not_applied === 0 && bad.mismatches === 0 && bad.flags === 0, `problems: ${JSON.stringify(bad)}`);
  return 7;
}

async function syncRulesCheck(db) {
  const text = readFileSync(join(supabaseDir, '..', 'powersync', 'sync-rules.yaml'), 'utf8').replace(/#.*$/gm, '');
  // Tables a counter must never receive, and money columns that must never appear anywhere.
  const SENSITIVE_TABLES = new Set(['batch_cost_layers', 'grn_line_costs', 'sale_line_costs', 'party_balances', 'ledger_entries',
    'ledger_allocations', 'credit_limits', 'cash_movements', 'money_balances', 'drawer_session_reconciliations', 'stock_count_results',
    'audit_log', 'gl_entries', 'gl_journals', 'gl_accounts', 'expenses', 'salaries', 'staff_advances', 'salary_rates', 'cheques',
    'supplier_claims', 'purchase_invoices', 'po_lines', 'api_keys', 'tax_profiles', 'platform_invoices', 'subscriptions']);
  const SENSITIVE_COLUMNS = /\b(cogs|total_cost|unit_cost|trade_price|line_net|expected_cash|variance|balance|opening_float|counted_cash|expected_unit_cost)\b/;
  const queries = [...text.matchAll(/select\s+([\s\S]+?)\s+from\s+([a-z_]+)([\s\S]*?)(?=\n\s*-\s|\n\s*[a-z_]+:\s*$|\n\s*[a-z_]+:\s*\n|$)/gim)];
  if (queries.length < 20) throw new Error(`only ${queries.length} queries found; the parser is out of step with the file`);
  const cols = new Map();
  for (const r of (await db.query(`select table_name, column_name from information_schema.columns where table_schema = 'public'`)).rows) {
    if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
    cols.get(r.table_name).add(r.column_name);
  }
  for (const [, list, table, rest] of queries) {
    if (SENSITIVE_TABLES.has(table)) throw new Error(`${table} must never be sent to a counter PC`);
    if (/\*/.test(list)) throw new Error(`"select *" from ${table}: list the columns`);
    if (SENSITIVE_COLUMNS.test(list)) throw new Error(`a money column is sent from ${table}: ${list.match(SENSITIVE_COLUMNS)[0]}`);
    if (table === 'product_prices' && !/price_kind in \('retail', 'min_sale'\)/.test(rest)) throw new Error('product_prices must exclude trade prices');
    const known = cols.get(table);
    if (!known) throw new Error(`unknown table ${table}`);
    const idents = list.replace(/'[^']*'/g, ' ').replace(/\bas\s+[a-z_]+/gi, ' ').match(/[a-z_][a-z0-9_]*/gi) ?? [];
    for (const id of idents) if (!known.has(id)) throw new Error(`${table}.${id} doesn't exist`);
    for (const id of (rest.match(/\b([a-z_]+)\s*(=|in\b|is\b)/gi) ?? []).map((m) => m.split(/\s/)[0])) {
      if (!['bucket', 'request', 'and', 'or', 'not'].includes(id) && !known.has(id)) throw new Error(`${table}.${id} (filter) doesn't exist`);
    }
  }
  return queries.length;
}
