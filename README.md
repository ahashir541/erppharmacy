# MedFlow Pharmacy ERP

MedFlow is an incremental full-stack ERP implementation alongside the original
Streamlit application. The new application uses React, TypeScript, FastAPI,
SQLAlchemy, Alembic, and PostgreSQL. The existing `code.py` app and its CSV
data remain in place; importing legacy records into the relational database is
not part of this release.

## Streamlit Community Cloud demo

The root-level `code.py` is the original CSV-based Streamlit preview, not the
React/FastAPI multi-pharmacy ERP described below. To publish that preview only:

1. Create a GitHub repository containing this project. Confirm that local
   business CSV files, `.env`, database files, and `.streamlit/secrets.toml`
   are not in the commit. The root `.gitignore` excludes these files.
2. In Streamlit Community Cloud, create an app from that repository and set
   the main file path to `code.py`.
3. In the app's **Settings > Secrets**, configure an owner-only demo login:

   ```toml
   deployment_mode = "demo"
   bootstrap_admin_email = "your-demo-login@example.com"
   bootstrap_admin_password = "replace-with-a-random-password-of-14-or-more-characters"
   ```

   Use a unique random password, do not commit these values, and do not share
   the login publicly. The app disables registration in demo mode and no longer
   creates the old built-in `admin123` account.

This is a demonstration only. Its CSV-backed data is ephemeral and shared
within the deployed app; it can reset and is not suitable for concurrent
pharmacy operations. Use synthetic data only—never enter patient, customer,
pharmacy, or financial records. Streamlit Community Cloud alone does not host
the separate React/FastAPI/PostgreSQL ERP; that system needs its own backend
and persistent database deployment.

## Requirements

- Python 3.11+
- Node.js 20+
- Docker Compose/PostgreSQL for the production-like local setup, or SQLite for
  a no-Docker personal demo

## Quick local demo without Docker

For a personal check on one PC, use SQLite:

1. Copy `.env.example` to `.env`. Set `DATABASE_URL=sqlite:///./medical_erp.db`,
   a random `JWT_SECRET_KEY` of at least 32 characters, and your own local
   bootstrap login credentials. The pharmacy administrator password must be at
   least 12 characters; the platform owner password must be at least 14.
2. Start the API and create the empty demo database:

   ```powershell
   cd backend
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -e ".[dev]"
   python -m alembic upgrade head
   python -m app.bootstrap
   python -m uvicorn app.main:app --reload
   ```

3. In another terminal:

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

4. Open `http://localhost:5173/`. Sign in using
   `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`. The platform owner
   signs in at `http://localhost:5173/platform` using the
   `BOOTSTRAP_PLATFORM_EMAIL` and `BOOTSTRAP_PLATFORM_PASSWORD` values.

This demo starts with an empty pharmacy; the original Streamlit CSV records are
not imported. To seed 100 clearly marked synthetic medicines, six sample sales, and one
received supplier invoice with a demo payable, start the API and set the local owner credentials in a separate
PowerShell terminal:

```powershell
$env:DEMO_ADMIN_EMAIL = "pharmacy.admin@demo.example"
$env:DEMO_ADMIN_PASSWORD = "your-local-owner-password"
python .\scripts\seed_local_demo.py
```

Seeded products are explicitly marked `DEMO`; they are synthetic test data,
not medicines to dispense. Demo contact records intentionally have no real
phone numbers; add a number you control to a contact before testing a WhatsApp
draft. Keep the demo on the same PC for now. The current
React app is a browser-based development build, not an installable desktop
package. The selected future setup is one on-site server/database for each
pharmacy, other counter PCs connecting over its LAN, and the owner using a
secure VPN from home. That LAN/VPN installer and server mode have not been
packaged or validated yet. Do not expose the development server or forward its
ports directly to the internet.

## Access layers

MedFlow has three deliberately separate access layers:

