# Putting MedFlow on the cloud

Two free accounts are needed, and only you can create them:
- **Supabase**, for the database, logins and server functions.
- **Vercel** (or Netlify), for the website.

Everything else is already built and tested.

| Part | What it is |
|---|---|
| Supabase project | The database: every rule, permission and ledger (26 migrations, about 8,700 automated checks) |
| Website (`apps/pos`) | The POS and back office. One link opens from any computer, phone or tablet. |
| Owner sign-in | Email, password and a 6-digit code from an authenticator app |
| Counter PCs | Linked once by the owner; staff then use their PIN |

## 1. Create the Supabase project (5 minutes)

1. Go to <https://supabase.com>, sign up (Google sign-in is fine) and choose **New project**.
2. Fill in the project:
   - **Name:** `medflow`
   - **Region:** **South Asia (Mumbai)**, the closest to Pakistan
   - **Database password:** choose a strong one and keep it safe.
3. When it is ready, note the **project ref**: the letters in the address bar after `/project/`.

> Free plan: fine to start. Before real pharmacies use it, upgrade to **Pro** for daily backups.

## 2. Install and log in to the Supabase CLI (once)

```bash
npm install -g supabase
```
```bash
supabase login
```
It opens your browser; approve it.

## 3. Push MedFlow to your project (one command)

From the MedFlow folder:
```bash
bash scripts/deploy-cloud.sh YOUR-PROJECT-REF
```
It asks for the database password from step 1, then creates everything.

## 4. Check the sign-in settings (dashboard)

The script sets these automatically. If its step 3 printed an error, set them by hand:
- **Sign-ups:** Authentication → Sign In / Providers → turn **Allow new users to sign up** off. Owners are added by you.
- **2FA:** Authentication → Multi-Factor → **TOTP: enabled**.
- **Sign-in hook:** Authentication → Hooks → **Customize Access Token** → enable it and choose `public.custom_access_token_hook`. This tells MedFlow which pharmacy and which PC a sign-in belongs to.
- **Passwords:** Authentication → Policies → minimum password length **12**.

## 5. Plans and your first pharmacy (SQL editor)

1. **Plans:** Supabase → SQL Editor → New query. Paste the whole of `packages/db/supabase/seed.sql` and click **Run**. This adds the plans: Basic, Pro, Enterprise.
2. **Owner login:** Authentication → Users → **Add user** → your email and a strong password (12+ characters), and tick **Auto confirm**.
3. **Your pharmacy:** run this in the SQL Editor, with your details:
   ```sql
   select app.setup_pharmacy('Al Shifa Pharmacy', 'Syed Hashir Ali', '03xxxxxxxxx',
                             'you@example.com', 'Karachi', 'KHI1', 'Main Branch');
   ```
   - **Email:** the same one as in item 2.
   - **Branch code:** 2–8 capital letters or digits. It starts every bill number, e.g. `KHI1-C1-000001`.

## 6. Put the website online (Vercel, 5 minutes)

1. Go to <https://vercel.com>, sign up with GitHub, and choose **Add New → Project** → import the `erppharmacy` repository.
2. Set up the project:
   - **Root Directory:** `apps/pos`. The build settings come from `apps/pos/vercel.json`.
   - **Environment Variables:** add two, both from Supabase → Project Settings → API:
     - `VITE_SUPABASE_URL` = your Project URL (`https://YOUR-PROJECT-REF.supabase.co`)
     - `VITE_SUPABASE_ANON_KEY` = the **anon / public** key. Never the service_role key.
3. Click **Deploy**. You get a link like `https://medflow-xxx.vercel.app`.

(Netlify works too: `apps/pos/netlify.toml` is ready.)

## 7. First use

1. **Owner sign-in:** open the link and sign in with the owner email and password. MedFlow shows a **QR code**: scan it with Google Authenticator or Microsoft Authenticator, then type the 6-digit code. From now on you can open the back office from home or your phone.
2. **Shop setup:** in the back office, add your medicines (Products & stock), staff with PINs (Team) and suppliers.
3. **Counter PC:** at the shop, open the same link on the counter PC, sign in as the owner, and press **New sale → Use this computer as a counter**. That PC now opens straight to the staff PIN screen.

## What runs where

| Mode | When | Data |
|---|---|---|
| Demo | No Supabase keys set (e.g. `pnpm --filter @medflow/pos dev` on your PC) | Demo Pharmacy inside that browser only |
| Cloud | The two keys are set (Vercel) | One shared database for the pharmacy: every PC, phone and browser sees the same |

**Offline selling** (a counter that keeps selling without internet and syncs later) is built into the server: the outbox and replay are tested. It switches on with the Windows desktop app plus PowerSync, which needs a PowerSync account and Rust installed. Until then, the web counter needs internet.
