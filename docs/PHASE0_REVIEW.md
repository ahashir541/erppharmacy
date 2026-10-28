# Phase 0 review — what to keep, structure, schema, questions

> **Status (2026-10-28):** the questions below have been answered. See
> decisions D11–D23 in [DECISIONS.md](DECISIONS.md). Migrations now live in
> `packages/db/supabase/migrations`. Phase 1 is described in [PHASE1.md](PHASE1.md).

This answers the "First task" in [MASTER_PROMPT.md](MASTER_PROMPT.md). No
feature code has been written. The schema is a **draft for your review** in
[packages/db/migrations](../packages/db/supabase/migrations). It has not been applied to
any Supabase project.

## (a) What in the current code can be kept

The brief requires TypeScript + Supabase + PowerSync + Tauri. The current repo
is Python/FastAPI + SQLAlchemy + a single-file React app + the Streamlit demo.
So almost nothing can be kept **as code**. Most of it can be kept **as a
specification**: it already encodes rules we must not lose.

| Current item | Verdict | Why |
|---|---|---|
| `backend/app/api/commerce.py` (sale checkout, FEFO, idempotency keys, credit-limit check, partial GRN receive, balanced manual journals, cash shift variance) | **Keep as spec, rewrite** | Logic moves to `packages/core` (TS) and Postgres RPCs. The idempotent checkout (`sale_fingerprint`) becomes UUIDv7 ids generated on the device plus `unique (device_id, local_seq)`. |
| `backend/tests/test_api.py` (10 tests, 714 lines) | **Keep as spec** | Each test becomes a Vitest or pgTAP case in Phase 1–3. |
| Access model in README (platform owner / pharmacy owner / staff; owner-only money; "hiding a button is not security") | **Keep** | Same as the brief. Now enforced by RLS, not only by API checks. |
| Manual JazzCash / Easypaisa / bank subscription payments with operator verification (`billing.py`, `platform.py`) | **Keep the flow** | Carried into `platform_invoices` + `platform_payments`. |
| Theme tokens and light/dark toggle in `frontend/src/styles.css` | **Reference only** | The new UI uses Tailwind + shadcn/ui. |
| `frontend/src/App.tsx` (1,187 lines, one file), `api.ts` | **Retire** | Replaced by `apps/web`, `apps/desktop` and the Supabase client. |
| `backend/` models and Alembic migrations | **Retire** | The schema is a rewrite. It used `numeric` money, UUIDv4, a mutable `batches.quantity` counter, one role enum and no branches. |
| `docker-compose.yml`, `Caddyfile`, `scripts/backup.py`, `scripts/restore.py` | **Retire** | Supabase backups and PITR, plus a nightly per-tenant export to R2/B2, replace the self-hosted stack. |
| `code.py`, `requirements.txt`, `.streamlit/` | **Retire** (per brief) | Only after the live Streamlit demo is taken down (Question 11). |
| `backend/medical_store_erp_api.egg-info/` | **Delete** | Build output that was committed by mistake. |
| `.gitignore`, `.github/workflows/ci.yml` | **Keep, rewrite** | Keep the CI shape. The jobs become pnpm/Turborepo lint, type-check, Vitest, pgTAP and Playwright. |
| `.env.example` | **Keep, rewrite** | Placeholders for the Supabase URL/anon key, PowerSync URL and Sentry DSN. |

Two things in the repo conflict with the brief:

- The brief says "Keep the Supabase project … already used by MedFlow". This
  repo has **no Supabase code or configuration** (Question 2).
- The README says the selected future setup was "one on-site server per
  pharmacy + LAN + VPN". The brief replaces this with cloud master + local
  SQLite + sync. I am following the brief.

## (b) Proposed folder structure

```
apps/
  desktop/            Tauri v2 + React counter app (Windows first)
    src/              screens only — no business rules
    src-tauri/        Rust: ESC/POS printing, cash-drawer kick, encrypted SQLite, updater
  web/                owner/manager web app + PWA (Cloudflare Pages)
  admin/              super-admin console (platform owner only)
packages/
  core/               pure TS business rules + Vitest: money, units/packs, FEFO,
                      pricing/discount limits, udhaar, permissions, invoice numbering
  db/
    supabase/         Supabase CLI project: config.toml, migrations/, functions/, tests/ (pgTAP)
    powersync/        sync rules (which tables/columns each principal downloads)
    src/              generated DB types + Zod schemas shared by client and server
  sync/               PowerSync client schema + upload connector (desktop and web)
  integrations/       TaxProvider (FBR, SRB, PRA), PaymentProvider, MessagingProvider
                      (WhatsApp/SMS), PrinterDriver — interfaces + adapters
  ui/                 shadcn/ui components, theme tokens, RTL + Noto Nastaliq Urdu
  i18n/               en / ur translation files
  config/             shared tsconfig, eslint, tailwind presets
legacy/               old backend/frontend/code.py, read-only, deleted after Phase 3 (Question 11)
docs/                 MASTER_PROMPT, PHASE0_REVIEW, DECISIONS, CHANGELOG
pnpm-workspace.yaml  turbo.json  package.json  .env.example  renovate.json
```

