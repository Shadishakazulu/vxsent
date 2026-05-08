# SENT. Platform - Complete Deployment Guide

## 🚀 Production Deployment Steps

This guide walks you through deploying the SENT. platform with full Supabase integration and live Stripe payments.

---

## Step 1: Create Supabase Project (5 minutes)

### 1.1 Create Account & Project
1. Go to [supabase.com](https://supabase.com)
2. Sign up or log in
3. Click "New Project"
4. Fill in:
   - **Name**: `sent-platform`
   - **Database Password**: Create a strong password (save it!)
   - **Region**: Choose closest to your users
5. Click "Create new project" and wait for initialization (2-3 minutes)

### 1.2 Get Your Credentials
Once the project is created:
1. Go to **Settings** → **API**
2. Copy these values (you'll need them):
   - **Project URL** (e.g., `https://abc123.supabase.co`)
   - **anon public** key (for frontend)
   - **service_role** key (for backend/webhook)

### 1.3 Create Database Schema
1. Go to **SQL Editor** in Supabase dashboard
2. Click "New Query"
3. Copy the entire contents of `supabase-schema-final.sql`
4. Paste into the query editor
5. Click "Run"
6. Verify the `proofs` table appears in the left sidebar

---

## Step 2: Update Frontend Pages (5 minutes)

### 2.1 Update Verification Page
1. Open `verify-final.html`
2. Find these lines (around line 280):
   ```javascript
   const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
   ```
3. Replace with your actual credentials:
   ```javascript
   const SUPABASE_URL = 'https://abc123.supabase.co';
   const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
   ```
4. Save the file

### 2.2 Update Admin Dashboard
1. Open `admin-dashboard-final.html`
2. Find these lines (around line 330):
   ```javascript
   const SUPABASE_URL = 'https://YOUR_PROJECT_ID.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
   ```
3. Replace with your actual credentials (same as above)
4. Save the file

### 2.3 Upload to GitHub
1. Go to your GitHub repository
2. Upload the updated HTML files:
   - `verify-final.html` → rename to `verify.html`
   - `admin-dashboard-final.html` → rename to `admin-dashboard.html`
3. Commit with message: "Update: Add Supabase integration to verification and admin pages"

---

## Step 3: Deploy Webhook Function (10 minutes)

### 3.1 Update Netlify Function
1. Go to your Netlify dashboard
2. Navigate to **Functions**
3. Open `stripe-webhook.js` (or create if doesn't exist)
4. Replace entire contents with `stripe-webhook-final.js`
5. Save the file

### 3.2 Add Environment Variables
1. In Netlify, go to **Site Settings** → **Build & Deploy** → **Environment**
2. Add these variables:
   ```
   SUPABASE_URL = https://abc123.supabase.co
   SUPABASE_ANON_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   SUPABASE_SERVICE_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   STRIPE_SECRET_KEY = sk_live_xxxxx (already set)
   STRIPE_WEBHOOK_SECRET = whsec_xxxxx (already set)
   ```
3. Click "Save"

### 3.3 Install Dependencies
1. In your project root, run:
   ```bash
   npm install @supabase/supabase-js
   ```
2. Commit and push to GitHub
3. Netlify will automatically redeploy

### 3.4 Verify Webhook Deployment
1. Go to Stripe Dashboard → **Developers** → **Webhooks**
2. Find your webhook endpoint (should be `https://your-domain.netlify.app/.netlify/functions/stripe-webhook`)
3. Click on it and check "Recent Events"
4. You should see successful webhook deliveries

---

## Step 4: Test End-to-End (15 minutes)

### 4.1 Test Verification Page
1. Open your verification page: `https://your-domain.com/verify.html`
2. Enter the test Proof ID: `PROOF-1234567890ABCDEF`
3. Click "Verify Proof"
4. You should see the sample proof details from the database

### 4.2 Test Payment Flow
1. Go to your landing page
2. Upload a test file
3. Click "Generate Proof"
4. Complete checkout with test card: `4242 4242 4242 4242`
5. Any expiration date in the future
6. Any CVC (e.g., `123`)
7. Click "Pay"

### 4.3 Verify Proof Created
1. After successful payment, you should see:
   - Receipt page with Proof ID
   - Proof stored in Supabase
2. Go to **Supabase Dashboard** → **Table Editor** → **proofs**
3. Verify the new proof appears in the table
4. Copy the Proof ID

### 4.4 Verify Proof Details
1. Go to verification page
2. Enter the Proof ID from step 4.3
3. Click "Verify Proof"
4. Confirm all details match

### 4.5 Test Admin Dashboard
1. Open admin dashboard: `https://your-domain.com/admin-dashboard.html`
2. Verify statistics show:
   - Total Proofs: 1 (or more)
   - Revenue: $0.99 (or more)
3. Verify the proof appears in the table
4. Click "View" to see full details
5. Test filters by sender/recipient email

---

## Step 5: Production Deployment (5 minutes)

### 5.1 Switch to Live Stripe Keys
1. In Netlify, go to **Environment Variables**
2. Update:
   ```
   STRIPE_SECRET_KEY = sk_live_xxxxx (your live key)
   STRIPE_WEBHOOK_SECRET = whsec_xxxxx (your live webhook secret)
   ```
3. Save and redeploy

### 5.2 Update Stripe Webhook
1. Go to Stripe Dashboard → **Developers** → **Webhooks**
2. Create a new webhook endpoint for production
3. URL: `https://your-production-domain.com/.netlify/functions/stripe-webhook`
4. Select events: `checkout.session.completed`, `charge.failed`, `charge.refunded`
5. Copy the webhook signing secret
6. Update `STRIPE_WEBHOOK_SECRET` in Netlify environment

### 5.3 Deploy to Production
1. Ensure all changes are committed to GitHub
2. Netlify will automatically deploy on push
3. Verify deployment completed successfully
4. Check site is live at your domain

### 5.4 Final Verification
1. Test with a small real payment ($0.99)
2. Verify proof appears in Supabase
3. Verify verification page works
4. Verify admin dashboard shows the transaction
5. Check Stripe dashboard for successful payment

---

## 📋 Deployment Checklist

- [ ] Supabase project created
- [ ] Database schema imported
- [ ] Supabase credentials saved
- [ ] `verify.html` updated with Supabase credentials
- [ ] `admin-dashboard.html` updated with Supabase credentials
- [ ] Webhook function updated with Supabase integration
- [ ] Environment variables set in Netlify
- [ ] `@supabase/supabase-js` installed
- [ ] Webhook deployed to Netlify
- [ ] Test proof verified successfully
- [ ] Test payment completed successfully
- [ ] Proof appears in Supabase
- [ ] Admin dashboard shows proof
- [ ] Live Stripe keys configured
- [ ] Live webhook endpoint created
- [ ] Production deployment verified
- [ ] Real payment tested
- [ ] All systems operational ✅

---

## 🔍 Troubleshooting

### Verification Page Shows "Configuration Incomplete"
**Solution**: Update `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `verify.html`

### Admin Dashboard Doesn't Load Proofs
**Solution**: 
1. Check browser console for errors (F12)
2. Verify Supabase credentials are correct
3. Ensure `proofs` table exists in Supabase
4. Check RLS policies are enabled

### Webhook Not Storing Proofs
**Solution**:
1. Check Netlify function logs
2. Verify `SUPABASE_SERVICE_KEY` is set correctly
3. Ensure webhook is receiving events (check Stripe dashboard)
4. Verify `@supabase/supabase-js` is installed

### Payment Completes But No Proof Created
**Solution**:
1. Check Stripe webhook delivery (Stripe Dashboard → Webhooks)
2. Check Netlify function logs for errors
3. Verify webhook endpoint URL is correct
4. Ensure `STRIPE_WEBHOOK_SECRET` matches

### Supabase Connection Errors
**Solution**:
1. Verify `SUPABASE_URL` is correct format
2. Check `SUPABASE_ANON_KEY` is not expired
3. Ensure RLS policies allow read/write access
4. Check browser network tab for CORS errors

---

## 📞 Support Resources

- **Supabase Docs**: https://supabase.com/docs
- **Stripe Docs**: https://stripe.com/docs
- **Netlify Docs**: https://docs.netlify.com
- **GitHub Issues**: Report bugs in your repository

---

## 🎉 Success!

Once all steps are complete, your SENT. platform is live and ready to:
- ✅ Accept payments for proof generation
- ✅ Store proofs permanently in Supabase
- ✅ Verify proofs publicly
- ✅ Manage proofs via admin dashboard
- ✅ Generate revenue ($0.99 per proof)

**Congratulations on launching SENT.!** 🚀

---

**Last Updated**: May 7, 2026
**Version**: 1.0 - Production Ready
