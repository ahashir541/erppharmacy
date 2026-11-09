# Phase 3 — Counter sales (server and shared rules)

## What was built, in simple words

- **The bill** (`packages/core/src/bill.ts`, and the same maths in SQL).
  - Quantity × price per line, line discounts, and a bill discount shared across the lines in proportion, to the paisa.
  - Sales tax inside the price (or on top, as a setting), and the total rounded to the nearest Re 1 (a setting).
  - Split payments (cash, card, JazzCash, Easypaisa, bank transfer) and change from cash; whatever is unpaid goes on the customer's khata as udhaar.
  - The counter and the server compute exactly the same bill. A test compares them on 3,000 random bills.
- **First expiry, first out** (`fefo.ts`). Sales take from the batch that expires first. Expired and recalled batches are never offered.
- **Recording a sale** (`post_sale`). The server checks:
  - **price:** a price different from the list needs "edit price"; a price below the minimum needs "sell below minimum";
  - **discount:** within the person's limit, otherwise owner approval;
  - **stock:** no expired or blocked batch, and no selling beyond the shelf unless the person may;
  - **prescriptions:** an Rx or controlled drug needs one, and a controlled drug also the pharmacist's confirmation and the owner's quantity limit;
  - **udhaar:** within the person's limit and the customer's credit limit, never for a blocked customer.

  It records the stock movement, the cash in the drawer, the udhaar entry (due in 30 days by default) and the cost of goods (owner-only). A retried upload is recognised and never counted twice.
- **Offline sales** use the same function, but the medicine has already been handed over. So problems become **flags for the owner** instead of rejections (for example an expired batch, or cash taken after the drawer was closed).
- **Returns** are against the original bill. The refund is the line total × returned ÷ sold, the items go back to the original batch, and you can't return more than was sold. **Voids** reverse stock, cash and udhaar, and the bill stays, marked void.
- **Cash drawer.** Open with a float. At closing the salesman enters what they counted (**blind**); only the owner sees what was expected and the short or over.
- **Receipt** (`receipt.ts`). For 58 mm and 80 mm thermal printers: total, payments, change, a clear "CREDIT (UDHAAR)" mark, "FBR: pending" while offline, and the ESC/POS bytes to print, cut and open the cash drawer. It never shows cost or profit.
- **Demo Pharmacy** (`supabase/seed-demo.sql`): 2 branches, 500 products, 30 days of sales (about 1,200 bills), all made through the real functions.

## How to run and test

```bash
pnpm install
pnpm check                         # everything except the demo
pnpm --filter @medflow/db test -- --demo    # also builds Demo Pharmacy (about 2 minutes)
```

The Phase 3 database test is
[08_pos](../packages/db/supabase/tests/database/08_pos.test.sql). It covers:
- a cash sale, a retried upload and the price and discount rules;
- an expired batch, udhaar, a return and a void;
- blind closing, the receipt, the offline flags and the speed check.

## "Done when" — status

| Brief's test | Status |
|---|---|
| a 5-item sale with a scanner takes under 10 seconds end to end | **Server part passes**: a 5-item bill is recorded in under 2 seconds. The scanner and screen part needs the counter app (below). |

## Not in Phase 3 yet

- **The counter screen itself** (Tauri app: search box, bill, F-key shortcuts, held bills, printing to the real printer). The rules it needs are ready in `packages/core`. Rust, which Tauri needs, is not installed on this PC.
- **Held bills** are saved on the counter PC. The table exists; syncing them comes with Phase 4.
