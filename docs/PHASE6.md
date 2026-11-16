# Phase 6 — Owner control and finance (server side)

## What was built, in simple words

- **No totals at the counter, even through the API.**
  - A counter PC can look up a bill, but it can't read bill amounts or payments in bulk. Adding them up would show the day's sales and the drawer's expected cash, which would defeat blind closing.
  - The owner reads full bills through `owner_sales` (and the matching line, payment and return views), and only with "see sales totals" for that branch.
  - A single receipt still prints, through `get_receipt`.
  - The counter's download (PowerSync) no longer includes bill amounts either.
- **Approvals.**
  - The counter asks (`request_approval`): a discount above the limit, a void, a return and so on.
  - The owner's phone gets it at once, saying who is asking, how much and why.
  - The owner taps approve or reject (`decide_approval`), or types their PIN at the counter (`approve_at_counter`).
  - Nobody can approve their own request. An approval expires after 15 minutes and is used once.
- **Alerts to the owner** (each one can be switched off or given a threshold with `set_alert_rule`):
  - a large discount (default Rs 500) or a void;
  - a cash drawer short (default Rs 100);
  - a controlled drug sold;
  - udhaar over the limit, and anything else flagged after an offline upload.

  Alerts are stored as notifications. A phone registers for push with `register_push_subscription`.
- **Expenses** (`post_expense`, `void_expense`, `save_recurring_expense`, `post_due_recurring_expenses`).
  - Paid from a drawer or a bank account, or recorded as unpaid. Ready-made categories: rent, salaries, electricity, generator fuel, tea and others.
  - A recurring expense such as rent becomes an unpaid expense each time it falls due.
- **Salaries and advances** (`set_salary_rate`, `give_staff_advance`, `salary_preview`, `pay_salary`).
  - An advance is paid back from salaries automatically, so much a month.
  - A month's salary is paid once.
- **Owner dashboard** (`owner_dashboard`).
  - Sales today, this week and this month, against the period before, per branch.
  - Profit, margin and top products, by sales and by profit.
  - Cash in open drawers, udhaar to collect and given today, money owed to suppliers.
  - Expiring and dead stock value, short or over by staff.
  - What needs attention: voids, discounts, returns, open flags, waiting approvals.
  - Each part shows only if the person has its permission.
- **Reports**:
  - sales by day, hour, product, category, company, staff, branch or bill, and by payment method;
  - profit by the same, and a profit and loss statement;
  - stock value at cost and retail, and dead stock;
  - purchases by supplier or product, including the bonus value;
  - udhaar collections;
  - staff (sales, discounts, voids, returns, short or over, hours signed in);
  - an activity feed and a trial balance.

  Excel and PDF export is done by the web app from these results.

## How to test

```bash
pnpm check
```

- [11_owner_control](../packages/db/supabase/tests/database/11_owner_control.test.sql) (59 checks) covers:
  - approvals, from the phone and by PIN at the counter;
  - alerts and their thresholds;
  - expenses, rent and salaries with an advance;
  - the dashboard and every report, checked against known numbers;
  - that every report refuses a counter PC.
- `a counter PC sees no money totals` in `packages/db/scripts/test-db.mjs` signs in as a counter PC and tries to read every money column of every table and view. It fails if a single one shows anything a counter shouldn't have.

## "Done when" — status

| Brief | Status |
|---|---|
| A salesman account cannot see any total anywhere, including through the API | **Done** (checked column by column, and every report refuses a counter) |
| Approvals to phone, blind cash closing, expenses, dashboard, reports, alerts | **Done** on the server |
| Owner PWA | **Not yet**: the screens come with the web app |

## Not done yet

- The screens: the owner web app and phone app (PWA).
- The workers that send phone pushes and WhatsApp messages. They need accounts (web push keys, a WhatsApp provider) that only you can create.
- Scheduled alerts: low stock, expiring batches, a PC offline too long, and the daily summary.
- The trial balance is worked out from the books underneath it (D44); journal-by-journal posting comes later.