1. The sole platform masterboard is reserved for Syed Hashir Ali. Configure its
   single allowed email with `BOOTSTRAP_PLATFORM_EMAIL`; only that configured
   identity can manage pharmacies and see per-store operating summaries.
2. Each pharmacy has its own isolated owner login. That owner sees the
   pharmacy's financial details and manages that store's settings and team.
3. Pharmacy owners create individual cashier, pharmacist, manager, or
   accountant logins with role-limited access. Do not share owner credentials.

The pharmacy owner's account has the `owner` role and is the only account that
can manage team accounts, store settings, and owner-only subscription actions.
Create individual staff logins instead of sharing the pharmacy owner's password.
Cashier, pharmacist, and manager screens/API responses do not expose sales
totals, payment mix, purchase cost, inventory value, customer balances, or
supplier balances. Accountants receive finance screens but cannot manage
owner-only settings or user access. The built-in **Operating guide** explains
the main workflows. **Credit accounts** shows current customer udhaar and
supplier payables to authorized roles; owners can record payments and open
prefilled WhatsApp reminders. A WhatsApp draft is never sent until a person
reviews it and presses Send.

## Local setup

1. Copy `.env.example` to `.env` and replace the database password, JWT secret,
   bootstrap administrator email/password, and platform operator
   email/password. The tenant administrator password must be at least 12
   characters; the platform operator password must be at least 14 characters.
   Use a randomly generated JWT secret of at least 32 characters.
2. Start PostgreSQL with `docker compose up -d db`.
3. Install and start the API:

   ```powershell
   cd backend
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -e ".[dev]"
   python -m alembic upgrade head
   python -m app.bootstrap
   python -m uvicorn app.main:app --reload
   ```

4. In another terminal, start the web app:

   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

   Open `http://localhost:5173`. Vite proxies API requests to
   `http://localhost:8000` during local development. Set `VITE_API_URL` in a
   frontend `.env` file only when your API uses a separate origin.

## Local SQLite and validation

The API defaults to SQLite (`sqlite:///./medical_erp.db`) for local
experimentation. Set `DATABASE_URL` and `JWT_SECRET_KEY` before running the
migrations or API. Run focused checks with:

```powershell
cd backend
python -m pytest
python -m ruff check --select F,I app migrations tests
cd ..\frontend
npm run build
```

## Implemented workflows

- Store-scoped authentication, role checks, audit events, and store settings.
- Product catalog, barcode search, batches/expiry, FEFO checkout, stock receipt,
  stock adjustments, and movement history.
- POS invoices with retry-safe idempotency keys, customer credit limits,
  payment splits, purchases/partial GRN,
  supplier/customer balances, expenses, cash shifts, general ledger, and
  balanced manual journals.
- Platform-issued PKR subscription invoices with JazzCash/Easypaisa wallet,
  local bank-transfer, and manual payment-reference submission and review.
- Role-aware dashboard, operational reports, CSV exports, responsive React
  workspace, and persistent light/dark theme preference.
- Shop expense entry with pharmacy-local date filters, weekly/monthly/yearly
  management summaries, and sales reports that support custom date ranges.
- POS receipts include an optional customer phone and can be opened as an
  itemized WhatsApp draft; staff review and send drafts manually.

The dashboard financial indicators are hidden for cashier/pharmacist roles.
Roles and sensitive API operations are also checked by the backend; hiding a
button is not the authorization boundary.

## Current product limitations

This is a working foundation, not yet a complete replacement for a mature
pharmacy ERP. Prescription workflow, held sales, returns/refunds, bank
reconciliation, comprehensive report filters and PDF/Excel exports, detailed
permission configuration, automated subscription-gateway checkout and
recurring charges, and legacy CSV import still require implementation. The
current wallet and bank billing flow records transfer references; operators
must verify settled funds before approval.
The frontend currently provides the core workflows and navigation; the original
Streamlit app should remain available until those operational gaps are closed
and the relational data has been validated for production.

