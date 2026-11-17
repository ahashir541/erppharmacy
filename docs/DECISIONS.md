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

## 2026-11-09 — Phase 3 (Delegated)

- **D26. Bill discount sharing.** A bill discount is shared across lines in
  proportion to each line's amount after line discounts. Leftover paisa go to
  the biggest lines first. The discount limit is checked as a percentage of
  the bill's gross (basis points), as D16 said.
- **D27. Tax inside the total.** Tax is computed per line (inside the price
  or on top, per the tenant setting) and the bill is rounded once at the end.
  The stored subtotal is grand total − rounding + discounts − tax, so
  `grand = subtotal − discounts + tax + rounding` always holds.
- **D28. Online vs offline sales.** The same function records both. Online,
  any rule problem rejects the sale before the medicine is handed over.
  Offline (uploaded later), problems become owner flags and the sale is kept.
  Unknown items, a wrong batch, or udhaar without a customer are always
  rejected: they are app bugs, not judgement calls.
- **D29. Returns.** The refund is the line total × returned qty ÷ sold qty,
  rounded half-up. Damaged items can be returned without restocking. A bill
  with returns can't be voided (return the rest instead).
- **D30. Demo data.** The demo client is local-only seed data. Its names are
  marked "Demo" and its contacts use example.com.

## 2026-11-09 — Phase 4 (Delegated)

- **D31. A command outbox, not table sync, for writes.** The counter never
  writes tables directly. It uploads commands (sale, return, drawer, sign-in,
  held bill) that the server replays through the same functions the online
  counter uses. This keeps every rule on the server and makes retries safe
  (each command has a UUIDv7 from the PC and is applied once). Downloads use
  PowerSync sync rules with every column listed.
- **D32. Voids are online only.** A void needs a manager's approval and
  reverses cash and udhaar, so it isn't queued offline. Offline, the counter
  does a return instead.
- **D33. Nothing is ever dropped.** A command the server can't apply (an app
  bug, a newer app version, a reused number) is stored as `rejected` with its
  full contents and error, and the owner gets a flag. Support can replay it
  after a fix.
- **D34. PIN hashes per branch.** A counter downloads PIN hashes only for
  staff who work at its branch (or at all branches), so a lost PC exposes as
  few as possible. PINs are slow PBKDF2 hashes, and the server re-checks every
  sign-in when it uploads.

## 2026-11-09 — Phase 5 (Delegated)

- **D35. Open bills come from the ledger.** Nothing is marked "paid" on a
  bill. Which bills are open is worked out each time: payments tied to a bill
  count against that bill first, and everything else pays the oldest bill
  first. So the open bills always add up to the balance, whatever order
  things happened in.
- **D36. Prices arrive with the invoice.** A store keeper posts the delivery
  (quantities only); the person allowed to see costs posts the invoice. The
  batch's cost is known from then on. Sales made in between have no cost yet
  and are reported as "cost pending".
- **D37. Purchase tax is part of the cost.** Most pharmacies can't claim
  input tax back, so tax on a supplier invoice is added to the cost of the
  stock. Phase 7 adds an option for those who can.
- **D38. Returns wait as claims.** Returned stock leaves at once. Its value at
  average cost is a claim on the supplier, and what we owe goes down only when
  the credit note arrives, for whatever amount they credit.
- **D39. Cheques count when they change hands.** A cheque reduces what is
  owed when it is received or issued. The bank balance changes only when it
  clears; a bounce makes the amount owed again; a cancelled cheque is reversed.
- **D40. Deliveries are never "un-received".** A delivery can't be voided,
  because some of it may already be sold. Mistakes are fixed with a return
  or a stock adjustment, so the history stays true.
- **D41. Reminders.** Only to members who agreed, at most once every 7 days
  (a setting), in Urdu and English. Balances and statements are never
  readable from a counter PC (D13).
- **D42. Document numbers.** Purchase orders, deliveries, returns and khata
  accounts are numbered per pharmacy (`PO-000001` and so on), by the cloud.
  Counter bills keep their own PC numbers (D23).

## 2026-11-16 — Phase 6 (Delegated)

- **D43. Bill amounts are hidden by column, not by screen.** A counter PC
  could otherwise add up the bills it can look up and see the day's sales
  and the drawer's expected cash. So the amount columns of bills, lines,
  payments and returns are not readable through the API at all; owners use
  the `owner_*` views, gated by "see sales totals". A counter reprints its own
  bills from its local copy and other bills through `get_receipt`. Offline,
  a counter can still take a return on another counter's bill, but the
  refund amount is worked out when it reconnects.
- **D44. The trial balance comes from the books underneath.** Cash, bank,
  stock at cost, udhaar, supplier dues, sales, tax, cost of goods, expenses
  and salaries are read from their own ledgers. "Owner's capital and
  opening balances" makes up the difference: what the owner put in. Posting
  every document as a journal comes later; the numbers will not change.
- **D45. Expenses count when they are owed.** An unpaid expense (rent that
  fell due) is in the profit and loss straight away, not only when paid.
- **D46. Approvals.** Only someone allowed both to approve and to do the
  action themselves can approve it, never the person asking. At the counter,
  the PC checks the approver's PIN as it does for any sign-in (D34).
  Requests expire after 15 minutes.
- **D47. Alert defaults.** A discount of Rs 500 or more on one bill, every
  void, a drawer Rs 100 or more short, every controlled drug sale, and every
  flag. The owner changes or switches off each one.

## 2026-11-16 — Phase 7 (Delegated)

- **D52. Prescriptions travel with the bill.** The counter can send the
  prescription inside the sale, so offline sales and their prescriptions
  arrive together. Only someone allowed to confirm prescriptions counts as
  the pharmacist.
- **D53. Recalls match by batch number and brand.** A recall freezes every
  batch with that number whose brand matches, now and when received later.
  Only the platform can lift it.
- **D54. Receipts at the counter.** A counter can reprint the receipts of its
  branch's bills from the last 7 days, one at a time; each reprint is logged,
  so pulling receipts to add them up shows in the activity feed.

## 2026-11-17 — No tax (Owner's decision)

- **D55. No sales tax and no FBR.** The owner decided MedFlow has no tax and
  no connection to FBR or any other tax authority. This replaces D19 and the
  brief's tax module (and the Phase 7 tax queue, removed again). Bills never
  carry tax (the bill rows keep their tax columns at 0 so the shared bill
  maths stays one code path). There are no tax settings, permissions,
  features, receipt lines or report columns. Voids are allowed as in Phase 3.
  A supplier invoice can still show the tax printed on the supplier's own bill
  as part of what the pharmacy pays for the stock (D37).
