# Decisions

Each entry: what was decided, why, and its status. "Proposed" entries wait
for the platform owner's approval of the Phase 0 schema review.

## 2026-10-28 — Phase 0 schema draft (Proposed)

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
  The COGS method is still open (Question 4).
- **D6. Counter devices are their own principal**, unlocked by staff PIN.
  *Why:* lets the counter work offline with any staff member while never
  downloading money data. Pending Question 1.
- **D7. Shops and warehouses share `branches`** with a `kind` column, and
  `warehouses` is a view. *Why:* stock, transfers and permissions work the
  same for both.
- **D8. Status columns are text + CHECK**, not Postgres enums. *Why:* adding
  a value stays a backward-compatible migration.
- **D9. Monorepo additions** `packages/sync`, `packages/integrations`,
  `packages/i18n` and `packages/config`, on top of the brief's list. *Why:*
  keeps network and adapter code out of `packages/core`.
- **D10. Follow the brief's cloud + sync architecture**, replacing the
  README's earlier "one on-site server per pharmacy" plan.
