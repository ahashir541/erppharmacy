# Nuskha website

Static site (plain HTML, CSS and JavaScript). Live at https://nuskhapk.vercel.app (Vercel project `medflow-site`).

- `index.html` home page (one screen per section on desktop) · `download.html` · `login.html` · `about.html` · `release-notes.html` · `blog/`
- `styles.css` design · `script.js` settings, shared header and footer, menus, blog search, demo form, WhatsApp button
- `img/` screenshots (WebP) and icons · `download/Nuskha.zip` the installer (not in git; copied in at deploy)

## Placeholders to fill (top of `script.js`, object `SITE`)
Anything left empty is hidden on the page.

| Setting | Now | Notes |
|---|---|---|
| `phone`, `whatsapp`, `email` | filled | WhatsApp button and footer |
| `address` | empty | footer |
| `demo_url` | empty | "Try the live demo" button |
| `client_count` | empty | only a verified number |
| `regulators` | empty | regulators Nuskha's records actually support |
| `fbr_integration` | false | the FBR section stays hidden (not built) |
| `measured_expiry_reduction`, `measured_hours_saved` | empty | only measured results |
| `certifications` | empty | only certificates actually held |
| `socials` | empty | only profiles that exist |
| JSON-LD `offers.price` in `index.html` | `[price]` | your monthly price |

## Demo requests
"Request a Demo" saves to the Supabase table `public.leads` (visitors can add, never read). Read them in
Supabase → Table editor → `leads`. No email or WhatsApp alert is sent yet (needs an email service).

## Deploy
`vercel deploy --prod` from this folder (after copying `apps/server/release/Nuskha.zip` to `download/` and updating its SHA-256 in `download.html`).

## Checklist before launch
- [x] No competitor text, logos, images, statistics or contact details (layout inspired by a reference site; all copy written for Nuskha)
- [x] No invented numbers: client count, results and certifications are placeholders and hidden while empty
- [x] Features listed exist in the app; unbuilt ones (FBR, prescription uploads, Roman Urdu) are not claimed
- [x] Every image has alt text; keyboard focus is visible; contrast meets WCAG AA
- [x] Security headers (CSP, HSTS, nosniff, frame-ancestors) in `vercel.json`
- [ ] Fill the placeholders above
- [ ] Your own domain (e.g. nuskha.pk) and update the canonical URLs
