# Changelog

## Unreleased

### MedFlow HQ: sell MedFlow on monthly plans (2026-11-18)

- D57. `apps/hq` (your console) and `apps/server/src/hq.ts` (your server): add a pharmacy and get
  its licence key (copy or WhatsApp), plans and prices, per-pharmacy features and limits, status
  (trial, active, grace, read-only at closing time, suspended), billing with invoices, payment
  references from pharmacies and "Money received", announcements, last check-in and version per PC,
  block a PC, new key. Guide: `docs/MEDFLOW_HQ.md`.
- Migration 0028: licence keys (hash only), installs, `platform_create_pharmacy`,
  `hq_checkin` and `hq_submit_payment` (service role only), console reads. 30 new database checks.
- MedFlow Local: licence key in the setup wizard and Settings, check-in at start, every 6 hours
  and on "Check now", signed licence verified with HQ's public key, status and features mirrored
  into the local database, 15 days offline, 7 days without a key, a licence bar on every screen,
  MedFlow invoices and "I have paid" in Settings. Builds without `hq.json` have licensing off.

### MedFlow Local: free, permanent, on the shop PC (2026-11-17)

- The owner's decision (D56): run MedFlow on the pharmacy's own main PC instead of
  a paid cloud. `apps/server` is a small Node server with the same database
  (PGlite) kept on disk in `C:\MedFlow\data`; it serves the app to every counter
  on the shop network. Counters prove who they are with a token issued when the
  owner links them by PIN; back-office calls also need an owner session on that
  counter. Row Level Security and the database permissions apply as on the cloud.
- First start: a setup wizard (pharmacy, owner and PIN, bill prefix, this PC) or
  the Demo Pharmacy. New counter PCs: open the address in Settings, enter a name
  and the owner's PIN.
