#!/usr/bin/env bash
# Puts MedFlow's database and server functions on your Supabase project.
# Run from the repository root after `supabase login` (it opens your browser once):
#   bash scripts/deploy-cloud.sh <project-ref>
# The project ref is in your Supabase project's URL: https://supabase.com/dashboard/project/<project-ref>
set -euo pipefail
REF="${1:?Usage: bash scripts/deploy-cloud.sh <project-ref>}"
cd "$(dirname "$0")/../packages/db"

echo "1/4 Linking to project $REF (asks for the database password you chose)…"
supabase link --project-ref "$REF"

echo "2/4 Creating every table, rule and function (migrations)…"
supabase db push

echo "3/4 Auth settings: sign-ups off, 12+ character passwords, 2FA, the MedFlow sign-in hook…"
supabase config push --project-ref "$REF" || echo "   (If this step fails, set them by hand: see docs/CLOUD_SETUP.md step 4.)"

echo "4/4 Server functions (counter PC registration, owner invitations)…"
supabase functions deploy register-device --project-ref "$REF"
supabase functions deploy invite-owner --project-ref "$REF"

echo
echo "Done. Next: docs/CLOUD_SETUP.md step 5 (plans and your first pharmacy) and step 6 (the website)."
