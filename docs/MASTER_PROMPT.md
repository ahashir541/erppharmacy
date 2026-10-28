# MedFlow Master Prompt — Pharmacy Management Platform

Source: "MedFlow Master Prompt — Pharmacy Management Platform" (Syed Hashir Ali,
28 Oct 2026). This is the project brief for coding agents. Build one phase at a
time from the last section; finish, test and commit a phase before starting the
next.

**Words used below.** Platform owner = the seller of MedFlow. Tenant = one
pharmacy business that buys MedFlow. Pharmacy owner = the tenant's boss.
Branch = one physical shop of a tenant. Udhaar = credit / khata.

**On "zero maintenance".** No software can promise it. The goal is software
that runs itself: automatic backups, automatic updates, self-healing sync,
health alerts, and settings the owner can change without a developer.

## Role, mission and product vision

You are a senior full-stack architect and product engineer who has shipped
retail POS and ERP systems used by thousands of shops. You write production
code, not demos. You are building MedFlow: a multi-tenant pharmacy management
platform sold as a subscription to many independent pharmacies and pharmacy
chains, starting in Pakistan and ready for other countries.

**Mission.** A pharmacy must be able to sell medicine all day even when the
internet is down, never lose a rupee of data, know exactly what every staff
member did, and let only the owner see money. The platform owner must be able
to onboard a new pharmacy in under 15 minutes and change features for all
customers without touching their computers.

**Target customers.**

- Single-counter neighbourhood medical stores (1 PC, 1 to 3 staff)
- Large Pakistani pharmacies and chains (5 to 50 branches, a central
  warehouse, 20 to 300 staff)
- International pharmacies later (other currencies, tax systems and languages)

**Product surfaces to build.**

1. Web app (browser, any device) for owners and managers, reports, settings,
   remote access from home.
2. Desktop app (Windows first) for the sales counter, works fully offline,
   talks to printers and barcode scanners.
3. Mobile app (Android first, PWA acceptable in v1) for the owner: live sales,
   alerts, udhaar, approvals.
4. Super-admin console for the platform owner only: tenants, licences,
   billing, feature flags, updates, support.

All four share one codebase for business logic and one database design.

**Non-negotiable qualities.** Offline-first, owner-controlled, auditable
(nothing is ever silently deleted), fast (a sale in under 3 seconds with a
scanner), simple enough for a counter salesman with basic literacy, bilingual
English and Urdu, and secure by default.

## Architecture: cloud and local, always in sync

Every device keeps its own local SQLite database and works from it; the cloud
Postgres database is the master copy, and a sync engine moves changes both
ways whenever internet is available.

**Tech stack (use exactly this unless told otherwise).**

| Layer | Choice | Why |
|---|---|---|
| Monorepo | TypeScript, pnpm workspaces + Turborepo | One language for every app; shared business logic package |
| Cloud database | Supabase (Postgres, Auth, Row Level Security, Storage, Edge Functions) | Managed backups; RLS isolates tenants |
| Sync engine | PowerSync (Supabase connector) | Purpose-built offline-first sync between Postgres and on-device SQLite, with partial sync per user |
| Counter app | Tauri v2 desktop (Windows first) + React | Small installer, auto-updater built in, direct printer/scanner access |
| Owner web app | React + Vite + Tailwind + shadcn/ui, hosted on Cloudflare Pages | Free tier, global CDN |
| Mobile | PWA in v1, Expo (React Native) in v2 using the same shared packages | |
| Validation | Zod schemas shared by client and server | One source of truth for data rules |
| Tests | Vitest (logic), Playwright (end-to-end), pgTAP (database policies) | |
| Errors / uptime | Sentry + a free uptime monitor | Alerts before customers call |

PowerSync ships last-write-wins conflict handling by default. Last-write-wins
is NOT safe for stock and money, so the rules below are mandatory.

**Sync rules that make conflicts harmless.**

1. **Ledgers, not counters.** Stock, cash and udhaar balances are never stored
   as a single number that devices overwrite. Every change is an append-only
   row (`stock_movements`, `cash_movements`, `ledger_entries`). Balances are
   computed (and cached in the cloud by a database trigger). Two counters
   selling offline both insert rows, and nothing is lost.
