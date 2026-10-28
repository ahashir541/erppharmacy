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