`sync`, `integrations`, `i18n` and `config` are additions to the brief's list.
They keep network and adapter code out of `core`, so `core` stays pure and
easy to test. The draft migrations are in `packages/db/migrations/` for now.
They move to `packages/db/supabase/migrations/` when Phase 1 sets up the
Supabase CLI.

## (c) Database schema (draft SQL)

13 migration files, about 3,300 lines, 120 tables in `public` (plus 2 in
`private`):

| File | Contents |
|---|---|
| [0001_foundation](../packages/db/supabase/migrations/202610280001_foundation.sql) | UUIDv7, generic triggers: `updated_at`, **no hard delete**, **append-only**, **audit** |
| [0002_tenancy](../packages/db/supabase/migrations/202610280002_tenancy.sql) | platform admins, features, plans, plan_features, tenants (full lifecycle), overrides, rollouts, platform audit log |
| [0003_organisation_access](../packages/db/supabase/migrations/202610280003_organisation_access.sql) | users, user_pins, branches (+ `warehouses` view), devices, device licences, settings, permissions, role templates, roles, user_roles per branch, per-user overrides, approvals, sessions, **audit_log**, API keys |
| [0004_platform_operations](../packages/db/supabase/migrations/202610280004_platform_operations.sql) | subscriptions, platform invoices/payments, app releases, announcements, global catalogue, global recalls, support tickets, consent grants, backups |
| [0005_catalogue](../packages/db/supabase/migrations/202610280005_catalogue.sql) | tax categories + rate history, generics, manufacturers, categories, units, products, pack ladder, barcodes, price history |
| [0006_parties](../packages/db/supabase/migrations/202610280006_parties.sql) | customer accounts (family/company), customers, credit-limit history, doctors, suppliers |
| [0007_stock](../packages/db/supabase/migrations/202610280007_stock.sql) | batches, cost layers, batch blocks (recall/owner), **stock_movements** ledger + trigger-cached **stock_balances**, counts (blind), transfers |
| [0008_sales_tax](../packages/db/supabase/migrations/202610280008_sales_tax.sql) | prescriptions, sales, sale_lines (per batch), owner-only line costs, payments, returns, held bills, sync flags, tax profiles, ordered tax queue |
| [0009_purchasing](../packages/db/supabase/migrations/202610280009_purchasing.sql) | POs, GRNs with bonus qty (cost kept apart in `grn_line_costs`), purchase invoices/returns, supplier claims |
| [0010_ledgers_money](../packages/db/supabase/migrations/202610280010_ledgers_money.sql) | **ledger_entries** for customers and suppliers, allocations, cached balances, counter-safe credit status, cheques, reconciliation, drawers, blind closing, **cash_movements**, expenses, payroll, GL with a balanced-journal check |
| [0011_compliance_engagement](../packages/db/supabase/migrations/202610280011_compliance_engagement.sql) | licences, **controlled drugs register view**, loyalty, message templates/outbox, reminders, refill list, alert rules, notifications, receipt templates, data exports |
| [0012_security](../packages/db/supabase/migrations/202610280012_security.sql) | identity helpers, **RLS on every table** (the migration fails if any table is missed), table → permission map, grants (clients cannot write tables directly) |
| [0013_seed_reference](../packages/db/supabase/migrations/202610280013_seed_reference.sql) | 88 permission switches, the brief's default role matrix, feature catalogue |

**Main design choices** (also logged in [DECISIONS.md](DECISIONS.md)):

1. **Money and quantities are `bigint`.** Money is in the minor unit;
   quantities are in the product's base unit (tablet). Rates are basis points.
   Nothing is `numeric` or `float`.
2. **Cost is in separate tables, not hidden columns.** `batch_cost_layers`,
   `grn_line_costs`, `sale_line_costs`, `drawer_session_reconciliations`,
   `stock_count_results`, `party_balances` and `money_balances` each have their
   own RLS. Row-level rules are much easier to prove with pgTAP than
   column-level grants, and PowerSync can leave whole tables out.
3. **Clients never write tables.** Reads use RLS. Writes go through
   `SECURITY DEFINER` RPCs or the PowerSync upload handler, which re-check
   permissions and raise `sync_flags` instead of rejecting a sale that has
   already happened.
4. **Composite tenant foreign keys** (`(tenant_id, x_id) → x (tenant_id, id)`):
   a row can never point at another tenant's row, even through a bug.
5. **Cost layers instead of a unit cost.** "10 + 1" bonus stock is stored as an
   exact total cost for the total quantity. A fractional unit cost is never
   stored.
6. **Counter device principal.** A counter signs in as itself and downloads
   only counter-safe data. Staff unlock it with a PIN (Question 1).
7. **Shops and warehouses share `branches`** (`kind`), with a `warehouses`
   view. `branch_licences` is the brief's `licences` table.
8. **Text + CHECK instead of Postgres enums**, so new statuses can be added in
   backward-compatible migrations.