2. **No hard deletes.** Records are voided or archived with a reason and user;
   a reversing entry is posted.
3. **Offline-safe IDs.** All primary keys are UUIDv7 generated on the device.
   Invoice numbers use a per-device prefix plus a local sequence (e.g.
   `KHI1-C2-000451`) so two offline counters never clash.
4. **Master data** (products, prices, staff, settings) may use
   last-write-wins, but every change is also written to the audit log with old
   and new values.
5. **Server re-validation.** When an offline sale arrives, the cloud re-checks
   it (stock went negative? price below minimum? expired batch?) and raises a
   flag for the owner instead of rejecting it, because the medicine has
   already been handed over.
6. **Partial sync.** A device only downloads its own tenant and branch data,
   and a salesman's device never receives cost prices, profits or other
   branches' cash.
7. **Sync status is always visible** on screen: Synced, Syncing, Offline (with
   count of pending changes), or Needs attention.
8. **Multi-counter shops without internet (v2):** one PC can be set as the
   Branch Hub so other counters on the same Wi-Fi share stock in real time
   while the internet is down.

**Money and time.** Store money as integers in paisa (or the smallest unit of
the tenant's currency), never as floats. Store all times in UTC and show them
in the branch's time zone.

**Existing MedFlow repo.** Keep the Supabase project. Retire the Streamlit
demo. Move existing frontend and backend code into the monorepo structure:
`apps/desktop`, `apps/web`, `apps/admin`, `packages/core` (business rules),
`packages/db` (schema, migrations), `packages/ui`.

## Roles, permissions and owner-only money

The pharmacy owner holds every power and decides, permission by permission,
what each staff member can do; by default nobody except the owner can see
sales totals, profit, cost prices, cash balances or udhaar totals.

Enforce this in the database, not only the screen. Use Supabase Row Level
Security plus restricted views so a salesman's device never even downloads
cost or profit columns. Hiding a button is not security.

**Default roles (owner can rename, copy, edit or create new ones).**

| Permission | Owner | Manager | Pharmacist | Salesman | Store keeper | Accountant |
|---|---|---|---|---|---|---|
| Make sales, print bills | Yes | Yes | Yes | Yes | No | No |
| See today's sales total / profit | Yes | Off by default | No | No | No | Off by default |
| See cost price and margin | Yes | Off by default | No | No | No | Off by default |
| Give discount above limit | Yes | Up to limit set by owner | Up to limit | Needs approval | No | No |
| Void bill / accept return | Yes | Needs approval | Needs approval | Needs approval | No | No |
| Edit sale price | Yes | Off by default | No | No | No | No |
| Receive purchases, stock adjust | Yes | Yes | No | No | Yes | No |
| Customer / supplier udhaar | Yes | Give only, within limit | No | Give only, within limit | No | View |
| Supplier payments, expenses | Yes | Off by default | No | No | No | Off by default |
| Reports | All | Only what owner ticks | Expiry, stock | None | Stock | Only what owner ticks |
| Staff, roles, settings, backups | Yes | No | No | No | No | No |

**Owner control features.**

- Around 60 granular permission switches (e.g. `sales.view_totals`,
  `product.view_cost`, `udhaar.give`, `udhaar.limit_override`) grouped by
  module, each with an optional limit (amount, percentage, per day).
- Approvals: risky actions (big discount, void, return, price change, udhaar
  over limit, negative stock sale) send a request to the owner's phone; owner
  approves with one tap or enters a PIN at the counter.
- Blind cash closing: at shift end the salesman counts and enters cash without
  seeing the expected amount; only the owner sees the difference (short /
  over).
- Login controls: personal 4 to 6 digit PIN per staff, auto-lock after idle,
  allowed devices, allowed hours, allowed branches. Owner can log anyone out
  remotely and disable a staff member instantly.
- Live activity feed for the owner: who sold what, discounts, voids, drawer
  opens without a sale.
- Multiple owners / partners supported, each with full or chosen rights; one
  is marked Primary Owner who can never be locked out.
- Owner recovery: two-factor login, recovery codes, and a verified phone
  number.
- Platform owner support can never see a tenant's financial data without the
  pharmacy owner granting temporary access from settings.

## Core modules

The heart of the product is a fast counter, batch-and-expiry-aware stock, and
purchasing that keeps shelves full without dead stock.

**1. Point of sale (counter).**

- Search by barcode, brand name, generic (salt) name, or first letters typed
  in English or Urdu; show stock, rack location and nearest expiry while
  typing.
- Sell by strip, tablet (loose), box, bottle; units and pack sizes defined per
  product (e.g. 1 box = 10 strips = 100 tablets).
- Automatic FEFO: the batch expiring first is sold first; expired batches are
  blocked from sale.
- Substitute suggestion: if out of stock, show other brands with the same
  generic and strength.
- Hold bills, multiple open bills, split payment (cash, card, JazzCash,
  Easypaisa, bank transfer, udhaar), change calculation.
- Customer optional; with customer: name, phone, doctor, prescription photo,
  loyalty points.
- Returns and exchanges against the original bill, restocked to the original
  batch.
- Prints on 80 mm / 58 mm thermal printers and A4; bill shows FBR/SRB invoice
  number and QR when integrated; can also send bill by WhatsApp or SMS.
- Keyboard-first: every action has a shortcut (F2 new bill, F4 pay, F8 hold,
  etc.).

**2. Products and inventory.**

- Product master: brand, generic, strength, form, manufacturer, category,
  schedule / controlled flag, Rx-required flag, barcode(s), HSN/tax category,
  rack, min/max stock, reorder level.
- Seed with an importable medicine catalogue (CSV/Excel import with mapping
  screen); tenants can add their own.
- Batches with batch number, expiry, purchase price, MRP / retail price, trade
  price, quantity, supplier.
- Multi-branch and warehouse stock, stock transfers with send/receive
  confirmation.
- Stock counts (full or cycle count by rack), with variance report visible
  only to owner.
- Expiry dashboard: expired, expiring in 30 / 60 / 90 days, with one-click
  "return to supplier" or "mark for disposal".
- Price updates in bulk (by manufacturer or percentage), with history.

**3. Purchasing and suppliers.**

- Supplier / distributor master with contact, credit terms, and company list
  they supply.
- Smart reorder list: suggests quantities from last 30 / 60 / 90 days of
  sales, current stock, lead time and min/max.
- Purchase orders sent by WhatsApp / PDF; goods received note (GRN) against
  PO, with bonus quantity ("10 + 1") and scheme discounts handled correctly in
  cost.
- Purchase invoice entry, including scanning supplier invoices (photo upload,
  later AI extraction).
- Purchase returns (expired, damaged, short-dated) creating supplier credit.

**4. Customers and patients.**

- Customer profile, purchase history, regular medicines, refill reminders by
  SMS/WhatsApp (opt-in).
- Loyalty points and member discounts, configurable by owner.
- Doctor list and prescription records.

## Udhaar (credit) system: customers and suppliers

Udhaar is a double-entry ledger per person: every credit sale, payment, return
and adjustment is a dated entry, and the balance is always the sum of entries,
never a typed number.

**Customer udhaar (people who owe the pharmacy).**

- Customer khata with name, phone, CNIC (optional), address, photo, guarantor
  (optional), and credit limit set by owner.
- Sale on udhaar: full or partial (e.g. Rs 3,000 bill, Rs 1,000 paid, Rs 2,000
  udhaar). Bill marked clearly as credit.
- Credit limit check at the counter; over-limit needs owner approval. Owner
  can block a customer from udhaar.
- Receive payment: cash, JazzCash, Easypaisa, bank; can apply to oldest bills
  first or to a chosen bill.
- Due dates and ageing: 0 to 30, 31 to 60, 61 to 90, 90+ days.
- Reminders by WhatsApp / SMS on a schedule the owner sets, in Urdu or
  English, with a statement PDF link.
- Customer statement (khata print) for any date range; OTP or signature
  confirmation on large credit sales (optional setting).
- Family / company accounts: one account, many people allowed to buy on it
  (e.g. a clinic, a factory, a household).
- Write-off (bad debt) only by owner, with reason, kept in audit log.

**Supplier udhaar (what the pharmacy owes distributors).**

- Every purchase invoice on credit increases supplier payable; payments,
  returns, scheme claims and discounts reduce it.
- Payment terms per supplier (e.g. 15 / 30 days) and a payables calendar: what
  is due today, this week, overdue.
- Record payments by cash, cheque (with cheque number, date, status: pending,
  cleared, bounced), bank transfer.
- Supplier statement and reconciliation screen: match their statement line by
  line, mark differences.
- Claims tracking: expired-goods returns and promised schemes still owed by
  the supplier.

**Visibility rules.** Only the owner (and roles the owner ticks) sees total
receivables, total payables and individual balances. A salesman can give
udhaar within limit and see only "allowed / not allowed" for that customer,
not the amount owed, unless the owner switches `udhaar.view_balance` on.

## Finance, reports and analytics

The owner opens the app and within 5 seconds sees today's sales, profit, cash
in drawers, udhaar given and collected, and anything suspicious, for every
branch.

**Money tracking.**

- Cash drawers per counter: opening float, cash sales, cash udhaar
  collections, payouts, expenses, closing count, short/over.
- Bank and wallet accounts (JazzCash, Easypaisa, bank) with balances from
  entries.
- Expenses with categories (rent, salaries, electricity, generator fuel, tea),
  receipt photo, recurring expenses.
- Staff salaries and advances, deducted automatically from salary.
- Simple double-entry general ledger underneath (sales, COGS, inventory,
  receivables, payables, cash, expenses) so an accountant can export a trial
  balance; the owner never has to understand accounting.

**Owner dashboard (owner-only by default).** Sales, gross profit and margin
today / week / month vs last period; branch comparison; top products by
revenue and by profit; slow movers and dead stock value; expiring stock value;
udhaar receivable and supplier payable; cash short/over by staff; discounts
and voids by staff.

**Reports (all exportable to PDF and Excel, filter by date, branch, staff).**

| Area | Reports |
|---|---|
| Sales | Daily sales, sales by product / category / manufacturer / staff / hour, returns, discounts, voids |
| Profit | Profit by bill, product, category, branch; profit and loss statement |
| Stock | Stock valuation (cost and retail), stock movement, dead stock, near-expiry, expired, variance after count |
| Purchases | Purchases by supplier, price change history, bonus/scheme received |
| Udhaar | Receivables ageing, payables ageing, collection report, customer and supplier statements |
| Staff | Sales per staff, short/over, attendance (login/logout times) |
| Tax | FBR/SRB invoice log, sales tax summary, failed-to-report invoices |
| Controlled drugs | Register of controlled drug receipts and sales |

**Alerts to the owner's phone (each switchable on/off).** Low stock on key
items, expiring batches, large discount or void, cash short above threshold,
udhaar over limit, a device offline for more than X hours, a sale of a
controlled drug, daily summary at closing time.

**Smart features (v2, behind feature flags).** Demand forecasting for
reorders, supplier price comparison, natural-language questions ("which
products lost money this month?") answered from the tenant's own data, AI
reading of supplier invoice photos.

## Compliance: tax, drug rules and audit

Big Pakistani pharmacies will not buy software without FBR POS integration, so
build a pluggable tax module from day one, with FBR (federal) and SRB / PRA
(provincial) as the first plug-ins.

FBR has been expanding mandatory POS integration for Tier-1 retailers, the
Finance Bill 2026 proposed penalties for businesses that fail digital
integration from 1 July 2026, and a February 2026 draft notification requires
POS systems to transmit invoice data securely and receive a unique FBR invoice
number back. Retailers have complained about POS failures and wrongful
disconnections, which is the reliability gap MedFlow should close. Confirm
current technical specs with FBR's POS integration pages and a tax adviser
before going live.

**Tax module requirements.**

- Each sale is queued and sent to the tax authority API; the returned invoice
  number and QR code are printed on the bill.
- Offline: invoices queue locally with a clear "pending FBR" mark and are sent
  automatically, in order, once online; retry with backoff; owner alerted if
  anything is stuck more than X hours.
- Per-tenant settings: NTN, STRN, POS ID, provincial registration, tax rates
  per product category (many medicines are exempt; supplements, cosmetics and
  devices may be taxed).
- Tax adapters behind one interface (`TaxProvider`) so new countries (e.g.
  UAE, Saudi e-invoicing) are added without touching POS code.

**Drug rules.**

- Provincial Drug Sale Rules require pharmacies to keep records of
  controlled-substance sales.
- Products flagged controlled or Rx-required force: prescription capture
  (photo + doctor name + patient name), quantity limits set by owner, and a
  pharmacist's confirmation.
- Automatic controlled drugs register: date, supplier or patient, prescriber,
  quantity in/out, running balance; printable in inspector format. Keep
  records at least the legally required period (configurable; default 5
  years).
- Licence details (drug sale licence number, qualified person, expiry) stored
  per branch, with renewal reminders.
- Recall / banned-batch alert: platform owner can push a batch-number block to
  all tenants; matching stock is frozen instantly.

**Audit trail (everyone, everything).** Every create, edit, void, price
change, permission change, login and export is logged with user, device,
branch, time, old value and new value. The log is append-only, cannot be
edited by anyone including the owner, and is viewable by the owner with
filters.

## Super-admin console: selling to 50+ pharmacies

The platform owner controls every tenant's licence, plan, features and
software version from one private console, without visiting any pharmacy and
without seeing their financial data.

**Multi-tenancy.** One shared Supabase database, every row carries `tenant_id`
(and `branch_id` where relevant), and RLS policies make cross-tenant reads
impossible. Write pgTAP tests proving tenant A can never read tenant B. A very
large chain can later be moved to its own dedicated database with the same
schema.

**Tenant lifecycle.**

1. Create tenant: business name, owner name, phone, email, city, country,
   currency, language, plan.
2. Owner gets an invite link, sets password and 2FA, and a setup wizard walks
   them through branches, counters, staff, product import, opening stock and
   opening udhaar balances.
3. Trial (e.g. 14 days) then Active, Grace period (e.g. 7 days after missed
   payment, with warnings), Read-only (can view and export, cannot sell),
   Suspended, Cancelled (data export offered, kept 90 days, then deleted).
4. A pharmacy must never be cut off mid-day: read-only mode starts at closing
   time, and offline counters keep a signed licence token valid for a set
   number of days.

**Plans and licensing (prices set in the console, not in code).**

| Plan | Example limits | Example features |
|---|---|---|
| Basic | 1 branch, 2 counters, 5 staff | POS, stock, expiry, udhaar, basic reports |
| Pro | 3 branches, 10 counters, 25 staff | + FBR/SRB, owner mobile app, approvals, WhatsApp reminders |
| Enterprise | Unlimited / custom | + warehouse, transfers, API access, AI features, dedicated support |

Limits and features are stored as data (plan → feature flags and limits) and
can be overridden per tenant (e.g. give one pharmacy an extra counter free).

**Feature flags and remote control.** Turn any module on or off for all
tenants, one plan, one tenant, or a percentage rollout; push announcements and
in-app notices; push global data (medicine catalogue updates, banned batches,
tax rate changes); set the minimum allowed app version.

**Billing.** Subscription invoices per tenant, payment recording (bank
transfer, JazzCash, card gateway later), automatic reminders, revenue
dashboard (MRR, active tenants, churn, overdue).

**Support tools.** Tenant health page (last sync per device, app versions,
error count, FBR queue status, storage used), impersonation only with the
tenant owner's time-limited consent and fully logged, and a support ticket
inbox fed by an in-app "Help" button that attaches device logs.

**White-label (Enterprise).** A chain can have its own logo, colours and bill
header; the platform remains MedFlow's.

## Low-maintenance engineering: runs itself

Build the system so routine problems fix themselves or alert the platform
owner before a pharmacy notices, and so every future change is a safe,
reversible push.

**Backups (three layers).**

1. Cloud: Supabase daily backups plus point-in-time recovery on the paid plan;
   plus a nightly encrypted export of each tenant to separate storage (e.g.
   Cloudflare R2 or Backblaze B2), kept 30 days.
2. Local: every counter keeps its SQLite database; the desktop app writes an
   encrypted local backup daily and keeps 7.
3. Owner: one-click "Export all my data" (Excel + JSON) at any time. Owners
   own their data.

Test restoring a tenant from backup once a month with an automated script.

**Updates without visiting shops.**

- Desktop app uses Tauri's built-in auto-updater with signed releases; updates
  download in the background and install at next start or after closing time,
  never mid-sale.
- Release channels: Internal → Beta (2 or 3 friendly pharmacies) → Stable.
  Roll back to the previous version from the console.
- Database migrations are backward-compatible (add columns, never rename or
  drop in the same release) so old and new app versions can sync at the same
  time.

**Self-healing.**

- Sync retries automatically; a corrupted local database is detected and
  re-downloaded from the cloud while unsent local changes are preserved.
- FBR queue retries and reconciles itself.
- Health check endpoint and uptime monitor; Sentry error alerts; weekly
  automated report of errors by tenant.

**Change-friendly design.**

- Business rules live in `packages/core` with unit tests; screens never
  contain business logic.
- Settings, plans, permissions, tax rates, bill layouts and reminder templates
  are data, editable in the admin or owner settings, not hard-coded.
- Bill / receipt templates use a simple template editor so each pharmacy
  customises header, footer, logo and fields.
- Plug-in points: `TaxProvider`, `PaymentProvider`, `MessagingProvider`
  (WhatsApp, SMS), `PrinterDriver`.
- Public REST API with API keys (Enterprise) so other systems can integrate.
- Every PR runs lint, type-check, unit tests, RLS tests and Playwright smoke
  tests in GitHub Actions; nothing merges if red.

**Security.** HTTPS everywhere, local SQLite encrypted at rest, secrets never
in the repo, 2FA for owners and super-admin, rate limiting on login, session
revocation, dependency updates by Renovate/Dependabot weekly, and a yearly
review of RLS policies.

## Data model

Every table has `id` (UUIDv7), `tenant_id`, `created_at`, `updated_at`,
`created_by`, `device_id`, and `deleted_at` / `voided_at` where relevant;
money columns are integers in the smallest currency unit. Design the full
schema as SQL migrations in `packages/db` before writing screens, and show it
for review.

| Group | Tables |
|---|---|
| Platform (super-admin) | tenants, plans, plan_features, tenant_feature_overrides, subscriptions, platform_invoices, app_releases, global_catalogue, global_recalls, support_tickets |
| Organisation | branches, warehouses, devices (counters), branch_licences, settings (key/value per tenant and branch) |
| People and access | users, roles, role_permissions, user_roles (per branch), approval_requests, sessions, audit_log (append-only) |
| Catalogue | products, generics, manufacturers, categories, units, product_units (pack conversions), barcodes, product_prices (history), tax_categories |
| Stock | batches, stock_movements (append-only: purchase, sale, return, transfer, adjust, expire, dispose), stock_counts, stock_count_lines, transfers, transfer_lines, stock_balances (cached by trigger) |
| Sales | sales, sale_lines (with batch_id), sale_payments, sale_returns, return_lines, held_bills, prescriptions, tax_submissions (queue + FBR response) |
| Purchasing | suppliers, purchase_orders, po_lines, grns, grn_lines (with bonus qty), purchase_invoices, purchase_returns, supplier_claims |
| Parties and udhaar | customers, customer_accounts (family/company), doctors, ledger_entries (party_type customer/supplier, debit, credit, reference), credit_limits, reminders_log, cheques |
| Money | cash_drawers, drawer_sessions (open/close, counted, expected), cash_movements, bank_accounts, expenses, expense_categories, salaries, staff_advances, gl_accounts, gl_entries |
| Compliance | controlled_drug_register (view over stock_movements + prescriptions), licences |
| Loyalty and messaging | loyalty_rules, loyalty_points, message_templates, outbound_messages |

Sensitive columns (cost price, profit, cash totals, ledger balances) are only
exposed through views and RPC functions that check the caller's permission.
PowerSync sync rules must not include them for roles without access.

## UI, language and hardware

The counter screen must be usable by a new salesman after 10 minutes of
training, and the owner screens must look like premium software a chain would
pay for.

**Design.**

- Clean, calm, professional look: one accent colour, large readable numbers,
  light and dark mode, consistent shadcn/ui components. A distinctive look,
  not a generic template.
- Counter screen: search bar always focused, bill on the right, big totals,
  colour cues (red = expired/blocked, amber = near expiry, green = paid).
- Every list has search, filters, sort, column choice and export.
- Empty states that teach ("No suppliers yet — add your first supplier").
- Works on 1366×768 office monitors, touch screens, tablets and phones.

**Language and locale.**

- Full English and Urdu (right-to-left layout, Noto Nastaliq Urdu font),
  switchable per user; product names can have an Urdu alias.
- All text in translation files (i18n), ready for Arabic and other languages.
- Currency, number format (lakh/crore option), date format and time zone per
  tenant.

**Hardware support.**

- USB / Bluetooth barcode scanners (keyboard-wedge mode works with zero
  setup).
- Thermal receipt printers 58 mm and 80 mm via ESC/POS, plus normal A4
  printers; label printer for shelf / price labels with barcodes.
- Cash drawer kick through the receipt printer.
- Optional: customer-facing second display showing the bill.

**Accessibility and speed.** Keyboard shortcuts on every counter action,
visible focus states, under 200 ms search results on 50,000 products on a
basic Core i3 PC with 4 GB RAM.

## Build phases, acceptance tests and agent rules

Build in eight phases; finish, test and commit each one before starting the
next, and stop after each phase to show what was built and how to run it.

1. **Foundation.** Monorepo, Supabase schema and migrations, RLS with tenant
   isolation tests, auth (owner email + 2FA, staff PIN), roles and permissions
   engine, audit log. *Done when:* pgTAP tests prove tenant A cannot read
   tenant B and a salesman cannot read cost columns.
2. **Catalogue and stock.** Products, units, batches, CSV import, stock
   movements ledger, stock balances, expiry dashboard. *Done when:* importing
   10,000 products works and stock always equals the sum of movements.
3. **Counter POS (online).** Sales, FEFO, returns, held bills, split payments,
   thermal printing, shortcuts. *Done when:* a 5-item sale with a scanner
   takes under 10 seconds end to end.
4. **Offline sync.** PowerSync on desktop, local SQLite, offline invoice
   numbering, sync status, server re-validation flags. *Done when:* two
   counters sell the same product offline for an hour, reconnect, and stock
   and cash are exactly right with no lost sale.
5. **Purchasing and udhaar.** Suppliers, POs, GRN with bonus, purchase
   invoices and returns, customer and supplier ledgers, limits, reminders,
   statements. *Done when:* a customer statement and a supplier statement
   match the ledger to the paisa.
6. **Owner control and finance.** Approvals to phone, blind cash closing,
   expenses, dashboard, reports, alerts, owner PWA. *Done when:* a salesman
   account cannot see any total anywhere, including through the API.
7. **Compliance.** Tax provider interface, FBR/SRB adapters with offline
   queue, controlled drugs register, prescriptions, licences, recalls. *Done
   when:* invoices sent offline reach the tax API in order after
   reconnecting.
8. **Super-admin and launch.** Tenant lifecycle, plans and feature flags,
   billing, health page, auto-updater with channels, backups and restore test,
   Urdu translation, onboarding wizard. *Done when:* a new pharmacy goes from
   sign-up to first sale in under 15 minutes.

**Rules for the coding agent.**

- Ask before choosing anything not specified here; never invent business
  rules for money, stock or tax.
- Write tests with every feature; never mark a phase done with failing tests.
- Small commits with clear messages; one feature per branch; update
  `docs/CHANGELOG.md` and `docs/DECISIONS.md`.
- Never store secrets in code; use `.env.example` with placeholders.
- Never hard-delete business data; never store money as floats; never trust
  the client for permissions.
- Explain each phase in simple words for a beginner: what was built, how to
  run it, how to test it by hand.
- Seed a demo tenant ("Demo Pharmacy", 2 branches, 500 products, 30 days of
  sales) for testing and sales demos.

**First task.** Read this whole document, read the existing repository, then
reply with: (a) what in the current code can be kept, (b) the proposed folder
structure, (c) the full database schema as SQL for review, and (d) any
questions. Do not write feature code until the schema is approved.
