# MedFlow — pharmacy management platform

A multi-tenant pharmacy system for Pakistan and beyond. It works offline at
the counter, keeps every rupee in an append-only ledger, and only the owner
sees money.

- **Brief:** [docs/MASTER_PROMPT.md](docs/MASTER_PROMPT.md)
- **Decisions:** [docs/DECISIONS.md](docs/DECISIONS.md)
- **What changed:** [docs/CHANGELOG.md](docs/CHANGELOG.md)
- **Phases:** [1 Foundation](docs/PHASE1.md) · [2 Catalogue and stock](docs/PHASE2.md) · [3 Counter sales](docs/PHASE3.md) · [4 Offline sync](docs/PHASE4.md) · [5 Purchasing and udhaar](docs/PHASE5.md)

## Layout

```
packages/core     business rules in TypeScript (permissions, PINs, money, invoice numbers, IDs)
packages/db       Supabase: schema, security rules, server functions, tests
packages/config   shared TypeScript settings
apps/             web, desktop (counter) and admin apps (from Phase 2)
legacy/           the old FastAPI/React/Streamlit app, for reference only
```

## Quick start

Needs Node.js 22+ and pnpm 10 (`npm install -g pnpm@10`).

```bash
pnpm install
pnpm check
```

`pnpm check` type-checks and runs every test: the core unit tests and the
database tests (embedded Postgres, no Docker needed).
