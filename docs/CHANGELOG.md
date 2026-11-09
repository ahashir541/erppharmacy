# Changelog

## Unreleased

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
