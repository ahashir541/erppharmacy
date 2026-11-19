// A new pharmacy, start to finish, exactly as it will happen in real life:
//   HQ makes the pharmacy and its licence key → the delivery zip is unpacked on a "new PC" →
//   setup with the key → verified → import → sale → HQ sees the PC and its backup key →
//   invoice → pharmacy says "I have paid" → owner approves → suspend stops selling → back on →
//   the PC "dies": a second PC restores the encrypted backup with the key from HQ → cancel and delete.
// Runs a separate test HQ (with a copy of the real signing key, so the real zip's licence checks
// pass) and never touches C:\MedFlow or C:\MedFlowHQ.
//
//   node e2e/journey.e2e.mjs --keys <folder with signing-key.json>   (after build.mjs --zip and build-hq.mjs)
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
const zip = path.resolve(here, '../release/MedFlow-Local.zip');
const hqDir = path.resolve(here, '../release/MedFlowHQ');
const keysSrc = argv('keys');
if (!keysSrc || !fs.existsSync(path.join(keysSrc, 'signing-key.json'))) { console.error('Give --keys <the hq-keys folder>'); process.exit(2); }
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'medflow-journey-'));
const HQ = 'http://localhost:5298';
const PC1 = 'http://localhost:5186';
const PC2 = 'http://localhost:5185';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); return ok; };
const kids = [];
const run = (cmd, args, cwd) => { const p = spawn(cmd, args, { cwd, stdio: 'ignore' }); kids.push(p); return p; };
process.on('exit', () => kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } }));
const until = async (url, what) => {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`${what} did not start`);
};

// ---- A test HQ with the real signing key ----
fs.cpSync(keysSrc, path.join(S, 'hq-keys'), { recursive: true });
run(process.execPath, ['medflow-hq.mjs', '--port', '5298', '--data', path.join(S, 'hq-data'), '--keys', path.join(S, 'hq-keys'), '--backups', path.join(S, 'hq-backups')], hqDir);
await until(`${HQ}/hq/status`, 'Test HQ');
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };
await fetch(`${HQ}/hq/admin/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Owner', email: 'owner@test.local', password: 'journey-test-pass' }) });
const { token } = await j(await fetch(`${HQ}/hq/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.local', password: 'journey-test-pass' }) }));
const hq = async (fn, ...args) => {
  const r = await fetch(`${HQ}/hq/admin/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ fn, args }) });
  const b = await j(r); if (!r.ok) throw new Error(`${fn}: ${b.error ?? r.status}`); return b.r;
};
const made = await hq('platform_create_pharmacy', { name: 'Shifa Journey Pharmacy', city: 'Karachi', owner_name: 'Adeel', owner_phone: '03001234567', plan: 'basic', trial_days: 14 });
check('HQ: new pharmacy gets a licence key', /^MF-/.test(made.licence_key ?? ''), `key ${String(made.licence_key).slice(0, 7)}…`);

// ---- The delivery zip on a new PC ----
const unpack = (dir) => {
  execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`]);
  return path.join(dir, 'MedFlow');
};
const pc1 = unpack(path.join(S, 'pc1'));
check('zip: no data, settings or backup key inside', !['data', 'backups', 'config.json', 'backup-key.txt'].some((f) => fs.existsSync(path.join(pc1, f))));
const configure = (dir, port) => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, hqUrl: HQ, data: 'data', backups: 'backups' }));
configure(pc1, 5186);
run(path.join(pc1, 'node', 'node.exe'), ['medflow-server.mjs'], pc1);
await until(`${PC1}/api/status`, 'MedFlow on PC 1');
const st0 = await j(await fetch(`${PC1}/api/status`));
check('new PC: MedFlow starts and asks for setup, licensing on', st0.ready === false && st0.licensing === true);

