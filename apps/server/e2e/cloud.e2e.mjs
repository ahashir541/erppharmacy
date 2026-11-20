// The cloud version, start to finish, on the live site: a new pharmacy owner is added in Supabase,
// signs in on the website with a password and a 6-digit authenticator code (worked out here from
// the secret the page shows, as an authenticator app would), imports the inventory and sells.
//
//   node e2e/cloud.e2e.mjs --site https://… --ref <project-ref>   (supabase CLI logged in; SUPABASE_DB_PASSWORD set)
// The admin (service_role) key stays in memory; the test owner's password is random and never shown.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const site = argv('site'); const ref = argv('ref');
if (!site || !ref) { console.error('Give --site and --ref'); process.exit(2); }
const dbDir = path.resolve(here, '../../../packages/db');
const supa = `https://${ref}.supabase.co`;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };
const sql = (q) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mf-sql-')), 'q.sql');
  fs.writeFileSync(file, q);
  try { return JSON.parse(execFileSync('supabase', ['db', 'query', '--linked', '-o', 'json', '-f', `"${file}"`], { cwd: dbDir, encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] })).rows ?? []; }
  finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
};
const keys = JSON.parse(execFileSync('supabase', ['projects', 'api-keys', '--project-ref', ref, '-o', 'json'], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] }));
const service = keys.find((k) => k.name === 'service_role')?.api_key;

// RFC 6238 TOTP, as an authenticator app does it.
const totp = (secretB32) => {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secretB32.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = createHmac('sha1', key).update(msg).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
};

// ---- A new owner and pharmacy, the way the platform owner adds one ----
const email = `cloudtest-${Date.now()}@medflow-test.example`;
const password = randomBytes(18).toString('base64url');
const created = await fetch(`${supa}/auth/v1/admin/users`, { method: 'POST', headers: { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password, email_confirm: true }) });
check('Supabase: owner login created', created.ok, `status ${created.status}`);
const setup = sql(`select app.setup_pharmacy('Cloud Test Pharmacy', 'Test Owner', '03001234567', '${email}', 'Karachi', 'CLD1', 'Main branch', 'basic') r`);
const tenant = setup[0]?.r?.tenant_id;
check('Supabase: pharmacy set up', !!tenant);

