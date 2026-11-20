// Who can do what at the counter: one user per role, each counter action tried for real against the
// database (as the counter PC with that person's PIN session). Prints a table; exits 1 if a role can
// sign in at the counter but is stuck (cannot open or close its own shift, or cannot sell at all).
// Usage: node scripts/role-matrix.mjs
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase');
const read = (...p) => readFileSync(join(dir, ...p), 'utf8');
const db = new PGlite({ extensions: { pg_trgm } });
await db.exec(read('test-support', 'local-supabase-stubs.sql'));
for (const f of readdirSync(join(dir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) await db.exec(read('migrations', f));
await db.exec(read('test-support', 'pgtap-shim.sql'));
await db.exec(read('test-support', 'fixtures.sql'));
await db.exec('select tests.fixture()');

const ROLES = ['manager', 'pharmacist', 'salesman', 'storekeeper', 'accountant'];
// What the counter screen lets a person do, and the permission behind it.
const ACTIONS = [
  ['Sell (and open a shift)', 'sales.create'], ['Hold / resume a bill', 'sales.hold'], ['Reprint a bill', 'sales.reprint'],
  ['Give a discount', 'sales.discount'], ['Change a price', 'sales.edit_price'], ['Take a return', 'sales.return'], ['Void a bill', 'sales.void'],
  ['Sell on udhaar', 'udhaar.give'], ['See if a customer may take udhaar', 'udhaar.check_status'],
  ['Confirm a prescription', 'prescriptions.confirm'], ['Sell a controlled drug', 'controlled.dispense'],
];
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const tenant = (await q(`select tests.id('tenant_a') id`))[0].id;
const branch = (await q(`select tests.id('branch_a1') id`))[0].id;
const owner = (await q(`select id from users where tenant_id = $1 and is_primary_owner`, [tenant]))[0].id;
const pin = (await q(`select pin_hash from user_pins where user_id = tests.id('salesman_a')`))[0].pin_hash;

const people = {};
for (const role of ROLES) {
  const r = (await q(`select id from roles where tenant_id = $1 and template_code = $2`, [tenant, role]))[0];
  const u = (await q(`insert into users (tenant_id, kind, full_name, status) values ($1, 'staff', $2, 'active') returning id`, [tenant, `Test ${role}`]))[0].id;
  await q(`insert into user_roles (tenant_id, user_id, role_id, branch_id) values ($1, $2, $3, $4)`, [tenant, u, r.id, branch]);
  await q(`insert into user_pins (user_id, tenant_id, pin_hash) values ($1, $2, $3)`, [u, tenant, pin]);
  people[role] = u;
}
const decide = async (u, code) => (await q(`select app.permission_decision($1, $2, $3) d`, [u, code, branch]))[0].d ?? 'deny';

// Real shift: open and close one's own shift at the counter, one person at a time.
const shift = {};
const drawer = (await q(`select tests.id('drawer_a1') id`))[0].id;
await db.exec(`select tests.as_device(tests.id('auth_device_a1')); select public.close_drawer(tests.id('drawer_session_a1'), 0, null,
  (select public.start_staff_session(tests.id('salesman_a'), tests.id('first_sess'))::uuid)); reset role;`).catch(() => {});
for (const role of ROLES) {
  const res = { open: 'no', close: 'no' };
  try {
    await db.exec('begin');
    await db.exec(`select tests.as_device(tests.id('auth_device_a1'))`);
    const sess = crypto.randomUUID();
    await q(`select public.start_staff_session($1, $2)`, [people[role], sess]);
    const ds = crypto.randomUUID();
    await q(`select public.open_drawer($1, 100000, $2, $3)`, [drawer, sess, ds]);
    res.open = 'yes';
    await q(`select public.close_drawer($1, 100000, null, $2)`, [ds, sess]);
    res.close = 'yes';
  } catch (e) { res.error = e.message.split('\n')[0]; }
  await db.exec('rollback');
  shift[role] = res;
}

const sign = { allow: '✓', needs_approval: 'approval', deny: '✗' };
const rows = [];
for (const [label, code] of ACTIONS) {
  const cells = [];
  for (const role of ROLES) cells.push(sign[await decide(people[role], code)] ?? '✗');
  rows.push([label, ...cells]);
}
rows.unshift(['Open own shift', ...ROLES.map((r) => (shift[r].open === 'yes' ? '✓' : '✗'))], ['Close own shift', ...ROLES.map((r) => (shift[r].close === 'yes' ? '✓' : '✗'))]);
const w = [34, ...ROLES.map((r) => Math.max(r.length, 8))];
const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join(' | ');
console.log(line(['Counter action', ...ROLES]));
console.log(w.map((n) => '-'.repeat(n)).join('-|-'));
for (const r of rows) console.log(line(r));
console.log(`\nOwner (${owner.slice(0, 8)}…): every action allowed (primary owner).`);
const stuck = ROLES.filter((r) => shift[r].open === 'yes' && shift[r].close !== 'yes');
const idle = ROLES.filter((r) => shift[r].open !== 'yes');
if (stuck.length) console.log(`STUCK: can open but not close a shift: ${stuck.join(', ')}`);
if (idle.length) console.log(`NOTHING TO DO AT THE COUNTER (cannot sell or open a shift): ${idle.join(', ')}`);
for (const r of ROLES) if (shift[r].error) console.log(`  ${r}: ${shift[r].error}`);
process.exit(stuck.length ? 1 : 0);
