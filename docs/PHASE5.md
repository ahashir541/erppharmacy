# Phase 5 — Purchasing and udhaar (server side)

## What was built, in simple words

- **Suppliers** (`save_supplier`): name, phone, WhatsApp, NTN/STRN, payment terms (days), credit limit, lead time.
- **Purchase orders** (`create_purchase_order`, `send_purchase_order`, `cancel_purchase_order`).
  - Numbered `PO-000001`.
  - "Send" marks the order sent and returns a ready-made WhatsApp message listing the items and bonus.
    It has no prices, because the supplier quotes their own.
- **Goods received** (`post_grn`).
  - The store keeper counts what arrived: batch, expiry, quantity and bonus ("10 + 1").
  - Stock goes up at once. Expired goods are refused, and anything expiring within 90 days (a setting) comes back as a warning.
  - The store keeper never sees or enters prices.
  - The order is marked partly or fully received.
- **The supplier's invoice** (`post_purchase_invoice`, or in the same step as the delivery).
  - Someone allowed to see costs enters each line's price, discounts, scheme discount and tax.
  - The totals are worked out from the lines and **must match the paper invoice** when you type its total.
  - The due date comes from the supplier's terms. Anything paid on delivery is recorded and tied to that invoice.
  - **Bonus lowers the cost**: 66 tablets for the price of 60 cost Rs 1.64 each, not Rs 1.80.
- **Returns to the supplier** (`post_purchase_return`, `settle_purchase_return`).
  - Stock leaves now. The value (at cost) waits as a **claim**.
  - When the credit note arrives, which can be months later and for less, it reduces what we owe. The claim shows what was lost.
- **Paying suppliers** (`pay_supplier`).
  - Pay by cash from a drawer, bank transfer, JazzCash, Easypaisa, card or cheque.
  - Choose which invoices the payment is for, or let it pay the oldest first.
- **Customer khata** (`create_customer`, `update_customer`, `set_credit_limit`, `set_udhaar_block`, `record_opening_balance`, `write_off_udhaar`).
  - A family can share one account.
  - The old khata is moved in as an opening balance (once).
  - Limits, blocking (with a reason) and write-offs need the owner's permissions; a write-off over the owner's limit needs approval.
- **Udhaar payments** (`receive_udhaar_payment`).
  - Taken at the counter too. The receipt shows what was paid, **never the balance**.
- **Cheques** (`set_cheque_status`): pending → deposited → cleared or bounced, or cancelled.
  - Money reaches the bank account only when the cheque clears.
  - A bounced cheque is owed again; a cancelled one is reversed.
- **Open bills and ageing** (`open_bills`, `party_ageing`).
  - What is still unpaid on each bill, and how late: not due, 1–30, 31–60, 61–90 and over 90 days.
- **Statements** (`party_statement`).
  - Opening balance, every entry with its bill number or invoice number, a running balance, and the closing balance.
  - The same for customers and suppliers.
- **Matching a supplier's statement** (`reconcile_supplier_statement`).
  - Type in their lines. Each one comes back marked: matched, different amount, missing from our books, or in our books but missing from theirs.
- **Udhaar reminders** (`udhaar_reminders_due`, `queue_udhaar_reminders`).
  - Customers with something overdue who agreed to reminders, at most once a week.
  - The message is in Urdu and English and waits in the WhatsApp queue. Sending is Phase 6.

## How to run and test

```bash
pnpm install
pnpm check
```

- [10_purchasing_udhaar](../packages/db/supabase/tests/database/10_purchasing_udhaar.test.sql) follows one
  supplier from order to statement match, and one customer from opening balance to reminder (64 checks).
- `statements = ledger, 400 random documents` in `packages/db/scripts/test-db.mjs`:
  - **the documents:** random credit sales, payments (some for chosen bills), deliveries with invoices, supplier payments, cheques that clear, bounce or are cancelled, and write-offs;
  - **the checks, for every customer and supplier:** the statement's closing balance equals the ledger, the open bills add up to what is owed, and so does the ageing.

## "Done when" — status

| Brief | Status |
|---|---|
| A customer statement and a supplier statement match the ledger to the paisa | **Done** (64 checks plus 400 random documents) |
| GRN with bonus, cost layers, store keeper without cost | **Done** |
| Payments, allocations, cheques, ageing, reminders | **Done** (WhatsApp sending is Phase 6) |

## Not done yet

- Screens: the owner's web app and the counter app come later.
- A sale made before its delivery's invoice is entered has no cost yet. Phase 6 profit reports show it as "cost pending".
