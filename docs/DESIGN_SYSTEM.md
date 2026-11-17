# MedFlow design system (v1, for your confirmation)

This follows the "MedFlow UI design system" master prompt. Tokens and the first screens are built. The remaining screens wait for your OK on this document (prompt rule 9).

## 1. Design tokens

**Where they live:** [apps/pos/src/tokens.css](../apps/pos/src/tokens.css). Screens use token names only, never hex values.

**Colours**

| Token group | Light | Dark | Why |
|---|---|---|---|
| Brand | Medical teal `#0f766e` | `#2dd4bf` | Reads as health. Doesn't clash with success green or danger red. 5.4:1 contrast with white. |
| Neutrals | bg, surface, surface-2, border, text, text-2, text-muted | dark equivalents | Calm, low-glare surfaces for a full working day |
| Semantic | success `#15803d`, warning `#b45309`, danger `#b91c1c`, info `#1d4ed8`, each with a "soft" background | brighter versions on dark | Always paired with a word or icon (WCAG: never colour alone) |
| Expiry | critical = danger (< 30 days), soon = warning (30–90), ok = success (> 90) | same | The prompt's severity rule |

**Type**
- **Fonts:** Inter (UI), Noto Nastaliq Urdu (Urdu), monospace (receipts).
- **Scale:** 12 / 13 / 15 / 17 / 20 / 24 / 30.
- **Numbers:** money and quantities always use tabular figures.

**Spacing, shape and motion**
- **Spacing:** 4 / 8 / 12 / 16 / 24 / 32 / 48 (8px grid).
- **Corner radius:** 8 / 12 / 16.
- **Elevation:** two levels.
- **Motion:** 150 ms and 200 ms with one easing curve. All motion is off under `prefers-reduced-motion`.
- **Touch targets:** at least 44px.

**Modes**
- **Light and dark:** follow the system by default (`data-theme` overrides it).
- **High contrast:** for older staff (`data-contrast="high"`).
- **Focus:** a visible 3px focus ring everywhere.

**Money format:** `Rs 1,25,000.00`, lakh grouping by default. A pharmacy setting switches to international grouping (`formatMoney` already supports both).

## 2. Components (built)

| Component | Props | States |
|---|---|---|
| Button | primary / ghost / danger / pay, disabled | hover, focus, busy ("Saving…") |
| Input / select / date range | label, placeholder | focus, error message |
| Global search + command palette (Ctrl+K) | the menu items | typing, ↑↓, Enter, Esc |
| Data table | columns (label, value, numeric, CSV value), click on a row | loading, empty, error, sticky header |
| Stat (KPI) card | label, value, sub-line, tone | good / warn / bad accent |
| Status chip (pill, tag) | good / warn / bad, Rx, Controlled, Recalled | — |
| Dialog (modal) | title, wide | Esc and backdrop close; form errors from the server |
| Tabs with counts | — | selected |
| Empty state | icon, title, text | — |
| Export to Excel | rows, columns | disabled when empty |
| POS: search with results, cart row, payment panel, PIN pad, receipt preview | — | — |

To build next:
- Drawer (item detail).
- Toast with Undo.
- Skeleton loaders (spinners are used today).
- Batch picker (FEFO is automatic today; a manual override is a later step).
- Notification centre.
- Count-up on KPI cards.

## 3. Screens

| # | Screen | Status |
|---|---|---|
| 1 | Login (PIN), pharmacy setup, onboarding checklist | PIN sign-in **built**. The onboarding checklist exists on the server (`onboarding_status`); its screen comes next. |
| 2 | Owner dashboard | **Built**. Sales, profit, week, month, cash in drawers, udhaar, payables, expiring value, dead stock, actions needed, top medicines. Next: a 7-day trend chart and net profit. |
| 3 | POS / new sale | **Built**. Brand / generic / barcode search, FEFO batches, units, discounts, five payment methods, change, udhaar with customer headroom, owner approval, prescriptions, hold, 80 mm receipt, every shortcut, English and Urdu. Next: split payment across two methods in the screen (the server already supports it), and quantity steppers for tablets. |
| 4 | Inventory | **Built**: products (add medicine, opening stock, low-stock chips, Excel export), expiry by severity with write-off, stock movements. Next: the item detail drawer (batches, price history, movements), saved filters, column toggles, bulk actions. |
| 5 | Purchases | **Built**: deliveries with the supplier invoice (bonus, cost, selling price, paid now), orders sent on WhatsApp then received with ordered-vs-received flags, returns to supplier with credit notes. Status: awaiting invoice / unpaid / paid. |
| 6 | Contacts & ledger | **Built**: customers and suppliers with balances, khata statement with running balance, unpaid bills, receive / pay. Next: the WhatsApp reminder button. |
| 7 | Reports hub | **Built**: 11 reports grouped Sale / Profit / Stock / Purchase / Ledger / Staff, date presets, Excel export, print / PDF, a note on how profit is worked out. Plus Accounts & books: cash book with balances, profit & loss, trial balance. |
| 8 | Settings | **Built**: business, receipts (footer, paper width, rounding), display (system / light / dark, high contrast), alert rules with thresholds, hot-key map, sync status. Team: add staff with role and PIN, reset PIN, disable / enable. Expenses page built too. |
| 9 | Notifications centre | **Built** (Approvals & alerts): approve or reject counter requests, every alert with read state. |

**Responsive layout**
- **1366px and wider:** full sidebar, multi-panel POS.
- **1024px and narrower:** the sidebar collapses to icons; the POS stacks into one column.
- **640px and narrower:** owner view without the sidebar. The mobile owner view (dashboard, alerts, quick reports) is next.

## 4. Stack

React + Vite + TypeScript, with plain CSS on design tokens.
- **Why not Tailwind / shadcn:** the existing screens already use tokens. One CSS file per area keeps the bundle small for slow shop PCs, and it also works in the Tauri desktop shell.
- **Switching later:** if you prefer Tailwind + shadcn/ui, the tokens map one-to-one to a Tailwind theme.
- **Backend:** unchanged. Every screen calls MedFlow's existing, tested server functions.

## 5. Decisions

1. **Teal brand:** see the colour table.
2. **The owner lands in the back office, staff land on the POS:** owners plan and check, staff sell.
3. **Expiry by "days left" buckets:** 7 / 30 / 60 / 90, the same buckets MediPOS staff already know. Red under 30 days, amber 30–90, green above, always with the number of days written.
4. **Staff never see totals:** shift screens show "expected cash" only to the owner (the blind close stays).
5. **One app, two modes:** the counter and the back office share sign-in, words and tokens.

## 6. Open questions

1. **Tax:** the prompt mentions "set tax rate" and a "Tax" report. You earlier decided **no tax and no FBR** (D55), so neither is built. Do you want a tax setting after all?
2. **Tailwind + shadcn/ui, or keep plain CSS tokens** (current)?
3. **Net profit on the dashboard:** sales minus cost of medicines, expenses and salaries. Should salaries count daily (spread over the month) or on the day they are paid? Default: on the day paid.
4. **Split payment:** two methods on one bill (e.g. part cash, part JazzCash). Needed now?
