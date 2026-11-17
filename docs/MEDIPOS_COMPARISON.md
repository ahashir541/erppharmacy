# MediPOS vs MedFlow — feature comparison

**Source:** the 19 videos in the "Medi POS Tutorials & Guides" playlist by Innobrains Technologies. I read each video's description and looked at frames from the POS, accounts, settings, shifts, purchases, team and setup screens. The narration itself wasn't readable: only Hindi/Urdu auto-captions exist.

**What MediPOS is:** a Windows app that works offline, plus a web app at medipos.pk/app. It has a 14-day free trial and an activation code for the shop PC. Its FBR link is optional and off by default.

## The big difference

MediPOS has **screens**. MedFlow has all the business rules and the database (Phases 1–7, about 8,700 automated checks) but **no screens yet**: no POS screen and no back-office app. Until those are built, nobody can use MedFlow at a counter. This is the most important gap.

## Feature by feature

Legend: ✅ MedFlow has it (server side) · 🟡 partly · ❌ missing

| MediPOS feature (video) | MedFlow | Notes |
|---|---|---|
| **POS screen**: search by name or barcode, choose unit (box, strip, tablet), quantity, price, line and bill discount | ✅ rules · ❌ screen | Bill maths, packs and FEFO batches are done; the screen isn't |
| POS keyboard shortcuts (F2 search, F3 qty, F4 customer, F5 price, F6 discount %, F7 bill discount, F8 hold, F10 cash, F12 pay, Ctrl+U unit, Ctrl+M method) | ❌ | Part of the POS screen |
| Payment methods: cash, bank transfer, Easypaisa, JazzCash, card; cash received and change | ✅ | |
| Credit sale (udhaar) for a chosen customer | ✅ | With credit limits and owner approval |
| Hold bill, clear, note on the bill | ✅ hold · 🟡 note | |
| Receipt printing: 58/80 mm, copies, cutter, open the cash drawer, line under the shop name | ✅ receipt + ESC/POS · ❌ printer settings screen | |
| Sales & invoices list: totals, invoice count, udhaar, gross profit, search, filter by status and dates | 🟡 | Reports exist; a searchable invoice list doesn't |
| Returns | ✅ | |
| Customers: code, mobile, CNIC, address, **usual discount %**, credit limit, payment days, opening balance | 🟡 | Missing: customer code and usual discount % |
| Customer khata, unpaid bills, receive payment | ✅ | |
| Udhaar recovery dashboard: total outstanding, overdue, latest payments | ✅ | Ageing, open bills, reminders |
| Products & stock: add and edit a medicine, generic, company, category, dosage form, drug class, pack sizes, prices per pack | ✅ | |
| **Medicine database**: pick a ready-made medicine instead of typing it | ❌ | The table exists; search and add-from-database don't |
| Opening stock with batch, expiry and cost | ✅ | |
| Stock adjustments (damaged, broken, lost) | ✅ | |
| Physical stock count with count sheet and reasons | ✅ | Blind count |
| Stock movements history with user and value | ✅ | |
| Expiry dashboard: expired, 7, 30, 60, 90 days | 🟡 | We have expired, 30, 60, 90; missing the 7-day bucket |
| **Products missing batch or expiry** list | ❌ | |
| **Stock transfers between branches** | ❌ | Permission and stock types exist; the function doesn't |
| Purchases (purchase bill with batch, expiry, unit, qty, bonus, MRP, T.P.; add a new medicine from inside the bill) | ✅ rules | Screen needed |
| Suppliers | ✅ | |
| Returns to supplier | ✅ | With claims and credit notes |
| Shifts: open with cash, bills, expected in drawer | ✅ blind closing · 🟡 | A shift summary for the owner is missing |
| Expenses | ✅ | |
| Employees and staff advances | ✅ | Salaries with automatic advance recovery |
| **Accounts & books: cash book** (cash in hand, cash in safe, bank, JazzCash, card payments to be settled) | ❌ | Balances exist; the cash book and the "safe" and "card to settle" accounts don't |
| **Day book** | ❌ | |
| Profit & loss | ✅ | |
| **Balance sheet** | ❌ | We have a trial balance |
| Trial balance | ✅ | |
| **Money transfers** (cash to bank, wallet to bank) | ❌ | Movement type exists; the function doesn't |
| Chart of accounts | 🟡 | Fixed account list in the trial balance |
| Reports | ✅ | Sales, profit, stock, purchases, udhaar, staff |
| Team members, roles per branch (e.g. Cashier at one branch) | ✅ | |
| Counter PIN (4–6 digits), locks after 5 tries | ✅ | |
| Two-step sign-in for the owner | ✅ | Required for owners in MedFlow |
| Audit log with filters | ✅ | Activity feed |
| **Data import of customers and suppliers** (CSV templates, check before import) | 🟡 | Products only |
| Settings: business, counter & receipts, receipt printer, display, invoice number prefixes, sign-out after inactivity, daily alerts by email/SMS, hourly backups | 🟡 | Mostly screen settings; daily email/SMS sending needs a provider account |
| Install, owner account, activation code for the shop PC | ✅ | Device registration and licence |
| 14-day trial, grace period banner, data kept safe | ✅ | Phase 8 (in progress) |
| FBR optional | — | MedFlow has no FBR at all (D55) |

## What MedFlow has that MediPOS doesn't show

- Two counters selling offline and syncing without losing a sale or a paisa.
- Staff blocked from seeing totals even through the API, checked column by column.
- Approvals sent to the owner's phone.
- Blind cash closing with short/over by staff.
- Bonus lowering cost, supplier claims, supplier statement matching, cheques.
- Controlled drugs register, prescriptions with pharmacist confirmation, recalls pushed to every pharmacy.
- A multi-pharmacy platform with plans, billing and a health page.
- Urdu.

## Plan to close the gaps

1. **Server gaps (small):**
   - Medicine database search and add.
   - Stock transfers between branches.
   - Cash book, day book, balance sheet, money transfers, plus the "cash in safe" and "card to settle" accounts.
   - Import of customers and suppliers.
   - Searchable invoice list.
   - Shift summary.
   - Customer code and usual discount %.
   - Expiry 7-day bucket and the missing-batch/expiry list.
2. **POS screen (big, most important):**
   - The counter app in React: search and scan, units, quantity, discounts, payments, udhaar, hold, receipts.
   - All the same keyboard shortcuts, in English and Urdu.
   - It runs in a browser first. It becomes the Windows app once Rust is installed for Tauri.
3. **Back-office app:** dashboard, products and stock, purchases, customers and khata, suppliers, accounts and books, reports, team, settings.
