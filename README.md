# SENT. / vxsent

SENT. is a proof-of-delivery web app for freelancers, agencies, creators, and teams. A user hashes a deliverable, pays for a proof, and receives a permanent verification link showing what was delivered and when.

## Core flow

1. User selects a deliverable in the browser.
2. Browser computes the file SHA-256 hash.
3. User pays through Stripe.
4. Stripe webhook seals the proof.
5. Proof is stored in Supabase.
6. Sender receives a receipt link.
7. Recipient can open or confirm the proof without creating an account.

## Tech stack

- Static HTML frontend
- Netlify Functions
- Stripe PaymentIntents / Checkout / webhooks
- Supabase Postgres
- Resend transactional email
- Veridex / RAC sealing layer

## Required environment variables

Copy `.env.example` to `.env` locally and configure the same variables in Netlify.

Never commit real secrets.

## Local development

```bash
npm install
npm run dev
```

## Checks

```bash
npm run check
```

## Production hardening checklist

- Keep all secret keys server-side only.
- Use `SUPABASE_SERVICE_KEY` only inside Netlify Functions.
- Use `SUPABASE_ANON_KEY` only for public read flows.
- Require `STRIPE_WEBHOOK_SECRET` in production.
- Do not disable Netlify secret scanning.
- Use one canonical page per route:
  - `index.html`
  - `pricing.html`
  - `login.html`
  - `dashboard.html`
  - `receipt.html`
  - `verify.html`
- Archive duplicate pages such as `*-final.html`, `*-production.html`, and `index_updated.html` after confirming they are no longer linked.

## Database

Apply `supabase-schema-final.sql` in Supabase SQL editor. For production, use the hardened RLS policies in that file.

## Deployment

1. Push to GitHub.
2. Connect repo to Netlify.
3. Set environment variables.
4. Configure Stripe webhook endpoint:
   - `https://vxsent.com/.netlify/functions/stripe-webhook`
5. Run a test payment.
6. Confirm proof creation, receipt email, and verification page.