**How it was checked.** All 13 migrations run in a real Postgres engine
(PGlite 0.2.17, with stand-ins for Supabase's `auth.uid()`/`auth.jwt()`). The
scenario test the Phase 0 smoke test (since replaced by the pgTAP suite in `packages/db/supabase/tests`)
then passes:

- Tenant B cannot read tenant A, even with a forged `tenant_id` claim.
- A salesman and a counter device see products and stock. They cannot see
  cost layers, trade prices, udhaar balances, the ledger, cash or the audit
  log. The salesman sees only allowed / not allowed for udhaar.
- The counter downloads PIN hashes only for staff allowed on it.
- Stock balance equals the sum of movements. Udhaar balance equals the sum of
  entries.
- UPDATE on a ledger and DELETE on products are refused. Direct INSERT by a
  client is refused. Inserts are audited. A recall freezes matching batches.
  An unbalanced GL journal fails at commit.

This is a smoke test, not the Phase 1 pgTAP suite, and it does not run on a
real Supabase project yet. To rerun it: `npm install @electric-sql/pglite@0.2.17`
in a scratch folder, then
`node check.mjs <path-to-packages/db/migrations> scenario.sql`.

**Deliberately not in the schema yet:**

- RPC functions such as `post_sale` and `receive_grn` (Phase 2–5 feature code)
- PowerSync sync rules (Phase 4)
- COGS calculation (Question 4)
- Monthly partitioning of `audit_log` and `stock_movements` (before launch)

## (d) Questions

The brief says "never invent business rules for money, stock or tax", so each
of these needs your answer. Questions 1, 2 and 11 block Phase 1. The others
block the phase shown.

1. **How do counters sign in?** (Phase 1)
   - *Recommended:* the counter PC signs in as a device. Staff unlock it with
     their PIN, offline included. Money data never reaches a counter, even
     when the owner is standing at it; the owner sees money on the web or
     phone app.
   - *Alternative:* every staff member has their own cloud login on the
     counter. This is harder offline and harder to make airtight when staff
     switch.
   - Either way, PIN hashes are stored on the counter so it can check PINs
     offline. A 4–6 digit PIN can be guessed if someone gets the raw database
     file. Protection: SQLCipher encryption with the key kept in Windows
     Credential Manager, plus lockout after failed tries. Is that acceptable?
2. **Supabase project.** The repo has no Supabase yet. Is there an existing
   project (URL, region)? If not, I'll create one. The Mumbai region is the
   nearest to Pakistan. A paid plan is needed for point-in-time recovery.
   (Phase 1)
3. **Udhaar headroom on the counter.** To decide offline whether a Rs 2,000
   credit fits, the counter needs `available_credit`. I propose syncing it but
   showing only "allowed / not allowed" unless `udhaar.view_balance` is on.
   OK? (Phase 5)
4. **Costing method for profit.** *Recommended:* weighted average within each
   batch. Alternatives: FIFO by receipt, or moving average per product. Bonus
   stock: spread the net cost over paid + bonus quantity (recommended), or
   count bonus at zero cost? (Phase 2)
5. **Bills visible on a counter.** The draft allows the branch's bills from
   the last 7 days, for reprints and returns while offline. Someone with
   database access could add those up. Alternatives: this device's bills only,
   or online-only lookup. Which, and how many days? (Phase 3)
6. **Permission limits.** If the owner has not set a limit, should the action
   need approval (recommended, fail closed)? Is the discount limit per line or
   per bill? Do daily limits reset at branch midnight? (Phase 1)
7. **Loose-unit prices and rounding.** When selling 3 tablets from a Rs 125
   strip of 10, does the owner set the tablet price, or is it calculated
   (12.50 each)? How are bill totals rounded: none, Re 1, Rs 5 or Rs 10?
   (Phase 3)
8. **Batch price vs list price.** If a batch carries its own printed retail
   price/MRP, does it beat the product price list at the counter?
   (Recommended: yes.) (Phase 2)
9. **Sales tax.** For taxable items (cosmetics, devices), are shelf prices tax
   inclusive? Should the FBR POS service charge per invoice appear on the
   bill? This needs your tax adviser. (Phase 7)
10. **Udhaar ageing.** Is ageing counted from the bill date or the due date?
    What is the due date when an account has no terms? (Phase 5)
11. **Legacy code and the live demo.** Should I move the old code to `legacy/`
    (recommended) or delete it now? Is the Streamlit Community Cloud demo
    live, and can it be taken down? (Phase 1)
12. **Data retention vs deletion.** The brief deletes a cancelled tenant 90
    days after cancellation. Pharmacies may have to keep sales, tax and
    controlled-drug records for years. Should we keep an encrypted archive
    for the legal period (who pays?), or only hand over the export and
    delete? This needs legal advice. (Phase 8)
13. **Invoice numbers.** Is `KHI1-C2-000451` (branch, counter, 6-digit
    sequence that never resets) OK, or should it reset yearly? FBR's own
    number is printed separately. (Phase 3)