Do not expose the development API directly to the public internet. Configure
TLS, backups, monitoring, secret rotation, and production-grade deployment
controls before handling live customer or financial data.

## Production deployment baseline

The Docker Compose production stack runs PostgreSQL, a one-shot migration and
platform bootstrap job, FastAPI, the static web client, and Caddy for HTTPS.
Deploy it on a supported Linux host with a static public IP; point the chosen
domain's DNS A/AAAA records to that host and allow inbound TCP 80/443. Install
Docker Engine and the Docker Compose plugin, clone the release, and create a
private root `.env` from `.env.example`.

For production, set:

- `DOMAIN` to the exact public hostname.
- A long random `POSTGRES_PASSWORD` made of URL-safe hex characters.
- A separate random `JWT_SECRET_KEY` of at least 32 characters.
- A unique `BOOTSTRAP_PLATFORM_EMAIL` and random
  `BOOTSTRAP_PLATFORM_PASSWORD` of at least 14 characters.
- `ENVIRONMENT=production`, `TRUSTED_HOST_ORIGINS` to the hostname, and
  `CORS_ORIGINS=https://<hostname>`.
- Optionally configure the JazzCash/Easypaisa receiving account names and
  numbers, and bank name, account title, account number, and IBAN. These are
  payment instructions only; do not put merchant API secrets in these fields.

Then run `docker compose up -d --build` and wait for the `api`, `web`, and
`proxy` services to report healthy. Caddy obtains and renews a TLS certificate
when public DNS and ports are configured. Sign in at `/platform` using the
bootstrap platform operator credentials, provision each pharmacy, and
securely deliver its administrator's temporary credentials. Pharmacy staff
sign in at `/`.

Do not commit `.env` or database dumps. Schedule encrypted off-host backups,
test restores, monitoring/alerting, host and OS patching, and a documented
incident response before onboarding customers. The included backup/restore
helpers are run from the project root. They create unencrypted PostgreSQL
custom-format dumps; protect them as sensitive data and encrypt them before
off-host storage. Restore validates the dump and creates a separate
`pre-restore` backup before it stops the API or changes the database:

```powershell
python .\scripts\backup.py
python .\scripts\restore.py .\backups\medical-erp-YYYYMMDD-HHMMSS.dump --confirm-production-restore
```

The API is not directly published by Compose. Caddy limits API request bodies
to 2 MB, disables API response caching, and terminates public HTTPS. The API
does not trust arbitrary forwarded headers. Docker build contexts exclude
local environment files, databases, backups, and frontend dependencies.
Continuous integration checks backend tests, frontend build/dependencies,
PostgreSQL migrations, container builds, and Caddy configuration.

This deployment scaffold is not itself a certification or a complete
subscription business. Automated gateway payment collection/recurring billing,
pharmacy jurisdictional compliance, privacy/retention policies, customer
support, tenant-specific usage limits, and production load/security testing
still need decisions and validation for the markets you intend to serve. Do
not onboard a live pharmacy until the remaining workflow gaps above are
accepted or closed and a full restore has been tested.

### Local subscription payment handling

The platform operator can issue PKR invoices for a pharmacy and a plan period
from the `/platform` console. A pharmacy administrator signs in, opens
**Subscription**, transfers the exact amount to a configured JazzCash,
Easypaisa, or bank account (or follows manual instructions), and submits the
transaction reference. The platform operator must verify settled funds in the
receiving account before approving the invoice. Approval activates the plan and
sets the paid-through date; expiry restricts pharmacy operations but leaves the
billing screen available for resolution.

This is manual reconciliation, not a gateway integration: there is no direct
wallet checkout, webhook/callback processing, automated refund, or recurring
debit. The public provider material inspected did not establish current API
signature-verification, transaction-inquiry, refund, or recurring-payment
specifications for these merchant accounts. Obtain merchant accounts and
current provider-issued integration guides, verify callback authentication and
transaction inquiry with each provider, and complete sandbox/security testing
before enabling direct online collection.
