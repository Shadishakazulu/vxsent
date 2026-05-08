# Netlify Webhook Deployment Guide

## Overview
This guide walks you through deploying the Stripe webhook function to Netlify for your SENT. platform.

## Files Included
- `stripe-webhook.js` - The webhook function handler
- `package.json` - Dependencies (stripe, @supabase/supabase-js)
- `netlify.toml` - Configuration file

## Step 1: Update Your GitHub Repository

1. In your GitHub repository root, create the following structure:
```
netlify/
  functions/
    stripe-webhook.js
package.json
netlify.toml
```

2. Copy the files:
   - `stripe-webhook.js` → `netlify/functions/stripe-webhook.js`
   - `package.json` → `package.json` (merge with existing if needed)
   - `netlify.toml` → `netlify.toml` (merge with existing if needed)

3. Commit and push to GitHub:
```bash
git add netlify/ package.json netlify.toml
git commit -m "Add Stripe webhook function for Netlify"
git push origin main
```

## Step 2: Configure Environment Variables in Netlify

1. Go to your Netlify dashboard: https://app.netlify.com
2. Select your project: **melodious-belekoy-881d39**
3. Go to **Settings** → **Build & Deploy** → **Environment**
4. Add the following environment variables:
   - `STRIPE_SECRET_KEY` - Your live Stripe secret key
   - `STRIPE_WEBHOOK_SECRET` - Your Stripe webhook signing secret
   - `SUPABASE_URL` - `https://fjowiopznwafjqhdbrsv.supabase.co`
   - `SUPABASE_SERVICE_KEY` - Your Supabase service role key

## Step 3: Deploy

Netlify will automatically deploy when you push to GitHub. You can also manually trigger a deploy:

1. In Netlify dashboard, go to **Deploys**
2. Click **Trigger deploy** → **Deploy site**

## Step 4: Configure Stripe Webhook

1. Go to your Stripe Dashboard: https://dashboard.stripe.com
2. Navigate to **Developers** → **Webhooks**
3. Click **Add endpoint**
4. Endpoint URL: `https://vxsent.com/.netlify/functions/stripe-webhook`
5. Events to send:
   - `checkout.session.completed`
   - `charge.failed`
   - `charge.refunded`
6. Click **Add endpoint**
7. Copy the **Signing secret** and add it to Netlify as `STRIPE_WEBHOOK_SECRET`

## Step 5: Test the Webhook

### Test with Stripe CLI (Optional)
```bash
stripe listen --forward-to vxsent.com/.netlify/functions/stripe-webhook
stripe trigger checkout.session.completed
```

### Test with Your Site
1. Go to your site: https://vxsent.com
2. Upload a file and complete a test payment (card: 4242 4242 4242 4242)
3. Check Netlify logs for webhook execution
4. Verify proof appears in Supabase

## Monitoring

### View Webhook Logs
1. Netlify Dashboard → **Functions** → **stripe-webhook**
2. View real-time logs and errors

### View Stripe Webhook Events
1. Stripe Dashboard → **Developers** → **Webhooks**
2. Click your endpoint to see event history

## Troubleshooting

### Webhook Not Triggering
- Verify endpoint URL is correct
- Check Stripe webhook signing secret matches `STRIPE_WEBHOOK_SECRET`
- Check Netlify environment variables are set

### Proof Not Storing
- Check Supabase credentials are correct
- Verify `proofs` table exists with correct schema
- Check Netlify function logs for errors

### 502 Bad Gateway
- Check all environment variables are set
- Verify Supabase is accessible
- Check function timeout (default 10s)

## Next Steps
1. Test with live Stripe keys (not test keys)
2. Monitor webhook events in Stripe Dashboard
3. Set up alerts for failed webhook deliveries
4. Document webhook event handling in your team wiki
