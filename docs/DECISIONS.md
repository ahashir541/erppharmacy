# Decisions

Each entry: what was decided, why, and its status.

On 2026-10-28 the platform owner (Syed Hashir Ali) answered the Phase 0
questions. He decided who can sign in from where (D11) and delegated
everything else: "do what is best, no need to ask". Entries marked
**Delegated** were decided by the coding agent under that delegation. Where
possible they are stored as settings, so the owner can change them later
without a developer. Tax and legal items still need a tax adviser / lawyer
before go-live.

## 2026-10-28 — Phase 0 schema (Accepted)

- **D1. Integers for money and quantity.** Money is `bigint` in the currency's
  minor unit. Quantities are `bigint` in the product's base unit. Rates are
  basis points. *Why:* the brief forbids floats, and integers make "balance =
  sum of ledger rows" exact.
- **D2. Sensitive values live in separate tables** (cost layers, GRN line
  costs, sale line costs, drawer reconciliations, count results, cached
  balances). *Why:* row-level security on whole tables is simple to prove
  with pgTAP, and PowerSync can leave whole tables out of a device's sync.
- **D3. No direct client writes.** RLS is read-only. Writes go through
  definer RPCs and the sync upload handler. *Why:* "never trust the client";
  offline uploads must be re-validated and flagged, not blindly applied.
- **D4. Composite tenant foreign keys** on every tenant-owned relation.
  *Why:* a cross-tenant reference cannot exist even if application code is
  wrong.
- **D5. Batch cost as layers** (total cost + total quantity per receipt).
  *Why:* bonus stock ("10 + 1") would otherwise need a fractional unit cost.
- **D6. Counter devices are their own principal**, unlocked by staff PIN.
  *Why:* lets the counter work offline with any staff member while never
  downloading money data. Confirmed by D11.
- **D7. Shops and warehouses share `branches`** with a `kind` column, and
  `warehouses` is a view.
- **D8. Status columns are text + CHECK**, not Postgres enums, so adding a
  value stays a backward-compatible migration.
- **D9. Monorepo additions** `packages/sync`, `packages/integrations`,
  `packages/i18n` and `packages/config`, on top of the brief's list.
- **D10. Follow the brief's cloud + sync architecture**, replacing the
  README's earlier "one on-site server per pharmacy" plan.

## 2026-10-28 — Answers to the Phase 0 questions

- **D11. Who signs in where (Q1, owner's decision).**
  - Platform owner (Syed Hashir Ali): cloud sign-in from anywhere to the
    super-admin console, with 2FA.
  - Pharmacy owners and partners: cloud sign-in (email + 2FA) from anywhere
    (web, phone, home), and also on the pharmacy counter PC.
  - All other staff: no cloud account. They can only work on a registered
    pharmacy PC, unlocked with their PIN. Enforced in the database: only
    `kind = 'owner'` users may have an `auth_user_id`.
  - When an owner signs in on a counter PC, money screens are fetched online
    with the owner's own session and kept in memory only. Money data is never
    written to the counter's local database, so staff using that PC later
    cannot find it.
- **D12. Supabase (Q2, Delegated).** One new Supabase project in the Mumbai
  region (closest to Pakistan), Pro plan for point-in-time recovery. The
  agent cannot create accounts, so the platform owner creates the project
  (steps in `packages/db/README.md`). Until then everything runs and is
  tested locally.
- **D13. Udhaar headroom at the counter (Q3, Delegated).** `available_credit`
  is synced so the counter can decide offline. The counter UI shows only
  "allowed / not allowed" unless the user has `udhaar.view_balance`.
- **D14. Costing (Q4, Delegated).** COGS = weighted average cost within each
  batch, from its cost layers. Bonus stock shares the net cost: unit cost =
  line net ÷ (paid + bonus quantity). Rounding is to the nearest paisa per
  sale line.
- **D15. Bills on a counter (Q5, Delegated).** A counter can see its branch's
  bills from the last N days for reprints and offline returns. Setting
  `pos.recent_bills_days`, default 7. Older bills are looked up online.
- **D16. Permission limits (Q6, Delegated; revised in Phase 2).** A blank
  limit means no limit. A limit of 0 means every use needs approval. Where
  the brief says "up to the limit set by the owner" (manager and pharmacist
  discounts, manager and salesman udhaar), the default role starts at 0, so
  nothing is given without approval until the owner sets a limit. *Why the
  revision:* "blank = approval" also blocked plain "Yes" permissions that
  carry a daily count, such as the store keeper's stock adjustments.
  Discount limits are a percentage of the whole bill. Daily limits reset at
  midnight in the branch's time zone.
- **D17. Loose units and rounding (Q7, Delegated).** The loose-unit price is
  the pack price ÷ pack factor, rounded half-up to the paisa, unless the
  owner sets an explicit price for that unit. Bill grand total is rounded to
  the nearest Re 1 (setting `pos.bill_rounding_minor`, default 100).
- **D18. Batch price wins (Q8, Delegated).** A batch's own retail price (as
  printed on the pack) is used at the counter. Otherwise the product price
  list applies.
- **D19. Sales tax (Q9, Delegated, needs tax adviser).** Shelf prices of
  taxable items include tax (setting per tax category). The FBR POS service
  charge per invoice is configurable and off by default.
- **D20. Udhaar ageing (Q10, Delegated).** Ageing counts from the due date.
  When the account has no terms, due date = bill date + 30 days (setting
  `udhaar.default_due_days`).
- **D21. Legacy code (Q11, Delegated).** The old FastAPI backend, React
  frontend, Streamlit `code.py` and the self-hosted Docker/Caddy stack move to
  `legacy/` for reference. They will be deleted once Phase 3 reaches parity.
  The committed `egg-info` build output is deleted. Taking the Streamlit
  Community Cloud app offline must be done by the owner in its dashboard.
- **D22. Retention (Q12, Delegated, needs lawyer).** When a tenant cancels,
  live data is removed after 90 days, as the brief says. Before that, an
  encrypted archive is kept for 6 years (setting), so records the pharmacy
  may legally need can be restored on request.
- **D23. Invoice numbers (Q13, Delegated).** `<branch>-<counter>-<6+ digit
  sequence>`, never reset. The FBR number is printed separately.

## 2026-10-28 — Phase 1

- **D24. pgTAP tests run in two places.** CI runs them in real Postgres with
  pgTAP through the Supabase CLI. On a PC without Docker, `pnpm test:db` runs
  the same files in PGlite (embedded Postgres) with a small pgTAP-compatible
  shim. *Why:* fast local feedback with no Docker, and the real test in CI.
- **D25. Staff PINs are hashed with PBKDF2-SHA256** (600,000 iterations,
  16-byte salt). It is available in WebCrypto (browsers), Node and Deno
  without native code, and the counter can verify it offline. 5 wrong tries
  lock the PIN for 15 minutes.