const browser = await chromium.launch({ channel: 'msedge', headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: path.join(here, `cloud-${n}.png`) }).catch(() => {});
try {
  const res = await page.goto(site);
  check('website: opens over HTTPS with security headers', res.ok() && !!res.headers()['content-security-policy'] && !!res.headers()['strict-transport-security']);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.locator('form button.btn.primary').click();
  const enroll = page.getByText('Set up 2-step sign-in');
  check('password accepted; 2-step sign-in setup shown', await enroll.waitFor({ timeout: 30_000 }).then(() => true, () => false));
  const secret = (await page.locator('code').first().textContent())?.trim() ?? '';
  await page.getByLabel('6-digit code').fill(totp(secret));
  await page.locator('form button.btn.primary').click();
  const office = await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 40_000 }).then(() => true, () => false);
  check('authenticator code accepted; back office opens', office);
  if (!office) await shot('after-2fa');

  // ---- Inventory into the cloud database ----
  await page.getByRole('button', { name: 'Products & stock' }).first().click();
  await page.getByRole('button', { name: 'Import from Excel' }).click();
  await page.locator('input[type=file]').setInputFiles(path.join(here, 'fixtures', 'inventory-karachi.csv'));
  await page.getByRole('button', { name: /^Import \d+ medicines$/ }).click();
  const done = await page.getByText('Stock added').waitFor({ timeout: 300_000 }).then(() => true, () => false);
  const stocked = done ? Number(await page.locator('.stat', { hasText: 'Stock added' }).locator('.stat-value').textContent()) : 0;
  check('cloud: inventory imported with stock', stocked > 100, `${stocked} medicines with stock`);
  if (done) await page.getByRole('button', { name: 'Done' }).click();
  const rows = sql(`select count(*)::int n from products where tenant_id = '${tenant}'`);
  check('cloud database holds the medicines', rows[0]?.n > 100, `${rows[0]?.n} products in Supabase`);

  // ---- Counter: owner PIN, link this PC, sell ----
  await page.getByRole('button', { name: 'Team' }).first().click();
  await page.getByRole('button', { name: 'Set PIN' }).first().click();
  await page.locator('.modal input.pin-input, [role=dialog] input.pin-input').fill('4826');
  await page.getByRole('button', { name: 'Save PIN' }).click();
  check('owner sets a counter PIN', await page.getByText('Set', { exact: true }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false));
  await page.getByRole('button', { name: 'New sale' }).last().click();
  await page.waitForTimeout(1500);
  await shot('counter-link');
  const link = page.getByRole('button', { name: 'Link this PC' });
  if (await link.isVisible().catch(() => false)) {
    const code = page.getByLabel('Counter code');
    if (!(await code.inputValue())) await code.fill('C1');
    const nm = page.getByLabel('Name');
    if (!(await nm.inputValue())) await nm.fill('Counter 1');
    await link.click();
  }
  const pinScreen = await page.getByText('Who is selling?').waitFor({ timeout: 40_000 }).then(() => true, () => false);
  check('this PC is linked as a counter (staff PIN screen)', pinScreen);
  if (!pinScreen) await shot('after-link');
  await page.locator('.pin-input').fill('4826');
  await page.keyboard.press('Enter');
  // The owner lands in the back office; the sale starts from New sale.
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30_000 }).catch(() => {});
  if (await page.getByRole('button', { name: 'New sale' }).last().isVisible().catch(() => false)) await page.getByRole('button', { name: 'New sale' }).last().click();
  await page.getByLabel('Opening cash (Rs)').fill('3000');
  await page.getByRole('button', { name: 'Open shift' }).click();
  const search = page.getByPlaceholder(/Scan barcode or type medicine/);
  await search.waitFor({ timeout: 30_000 });
  await search.fill('Panadol Tablets');
  await page.getByText('400 in stock').waitFor({ timeout: 20_000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  await page.keyboard.press('F12');
  const sold = await page.getByText('Sale complete').waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const bill = sold ? ((await page.getByText(/^Bill CLD1-/).first().textContent()) ?? '') : '';
  check('cloud: a sale completes at the counter', sold, bill.trim());
  if (!sold) await shot('after-sale');
  const inDb = sql(`select count(*)::int n from sales where tenant_id = '${tenant}'`);
  check('the sale is saved in the cloud database', inDb[0]?.n >= 1, `${inDb[0]?.n} sale(s) in Supabase`);

  // ---- Another pharmacy cannot see them (row-level security) ----
  const anon = keys.find((k) => k.name === 'anon')?.api_key;
  const leak = await fetch(`${supa}/rest/v1/products?select=id&limit=5`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } });
  const leaked = leak.ok ? (await leak.json()).length : 0;
  check('security: without signing in, no medicines can be read', leaked === 0, `status ${leak.status}, ${leaked} rows`);
  await shot('office');
  check('no errors in the browser', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check(`unexpected: ${e.message.split('\n')[0]}`, false);
  await shot('failure');
} finally {
  await browser.close();
}
// The test pharmacy is cancelled, then removed with its logins (cloud-cleanup.sql), so the cloud stays empty.
if (tenant) {
  try { sql(`update tenants set status = 'cancelled', name = 'TEST (cloud e2e) ' || name where id = '${tenant}'`); } catch { /* keep going */ }
  try { sql(fs.readFileSync(new URL('./cloud-cleanup.sql', import.meta.url), 'utf8')); } catch { /* keep going */ }
}
await fetch(`${supa}/auth/v1/admin/users/${(await (await fetch(`${supa}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, { headers: { apikey: service, Authorization: `Bearer ${service}` } })).json()).users?.find((u) => u.email === email)?.id}`,
  { method: 'DELETE', headers: { apikey: service, Authorization: `Bearer ${service}` } }).catch(() => {});
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