- Backups every night and at start-up when the last is a day old, newest 30 kept,
  optional second copy (`copyTo`, e.g. a Google Drive folder), "Back up now" in
  Settings, `Restore-Backup.ps1` (today's data is moved aside, never deleted).
- `pnpm --filter @medflow/server build -- --zip` builds `MedFlow-Local.zip` with
  Node included; `Install-MedFlow.ps1` installs it, starts it with Windows
  (restarting by itself), opens the network port and adds desktop icons.
- Import medicines from Excel (.xlsx) or CSV, a permission editor per role, and a
  physical stock count screen. Demo PIN hints show only for the Demo Pharmacy.

### No tax, no FBR (2026-11-17)

- The owner's decision (D55): MedFlow has no sales tax and no link to FBR or
  any tax authority. Removed the tax queue, the tax profiles, the FBR adapter
  (`packages/tax`), the `tax-worker` Edge Function, the tax permissions, the
  `tax_integration` feature, the tax category import column, tax lines on
  receipts, the tax column in the sales report and the tax line in the trial
  balance. Bills always have tax 0; reported-bill voids work again.

### Phase 7 — Compliance (2026-11-16)

- Prescriptions (`save_prescription`, `confirm_prescription`, or embedded in
  a sale), `controlled_register`, branch licences, platform recalls that
  freeze matching batches (also ones received later).
- `run_scheduled_checks`: licences, offline PCs, expiring batches, low stock,
  expired approvals.
- `get_receipt` checks visibility itself and logs counter reprints;
  service-only functions revoked from signed-in users.
- Tests: `12_compliance`.

### Phase 6 — Owner control and finance (2026-11-16)

- Bill amounts are no longer readable by signed-in clients; owners use the
  `owner_sales` / `owner_sale_lines` / `owner_sale_payments` /
  `owner_sale_returns` / `owner_return_lines` views. `get_receipt` still
  returns one bill. Counter sync rules no longer download bill amounts.
- Approvals: `request_approval`, `decide_approval`, `approve_at_counter`,
  `cancel_approval`, with notifications to the people who may approve.
- Alerts (large discount, void, cash short, controlled sale, flags) with
  `set_alert_rule`; notifications and push subscriptions.
- Expenses, recurring expenses, salaries and staff advances.
- Owner dashboard and reports (sales, payments, profit, P&L, stock value,
  dead stock, purchases, collections, staff, activity feed, trial balance).
- Tests: `11_owner_control` (59 checks) and a column-by-column check that a
  counter PC reads no money totals.

### Phase 5 — Purchasing and udhaar (2026-11-09)

- Suppliers, purchase orders (WhatsApp text), goods received with bonus and
  expiry checks, supplier invoices checked against the paper total, cost
  layers (bonus lowers cost), purchase returns with claims and credit notes.
- Customer accounts and members, opening balances, credit limits, blocking,
  write-offs, udhaar payments at the counter (no balance on the receipt).
- Supplier payments, allocations to chosen bills, cheques (clear, bounce,
  cancel), open bills, ageing, statements, supplier statement matching,
  udhaar reminders (queued for WhatsApp).
- Document numbers per pharmacy (`PO-`, `GRN-`, `PR-`, `C-`).
- `app.party_balance_mismatches()` self-check.
- Tests: `10_purchasing_udhaar` (64 checks) and a 400-document random ledger test.

### Phase 4 — Offline sync (2026-11-09)

- Counter outbox (`packages/sync`): every counter action is a numbered
  command made on the PC; the bill is computed locally with the shared maths.
- `public.apply_device_commands`: replays a PC's commands in order, once.
  Offline rule breaks are flagged; commands that can't be applied are kept as
  `rejected` with their error and flagged; one bad command never blocks the rest.
- `device_commands` table, `devices.last_command_seq`, `sale_lines.branch_id`.
- PowerSync sync rules (`packages/db/powersync/sync-rules.yaml`), checked on
  every test run for money tables and columns.
- Sync status label (Synced / Syncing / Offline · N waiting / Needs attention).
- Two-counters-offline acceptance test; `09_sync` pgTAP tests.
- Fix: return flags now carry their message.

### Phase 3 — Counter sales (2026-11-09)

- Bill maths (discounts shared to the paisa, inclusive/exclusive tax, Re 1
  rounding, split payments, change, udhaar) in `packages/core` and SQL, with
  a 3,000-bill parity test; FEFO allocation; thermal receipt and ESC/POS.
- `post_sale` / `app.record_sale` (online rejects, offline flags), `void_sale`,
  `post_return`, `open_drawer` / `close_drawer` (blind), `get_receipt`.
- Prices: the batch's printed price wins, else the list price converted to
  the pack size sold. Cost of goods per line from the batch's cost layers.
- New flag kind `drawer_closed`.
- Demo Pharmacy seed (2 branches, 500 products, 30 days of sales), loaded by
  `supabase db reset` and tested with `--demo`.

### Phase 2 — Catalogue and stock (2026-10-28)

- Product import (10,000 rows per call, idempotent, per-row errors, wrong
  barcodes refused), CSV parsing and column mapping in `packages/core`.
- Product edits, pack sizes, price history, bulk price change.
- Opening stock, adjustments with daily limits and one-time approvals,
  write-offs, batch blocks, blind stock counts.
- Views: current prices, product stock with nearest expiry, expiry dashboard.
- Balance self-check and repair. PC actions run as the signed-in staff
  member (`app.rpc_actor`).
- D16 revised (blank limit = no limit, 0 = always ask).

### Phase 1 — Foundation (2026-10-28)

- Monorepo: pnpm workspaces + Turborepo; `packages/core`, `packages/db`,
  `packages/config`.
- Old FastAPI/React/Streamlit code moved to `legacy/`. Committed `egg-info`
  build output deleted.
- Schema moved into the Supabase CLI layout (`packages/db/supabase`), with
  hardened auth settings: invitation-only sign-up, TOTP 2FA, 12+ character
  passwords, custom access token hook.
- Cloud sign-in is limited to owners with 2FA. Staff work only on registered
  pharmacy PCs with a PIN (D11).
- Permissions engine in SQL and TypeScript, with a parity test (5,280
  combinations).
- Server functions for onboarding, staff, roles, permission overrides, PINs,
  devices, staff sessions, PIN lockout, settings and activity logging. Plan
  limits are enforced.
- Edge Functions `invite-owner` and `register-device` (not yet run).
- Tests: 5 pgTAP files (131 assertions) run locally in PGlite and in CI on
  real Supabase. 28 Vitest tests for core.
- New CI workflow for the monorepo and Supabase pgTAP.
- Docs: `PHASE1.md`, decisions D11–D25.

### Phase 0 — review draft (2026-10-28)

- Project brief, review document, draft schema and smoke test.
