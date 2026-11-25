// 1.1.0 Owner live view, end to end against the real Nuskha Cloud:
//  1. the shop has no internet: live view on, the shop still sells, Settings says "no internet";
//  2. internet back (restart with the real cloud): the copy arrives; the owner's view page opens
//     with the code and shows the pharmacy, today's sales and "Live view";
//  3. a new code locks the old one out; "Turn off" deletes the copy.
// Run after `node build.mjs`: node e2e/v110.e2e.mjs (E2E_SHOTS=<folder>). The owner's laptop is a second, fresh Nuskha.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const release = path.resolve(here, '../release/Nuskha');
const fixture = path.join(here, 'fixtures', 'inventory-karachi.csv');
const argv = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const port = 5191;
const base = `http://localhost:${port}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nuskha-110-'));
const shots = process.env.E2E_SHOTS;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

let server = null;
// The server keeps mirror.json next to its program files (home); give it its own copy of the release.
const home = path.join(scratch, 'Nuskha');
fs.cpSync(release, home, { recursive: true });
async function startServer(offline) {
  const env = { ...process.env };
  if (offline) env.NUSKHA_CLOUD_URL = 'http://127.0.0.1:9';   // nothing listens there: "no internet"
  else delete env.NUSKHA_CLOUD_URL;
  server = spawn(process.execPath, ['medflow-server.mjs', '--port', String(port), '--data', path.join(scratch, 'data'), '--backups', path.join(scratch, 'backups')],
    { cwd: home, stdio: 'ignore', env });
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/status`)).ok) return; } catch { /* starting */ }
    if (i > 90) throw new Error('Nuskha did not start');
    await new Promise((r) => setTimeout(r, 1000));
  }
}
// The owner's home laptop: the same Nuskha, installed fresh (no pharmacy on it).
const homePort = 5192;
const homeDir = path.join(scratch, 'HomeNuskha');
fs.cpSync(release, homeDir, { recursive: true });
const homeServer = spawn(process.execPath, ['medflow-server.mjs', '--port', String(homePort), '--data', path.join(scratch, 'home-data'), '--backups', path.join(scratch, 'home-backups')],
  { cwd: homeDir, stdio: 'ignore' });
process.on('exit', () => { try { homeServer.kill(); } catch { /* gone */ } });
const stopServer = async () => { try { server?.kill(); } catch { /* gone */ } await new Promise((r) => setTimeout(r, 2500)); };
process.on('exit', () => { try { server?.kill(); } catch { /* gone */ } });

const browser = await chromium.launch({ channel: 'msedge', headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
const signIn = async () => {
  await page.goto(base);
  await page.locator('.pin-input').fill('2580');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30_000 });
};
// Settings > Owner's laptop (a section of its own since 1.1.0).
const ownerPanel = () => page.locator('.settings-body section.panel').first();
let code = '';
let viewer = null;

