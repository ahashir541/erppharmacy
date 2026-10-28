# Phase 2 — Catalogue and stock

## What was built, in simple words

- **Product import.** A CSV file (or an Excel sheet, read by the web app)
  goes through a column-matching step. MedFlow guesses columns such as "Item
  Name", "Salt", "Company" and "MRP"; the owner confirms. Up to 10,000
  products go in per call, and bigger files are split automatically.
  - Products are matched by barcode first, then by brand + strength + company.
  - Importing the same file again changes nothing. Blank cells never erase
    data.
  - Bad rows are listed by row number and the good rows still go in. A
    barcode that belongs to a differently named product is refused, so a typo
    can't merge two medicines.
- **Packs.** Each product has a ladder: tablet → strip → box. Quantities are
  always stored in tablets (the base unit), and shown as "2 box + 5 strip + 4
  tablet".
- **Prices.** Every change is kept as history. A bulk change ("all GSK +5%")
  rounds to the nearest paisa. Trade price (close to cost) is hidden from
  staff.
- **Stock is a ledger.** Opening stock, corrections, write-offs of expired or
  damaged stock, and counts each add a movement row. The shelf quantity is
  always the sum of those rows. A self-check proves this and a repair job
  rebuilds the totals if they ever drift.
- **Staff on the PC.** The store keeper signs in on the pharmacy PC with
  their PIN and does stock work there. Their permissions apply, e.g. a daily
  limit on corrections. Past the limit, the owner's approval is needed; an
  approval works once.
- **Blind stock counts.** Staff count without seeing the system figure. Only
  the owner sees the difference, and approving the count fixes the stock.
- **Expiry dashboard.** Every batch with stock: expired, within 30 / 60 / 90
  days, or later. Recalled or blocked batches are marked.

## How to run and test

```bash
pnpm install
pnpm check
```

The Phase 2 tests are
[06_catalogue_import](../packages/db/supabase/tests/database/06_catalogue_import.test.sql)
and [07_stock](../packages/db/supabase/tests/database/07_stock.test.sql), plus a
CSV → database round trip in `packages/db/scripts/test-db.mjs`.

## "Done when" — status

| Brief's test | Status |
|---|---|
| importing 10,000 products works | **Passes**: 10,000 created; re-import creates and updates nothing |
| stock always equals the sum of movements | **Passes**: after 3,000 mixed movements, plus damage-and-repair |

## Changed along the way

- **Limit rule (D16, revised).** A blank limit now means "no limit"; 0 means
  "always ask". The old rule blocked store keepers from adjusting stock, which
  the brief allows.
- **Price timestamps** use the real clock, so several changes in one save
  stay in order.