const browser = await chromium.launch({ channel: 'msedge', headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
let captured = null;
page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/call')) { try { const b = JSON.parse(r.postData() ?? '{}'); if (b.fn === 'post_sale') captured = { body: b, headers: r.headers() }; } catch { /* other */ } } });
const shot = (n) => page.screenshot({ path: path.join(S, `${n}.png`) }).catch(() => {});

try {
  // ---- Setup with the licence key ----
  await page.goto(PC1);
  await page.getByText('Set up my pharmacy').click();
  await page.getByLabel('Pharmacy name *').fill('Shifa Journey Pharmacy');
  await page.getByLabel('City').fill('Karachi');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel("Owner's name *").fill('Adeel');
  await page.getByLabel('Owner PIN (4–6 digits) *').fill('4826');
  await page.getByLabel('PIN again *').fill('4826');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Bill prefix *').fill('SJP');
  await page.getByLabel(/Licence key from MedFlow/).fill(made.licence_key);
  await page.locator('form button.btn.primary').click();
  await page.getByText('MedFlow is set up').waitFor({ timeout: 90_000 });
  const verified = await page.getByText('Licence key verified').isVisible();
  check('setup with the licence key: "Licence key verified" shown', verified, (await page.locator('.licence-result').innerText().catch(() => '')).replace(/\s+/g, ' '));
  await page.getByRole('button', { name: 'Open MedFlow' }).click();

  await page.locator('.pin-input').fill('4826');
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor({ timeout: 30_000 });
  check('owner signs in', true);

  // ---- Import and sell ----
  await page.getByRole('button', { name: 'Products & stock' }).first().click();
  await page.getByRole('button', { name: 'Import from Excel' }).click();
  await page.locator('input[type=file]').setInputFiles(path.join(here, 'fixtures', 'inventory-karachi.csv'));
  await page.getByRole('button', { name: /^Import \d+ medicines$/ }).click();
  await page.getByText('Stock added').waitFor({ timeout: 180_000 });
  const stocked = Number(await page.locator('.stat', { hasText: 'Stock added' }).locator('.stat-value').textContent());
  check('inventory imported with stock', stocked > 100, `${stocked} medicines with stock`);
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: 'New sale' }).last().click();
  await page.getByLabel('Opening cash (Rs)').fill('3000');
  await page.getByRole('button', { name: 'Open shift' }).click();
  const search = page.getByPlaceholder(/Scan barcode or type medicine/);
  await search.waitFor({ timeout: 20_000 });
  await search.fill('Panadol Tablets');
  await page.getByText('400 in stock').waitFor({ timeout: 15_000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  await page.keyboard.press('F12');
  check('first sale completes', await page.getByText('Sale complete').waitFor({ timeout: 15_000 }).then(() => true, () => false));
  await page.keyboard.press('Escape');

  // ---- HQ sees the PC and keeps its backup key ----
  await page.getByRole('button', { name: 'Back office' }).click();
  await page.getByRole('button', { name: 'Settings' }).first().click();
  const shownKey = (await page.locator('code.key-code').first().textContent({ timeout: 15_000 }))?.trim() ?? '';
  check('owner sees the backup key in Settings', /^MFBK-[0-9A-F]{8}(-[0-9A-F]{8}){7}$/.test(shownKey));
  const d1 = await hq('platform_pharmacy', made.tenant_id);
  const inst = d1.installs?.[0];
  check('HQ: the PC checked in (version, PC name)', !!inst && !!inst.app_version, inst ? `v${inst.app_version} · ${inst.machine}` : 'no install');
  check('HQ: keeps the same backup key the owner sees', inst?.backup_key === shownKey);

  // ---- Billing: invoice → "I have paid" → approve ----
  await hq('platform_start_subscription', made.tenant_id, 'basic', 'monthly', 250000);
  await page.getByRole('button', { name: 'Check now' }).click();
  const payBtn = page.getByRole('button', { name: 'I have paid' }).first();
  const gotInvoice = await payBtn.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check('pharmacy sees the new invoice after "Check now"', gotInvoice);
  if (gotInvoice) {
    await payBtn.click();
    const modal = page.locator('.modal, [role=dialog]').last();
    await modal.getByLabel('Transaction ID / reference *').fill('JC-778899');
    const amount = modal.getByLabel('Amount (Rs)');
    if (!(await amount.inputValue())) await amount.fill('2500');
    await modal.locator('button.btn.primary').click();
    check('"I have paid" is sent, shows "Payment being checked"', await page.getByText('Payment being checked').waitFor({ timeout: 20_000 }).then(() => true, () => false));
    const d2 = await hq('platform_pharmacy', made.tenant_id);
    const pay = d2.payments?.find((p) => p.status === 'pending');
    check('HQ: the payment waits for approval', !!pay, pay ? `${pay.method} ${pay.reference} Rs ${pay.amount / 100}` : '');
    if (pay) await hq('platform_review_payment', pay.id, true, 'received');
    const d3 = await hq('platform_pharmacy', made.tenant_id);
    check('HQ: approving marks the invoice paid', d3.invoices?.[0]?.status === 'paid', d3.invoices?.[0]?.status);
  }

  // ---- Suspend stops selling; reactivating brings it back ----
  const hdr = captured ? { 'Content-Type': 'application/json', authorization: captured.headers.authorization, 'x-medflow-session': captured.headers['x-medflow-session'] } : null;
  let seq = 1;
  const sellViaApi = async () => {
    if (!captured) return { ok: false, status: 0, error: 'no sale captured' };
    const a = structuredClone(captured.body); const x = a.args[0];
    x.id = randomUUID(); x.local_seq = ++seq + 100; x.sold_at = new Date().toISOString(); x.lines = x.lines.map((l) => ({ ...l, id: randomUUID() }));
    const r = await fetch(`${PC1}/api/call`, { method: 'POST', headers: hdr, body: JSON.stringify(a) });
    return { ok: r.ok, status: r.status, error: r.ok ? '' : (await j(r)).error };
  };
  await hq('platform_set_tenant_status', made.tenant_id, 'suspended', 'journey test');
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.waitForTimeout(2500);
  const blocked = await sellViaApi();
  check('suspended in HQ → the pharmacy cannot sell', !blocked.ok, blocked.error);
  await hq('platform_set_tenant_status', made.tenant_id, 'active', 'journey test done');
  await page.getByRole('button', { name: 'Check now' }).click();
  await page.waitForTimeout(2500);
  const again = await sellViaApi();
  check('active again → selling works', again.ok, again.error);
  await shot('journey-settings');

  // ---- The PC dies: a new PC restores the encrypted backup with the key from HQ ----
  await page.getByRole('button', { name: 'Back up now' }).click();
  await page.waitForTimeout(4000);
  const bk = fs.readdirSync(path.join(pc1, 'backups')).filter((f) => f.endsWith('.enc')).sort().pop();
  check('backups are encrypted (.enc)', !!bk, bk);
  const pc2 = unpack(path.join(S, 'pc2'));
  configure(pc2, 5185);
  const keyFromHq = (await hq('platform_pharmacy', made.tenant_id)).installs?.[0]?.backup_key;
  const wrong = (() => { try { execFileSync(path.join(pc2, 'node', 'node.exe'), ['medflow-server.mjs', '--restore', path.join(pc1, 'backups', bk)], { cwd: pc2, stdio: 'pipe' }); return 'restored'; } catch (e) { return `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`; } })();
  check('new PC without the key: restore refused', /backup key|Wrong/i.test(wrong), wrong.split('\n').find((l) => /key/i.test(l))?.trim().slice(0, 90));
  execFileSync(path.join(pc2, 'node', 'node.exe'), ['medflow-server.mjs', '--restore', path.join(pc1, 'backups', bk), '--key', keyFromHq], { cwd: pc2, stdio: 'pipe' });
  run(path.join(pc2, 'node', 'node.exe'), ['medflow-server.mjs'], pc2);
  await until(`${PC2}/api/status`, 'MedFlow on PC 2');
  const st2 = await j(await fetch(`${PC2}/api/status`));
  check('new PC with the key from HQ: pharmacy restored', st2.ready === true && st2.pharmacy === 'Shifa Journey Pharmacy', `${st2.pharmacy}`);

  // ---- Leaving: cancel, then delete ----
  await hq('platform_set_tenant_status', made.tenant_id, 'cancelled', 'journey test');
  const del = await hq('platform_delete_pharmacy', made.tenant_id, 'Shifa Journey Pharmacy');
  const list = await hq('platform_pharmacies');
  check('cancel then delete removes it from HQ', !JSON.stringify(list).includes(made.tenant_id), `${del.rows} rows`);

  check('no errors in the browser', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (e) {
  check(`unexpected: ${e.message.split('\n')[0]}`, false);
  await shot('journey-failure');
  console.log(`screenshot: ${path.join(S, 'journey-failure.png')}`);
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed · test files in ${S}`);
kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } });
process.exit(failed ? 1 : 0);