try {
  // ---- 1. No internet at the shop ----
  await startServer(true);
  await page.goto(base);
  await page.getByText('Set up my pharmacy').click();
  await page.getByLabel('Pharmacy name *').fill(`Live View Test ${Date.now() % 100000}`);
  await page.getByLabel('City').fill('Multan');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel("Owner's name *").fill('Owner');
  await page.getByLabel('Owner PIN (4–6 digits) *').fill('2580');
  await page.getByLabel('PIN again *').fill('2580');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Bill prefix *').fill('LV');
  await page.locator('form button.btn.primary').click();
  await page.getByText('Nuskha is set up').waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Open Nuskha' }).click();
  await page.locator('.pin-input').fill('2580');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Products & stock' }).first().click();
  await page.getByRole('button', { name: 'Import from Excel' }).click();
  await page.locator('input[type=file]').setInputFiles(fixture);
  await page.getByRole('button', { name: /^Import \d+ medicines$/ }).click();
  await page.getByText('Stock added').waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.locator('.settings-tab', { hasText: "Owner's laptop" }).click();
  await ownerPanel().getByRole('button', { name: 'Turn on live view' }).click();
  await ownerPanel().locator('code').waitFor({ timeout: 60_000 });
  code = (await ownerPanel().locator('code').innerText()).trim();
  if (shots) {
    for (const [tab, file] of [["Owner's laptop", 'settings-owner'], ['Backups', 'settings-backups'], ['Licence & updates', 'settings-licence'], ['Pharmacy', 'settings-pharmacy'], ['Alerts', 'settings-alerts']]) {
      const t = page.locator('.settings-tab', { hasText: tab });
      if (await t.count()) { await t.click(); await page.waitForTimeout(800); await page.screenshot({ path: path.join(shots, `110-${file}.png`) }); }
    }
    // Dark mode: Settings, Dashboard and Products, then back to light.
    await page.locator('.settings-tab', { hasText: 'Display & keys' }).click();
    await page.locator('.theme-pick.dark').click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, '110-dark-settings.png') });
    await page.getByRole('button', { name: 'Dashboard' }).first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(shots, '110-dark-dashboard.png') });
    await page.getByRole('button', { name: 'Products & stock' }).first().click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(shots, '110-dark-products.png') });
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.locator('.settings-tab', { hasText: 'Display & keys' }).click();
    await page.locator('.theme-pick.light').click();
    await page.locator('.settings-tab', { hasText: "Owner's laptop" }).click();
  }
  check('live view turns on and shows a view code', /^NSK(-[A-Z2-9]{4}){4}$/.test(code), code);
  check('Settings says there is no internet right now', await ownerPanel().getByText(/No internet right now/).waitFor({ timeout: 15_000 }).then(() => true, () => false));

  await page.getByRole('button', { name: 'New sale' }).last().click();
  await page.getByLabel('Opening cash (Rs)').fill('5000');
  await page.getByRole('button', { name: 'Open shift' }).click();
  const search = page.getByPlaceholder(/Scan barcode or type medicine/);
  await search.waitFor({ timeout: 20_000 });
  await search.fill('Panadol Tablets');
  await page.getByText(/in stock/).first().waitFor({ timeout: 15_000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await page.keyboard.press('F12');
  check('the shop sells with no internet', await page.getByText('Sale complete').waitFor({ timeout: 15_000 }).then(() => true, () => false));

  // ---- 2. Internet is back ----
  await stopServer();
  await startServer(false);
  await signIn();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.locator('.settings-tab', { hasText: "Owner's laptop" }).click();
  const sent = await ownerPanel().getByText(/Last sent/).waitFor({ timeout: 10_000 }).then(async () => {
    // The panel refreshes itself every 30 s; the first push goes 15 s after Nuskha starts.
    for (let i = 0; i < 40; i++) {
      const t = await ownerPanel().innerText();
      if (!/Not yet/.test(t) && !/No internet right now/.test(t)) return true;
      await page.waitForTimeout(3000);
    }
    return false;
  }, () => false);
  check('internet back: the copy reaches Nuskha Cloud', sent);

  viewer = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  viewer.on('pageerror', (e) => problems.push(`view: ${e.message}`));
  await viewer.goto(`http://localhost:${homePort}`);
  await viewer.getByText('I am the owner, at home').click({ timeout: 90_000 });
  await viewer.getByPlaceholder('NSK-XXXX-XXXX-XXXX-XXXX').fill(code.toLowerCase());
  await viewer.getByRole('button', { name: 'Open my pharmacy' }).click();
  const live = viewer.locator('.live-banner');
  check('owner view opens with the code', await live.waitFor({ timeout: 30_000 }).then(() => true, () => false), await live.innerText().catch(() => ''));
  check('owner sees the dashboard', await viewer.getByRole('heading', { name: 'Dashboard' }).isVisible());
  check('no "New sale" button in the owner view', (await viewer.getByRole('button', { name: 'New sale' }).count()) === 0);
  await viewer.getByRole('button', { name: 'Sales & invoices' }).first().click();
  const bill = viewer.locator('table tbody tr', { hasText: /LV-C1-0+1/ }).first();
  check("owner sees today's bill made offline", await bill.waitFor({ timeout: 15_000 }).then(() => true, () => false));
  if (shots) await viewer.screenshot({ path: path.join(shots, '110-owner-view.png') });
  await viewer.getByRole('button', { name: 'Products & stock' }).first().click();
  check('owner sees products and stock', await viewer.locator('table tbody tr', { hasText: 'Panadol' }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));

  // ---- 2b. Owner signs in with the PIN from home and changes a price; the shop PC has it ----
  await viewer.getByRole('button', { name: /Make changes/ }).click();
  await viewer.getByPlaceholder('Owner PIN').fill('2580');
  await viewer.getByRole('button', { name: 'Sign in' }).click();
  check('owner signs in from home with the PIN', await viewer.getByText('Owner, from home').waitFor({ timeout: 60_000 }).then(() => true, () => false));
  await viewer.getByRole('button', { name: 'Products & stock' }).first().click();
  const prow = viewer.locator('table tbody tr', { hasText: 'Panadol Tablets' }).first();
  await prow.waitFor({ timeout: 60_000 });
  await prow.getByRole('button', { name: 'Edit' }).click();
  const stockBox = viewer.getByLabel(/Stock on the shelf now/);
  await stockBox.waitFor({ timeout: 60_000 });
  await stockBox.fill('123');
  await viewer.getByLabel(/Why the stock changed/).fill('changed from home');
  await viewer.getByRole('button', { name: 'Save changes' }).click();
  const saved = await viewer.getByLabel(/Stock on the shelf now/).waitFor({ state: 'detached', timeout: 90_000 }).then(() => true, () => false);
  if (shots) await viewer.screenshot({ path: path.join(shots, '110-owner-home-edit.png') });
  // At the shop: Products shows the new stock.
  await page.getByRole('button', { name: 'Products & stock' }).first().click();
  const shopRow = page.locator('table tbody tr', { hasText: 'Panadol Tablets' }).first();
  await shopRow.waitFor({ timeout: 20_000 });
  check('a change made from home is on the shop PC', saved && /\b123\b/.test(await shopRow.innerText()), (await shopRow.innerText()).replace(/\s+/g, ' ').slice(0, 90));
  let homeShows = false;
  for (let i = 0; i < 20 && !homeShows; i++) {
    await viewer.getByRole('button', { name: 'Dashboard' }).first().click();
    await viewer.getByRole('button', { name: 'Products & stock' }).first().click();
    const r = viewer.locator('table tbody tr', { hasText: 'Panadol Tablets' }).first();
    homeShows = await r.waitFor({ timeout: 30_000 }).then(async () => /\b123\b/.test(await r.innerText()), () => false);
    if (!homeShows) await viewer.waitForTimeout(3000);
  }
  check("the owner's laptop shows the change too", homeShows);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.locator('.settings-tab', { hasText: "Owner's laptop" }).click();

  // ---- 3. New code, then off ----
  await ownerPanel().getByRole('button', { name: /New pharmacy code/ }).click();
  let newCode = code;
  for (let i = 0; i < 30 && newCode === code; i++) { await page.waitForTimeout(2000); newCode = (await ownerPanel().locator('code').innerText()).trim(); }
  await viewer.reload();
  check('a new code locks the old laptop out', newCode !== code && await viewer.getByPlaceholder('NSK-XXXX-XXXX-XXXX-XXXX').waitFor({ timeout: 90_000 }).then(() => true, () => false), newCode);
  await ownerPanel().getByRole('button', { name: /Turn off/ }).click();
  await ownerPanel().getByRole('button', { name: 'Turn on live view' }).waitFor({ timeout: 30_000 });
  await viewer.getByPlaceholder('NSK-XXXX-XXXX-XXXX-XXXX').fill(newCode);
  await viewer.getByRole('button', { name: 'Open my pharmacy' }).click();
  check('turned off: the copy is gone from the cloud', await viewer.getByText(/not right, or the shop turned sharing off/).waitFor({ timeout: 20_000 }).then(() => true, () => false));
  check('no errors in the browser', problems.length === 0, problems.join(' | '));
} catch (e) {
  check('run', false, e.message);
} finally {
  await browser.close();
  await stopServer();
  try { homeServer.kill(); } catch { /* gone */ }
  console.log(`\n${results.filter(Boolean).length} passed, ${results.filter((x) => !x).length} failed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}
