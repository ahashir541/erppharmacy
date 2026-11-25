// 1.0.3 client feedback, checked in the real program: search-first delivery entry with the
// supplier's discount and no expiry, the POS "Complete sale" button in view on a 1366×768 laptop,
// and a sale that still completes when its bill number was already used on this PC.
// Run after `node build.mjs`: node e2e/v103.e2e.mjs  (E2E_SHOTS=<folder> saves screenshots)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.resolve(here, '../release/Nuskha');
const fixture = path.join(here, 'fixtures', 'inventory-karachi.csv');
const port = 5189;
const base = `http://localhost:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nuskha-103-'));
const shots = process.env.E2E_SHOTS;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const server = spawn(process.execPath, ['medflow-server.mjs', '--port', String(port), '--data', path.join(scratch, 'data'), '--backups', path.join(scratch, 'backups')],
  { cwd: release, stdio: 'ignore' });
process.on('exit', () => { try { server.kill(); } catch { /* gone */ } });
for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* starting */ }
  if (i > 90) { console.error('Nuskha did not start'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}

const browser = await chromium.launch({ channel: 'msedge', headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
let captured = null;
page.on('request', (r) => {
  if (!r.url().endsWith('/api/call')) return;
  try { const b = JSON.parse(r.postData() ?? '{}'); if (b.fn === 'post_sale') captured = { body: b, headers: r.headers() }; } catch { /* other */ }
});

try {
  await page.goto(base);
  await page.getByText('Set up my pharmacy').click();
  await page.getByLabel('Pharmacy name *').fill('Feedback Pharmacy');
  await page.getByLabel('City').fill('Lahore');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel("Owner's name *").fill('Owner');
  await page.getByLabel('Owner PIN (4–6 digits) *').fill('2580');
  await page.getByLabel('PIN again *').fill('2580');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Bill prefix *').fill('FB');
  await page.locator('form button.btn.primary').click();
  await page.getByText('Nuskha is set up').waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Open Nuskha' }).click();
  await page.locator('.pin-input').fill('2580');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Products & stock' }).first().click();
  check('Products page says "Add product"', await page.getByRole('button', { name: '+ Add product' }).isVisible());
  await page.getByRole('button', { name: 'Import from Excel' }).click();
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ medicines$/ }).click();
  await page.getByText('Stock added').waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Done' }).click();

  // ---- Supplier with its usual 13% discount ----
  await page.getByRole('button', { name: 'Suppliers' }).first().click();
  await page.getByRole('button', { name: '+ New supplier' }).click();
  await page.getByLabel('Name *').fill('Adeel Distributors');
  await page.getByLabel('Usual discount %').fill('13');
  await page.getByRole('button', { name: 'Save supplier' }).click();
  const supRow = page.locator('table tbody tr', { hasText: 'Adeel Distributors' });
  await supRow.waitFor();
  check('supplier saved with 13% discount', /13%/.test(await supRow.innerText()));

  // ---- Receive delivery: search, Enter, quantity, Ctrl+S. No batch, no expiry. ----
  await page.getByRole('button', { name: 'Purchases' }).first().click();
  await page.getByRole('button', { name: '+ Receive delivery' }).click();
  await page.getByLabel('Supplier *').selectOption({ label: 'Adeel Distributors · 13% off' });
  check('supplier discount fills in', (await page.getByLabel('Supplier discount %').inputValue()) === '13');
  const box = page.getByPlaceholder(/Search product/);
  await box.click();
  await box.fill('Panadol Tab');
  await page.locator('.grn-search .results li').first().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  const qty = page.locator('.grn-table tbody tr').first().locator('input').first();
  await qty.waitFor();
  check('Enter adds the product and puts the cursor on Qty', await qty.evaluate((el) => el === document.activeElement));
  const unit = await page.locator('.grn-table tbody tr').first().locator('select').inputValue();
  check('unit is filled in (never empty)', !!unit);
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  check('Enter after Qty goes back to the search box', await box.evaluate((el) => el === document.activeElement));
  const cost = page.locator('.grn-table tbody tr').first().locator('input').nth(2);
  await cost.fill('100');
  if (shots) await page.screenshot({ path: path.join(shots, '103-receive-delivery.png') });
  const totalText = await page.locator('.grand-mini strong').innerText();
  check('13% off: 20 × Rs 100 = Rs 1,740', /1,740/.test(totalText), totalText);
  await page.keyboard.press('Control+s');
  const delivered = page.locator('table tbody tr', { hasText: 'Adeel Distributors' }).first();
  check('delivery saved without batch or expiry', await delivered.waitFor({ timeout: 15_000 }).then(() => true, () => false),
    await delivered.innerText().catch(() => (page.locator('.form-error').innerText().catch(() => ''))));

  // ---- POS: Complete sale in view, and a used bill number does not stop the sale ----
  await page.getByRole('button', { name: 'New sale' }).last().click();
  await page.getByLabel('Opening cash (Rs)').fill('5000');
  await page.getByRole('button', { name: 'Open shift' }).click();
  const search = page.getByPlaceholder(/Scan barcode or type medicine/);
  const sell = async () => {
    await search.waitFor({ timeout: 20_000 });
    await search.fill('Panadol Tablets');
    await page.getByText(/in stock/).first().waitFor({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
  };
  await sell();
  const btn = page.locator('.pay-sticky');
  const r = await btn.boundingBox();
  if (shots) await page.screenshot({ path: path.join(shots, '103-pos.png') });
  check('Complete sale is on screen without scrolling (1366×768)', !!r && r.y + r.height <= 768, r ? `bottom at ${Math.round(r.y + r.height)} px` : 'not found');
  await btn.click();
  await page.getByText('Sale complete').waitFor({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  // Another window on this PC takes bill no. 2 behind the POS's back.
  const hdr = { 'Content-Type': 'application/json', authorization: captured.headers.authorization, 'x-medflow-session': captured.headers['x-medflow-session'] };
  const body = structuredClone(captured.body);
  const sale = body.args.find((a) => a && typeof a === 'object' && 'local_seq' in a);
  sale.id = crypto.randomUUID(); sale.local_seq = 2;
  for (const l of sale.lines ?? []) if (l.id) l.id = crypto.randomUUID();
  for (const p of sale.payments ?? []) if (p.id) p.id = crypto.randomUUID();
  const other = await fetch(`${base}/api/call`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
  check('another window used bill no. 2', other.ok, String(other.status));
  await sell();
  await btn.click();
  const ok = await page.getByText('Sale complete').waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const bill = ok ? ((await page.getByText(/^Bill FB-/).first().textContent()) ?? '') : await page.locator('.message, .form-error').first().innerText().catch(() => '');
  check('the next sale still completes, with the next free number', ok && /FB-C1-0+3/.test(bill), bill.trim());
  // Return: just the last digits find the bill.
  await page.keyboard.press('Escape');
  await page.keyboard.press('F11');
  await page.getByPlaceholder(/last digits/).fill('3');
  await page.getByRole('button', { name: 'Find bill' }).click();
  check('return finds a bill from its last digits (3 -> FB-C1-000003)', await page.getByText(/FB-C1-0+3/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await page.keyboard.press('Escape');
  check('no errors in the browser', problems.length === 0, problems.join(' | '));
} catch (e) {
  check('run', false, e.message);
} finally {
  await browser.close();
  console.log(`\n${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
