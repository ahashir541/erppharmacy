// End-to-end test of the built MedFlow Local in a real browser (Microsoft Edge on this PC):
// first-time setup, sign-in, importing the inventory file, opening a shift, selling, and the
// security headers. It runs the release build on a scratch data folder and a spare port, so it
// never touches a real pharmacy's data.
//
//   node e2e/medflow.e2e.mjs            (after `node build.mjs`; add --headed to watch)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.resolve(here, '../release/MedFlow');
const fixture = path.join(here, 'fixtures', 'inventory-karachi.csv');
const port = 5187;
const base = `http://localhost:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'medflow-e2e-'));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

if (!fs.existsSync(path.join(release, 'medflow-server.mjs'))) { console.error('Build first: node build.mjs'); process.exit(2); }
const server = spawn(process.execPath, ['medflow-server.mjs', '--port', String(port), '--data', path.join(scratch, 'data'), '--backups', path.join(scratch, 'backups')],
  { cwd: release, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);

for (let i = 0; ; i++) {
  try { if ((await fetch(`${base}/api/status`)).ok) break; } catch { /* starting */ }
  if (i > 90) { console.error('MedFlow did not start'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}

const browser = await chromium.launch({ channel: 'msedge', headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
const problems = [];
page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
page.on('pageerror', (e) => problems.push(e.message));

try {
  // ---- Security headers ----
  const res = await page.goto(base);
  const h = res.headers();
  check('security headers (CSP, nosniff, frame, referrer)', !!h['content-security-policy'] && h['x-content-type-options'] === 'nosniff'
    && h['x-frame-options'] === 'DENY' && !!h['referrer-policy']);

  // ---- First-time setup ----
  await page.getByText('Set up my pharmacy').click();
  await page.getByLabel('Pharmacy name *').fill('E2E Test Pharmacy');
  await page.getByLabel('City').fill('Karachi');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel("Owner's name *").fill('Test Owner');
  await page.getByLabel('Owner PIN (4–6 digits) *').fill('2580');
  await page.getByLabel('PIN again *').fill('2580');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Bill prefix *').fill('E2E');
  await page.locator('form button.btn.primary').click();
  await page.getByText('MedFlow is set up').waitFor({ timeout: 60_000 });
  check('setup finishes and says so', true);
  await page.getByRole('button', { name: 'Open MedFlow' }).click();

  // ---- Sign in with the keyboard (no on-screen keypad) ----
  await page.getByText('Who is selling?').waitFor();
  check('no on-screen PIN keypad', (await page.locator('.keys').count()) === 0);
  await page.locator('.pin-input').fill('1111');
  await page.keyboard.press('Enter');
  await page.getByText('Wrong PIN', { exact: false }).waitFor({ timeout: 10_000 }).then(() => check('wrong PIN refused', true), () => check('wrong PIN refused', false));
  await page.locator('.pin-input').fill('2580');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 20_000 });
  check('owner signs in to the back office', true);

  // ---- Import the inventory file with stock ----
  await page.getByRole('button', { name: 'Products & stock' }).first().click();
  await page.getByRole('button', { name: 'Import from Excel' }).click();
  await page.locator('input[type=file]').setInputFiles(fixture);
  const go = page.getByRole('button', { name: /^Import \d+ medicines$/ });
  await go.waitFor();
  const wanted = Number((await go.textContent()).match(/\d+/)[0]);
  await go.click();
  await page.getByText('Stock added').waitFor({ timeout: 180_000 });
  const stat = async (label) => Number(await page.locator('.stat', { hasText: label }).locator('.stat-value').textContent());
  const made = await stat('New medicines'); const stocked = await stat('Stock added'); const bad = await stat('Rows with problems');
  check('import: every medicine created with stock, no problem rows', made === wanted && stocked === wanted && bad === 0, `${made} made, ${stocked} stocked, ${bad} problems`);
  await page.getByRole('button', { name: 'Done' }).click();
  const panadol = await page.locator('table tbody tr', { hasText: 'Panadol Tablets' }).first().innerText();
  check('Panadol 500mg shows 400 tablets on the shelf', /\b400\b/.test(panadol), panadol.replace(/\s+/g, ' ').slice(0, 90));

  // ---- Logo goes to the dashboard ----
  await page.locator('.sidebar .brand-home').click();
  check('logo opens the dashboard', await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 10_000 }).then(() => true, () => false));

  // ---- Open a shift and sell ----
  await page.getByRole('button', { name: 'New sale' }).last().click();
  await page.getByLabel('Opening cash (Rs)').fill('5000');
  await page.getByRole('button', { name: 'Open shift' }).click();
  const search = page.getByPlaceholder(/Scan barcode or type medicine/);
  await search.waitFor({ timeout: 20_000 });
  await search.fill('Panadol Tablets');
  await page.getByText('400 in stock').waitFor({ timeout: 15_000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: process.env.E2E_SHOTS + '/e2e-1-search.png' });
  const total = (await page.locator('.grand, .total-row, :text("Total") + *').first().textContent().catch(() => '')) ?? '';
  await page.keyboard.press('F12');
  await page.waitForTimeout(3000);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: process.env.E2E_SHOTS + '/e2e-2-after-f12.png' });
  const done = await page.getByText('Sale complete').waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const bill = done ? ((await page.getByText(/^Bill E2E-/).first().textContent()) ?? '') : '';
  check('F12 completes the sale and shows the bill', done && /E2E-C1-0+1/.test(bill), bill.trim());
  await page.keyboard.press('Escape');
  // The sale must be saved: it shows under Sales & invoices in the back office.
  await page.getByRole('button', { name: 'Back office' }).click();
  await page.getByRole('button', { name: 'Sales & invoices' }).first().click();
  const row = page.locator('table tbody tr', { hasText: /E2E/ }).first();
  const saved = await row.waitFor({ timeout: 15_000 }).then(() => true, () => false);
  check('the sale is saved and listed under Sales & invoices', saved, saved ? (await row.innerText()).replace(/\s+/g, ' ').slice(0, 90) : total.trim().slice(0, 40));

  check('no errors in the browser console', problems.length === 0, problems.slice(0, 3).join(' | '));
} catch (e) {
  check(`unexpected: ${e.message.split('\n')[0]}`, false);
  await page.screenshot({ path: path.join(scratch, 'failure.png') }).catch(() => {});
  console.log(`screenshot: ${path.join(scratch, 'failure.png')}`);
} finally {
  await browser.close();
  stop();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
