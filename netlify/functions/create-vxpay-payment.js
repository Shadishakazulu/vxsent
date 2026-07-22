// netlify/functions/create-vxpay-payment.js
// VX Pay — pay-per-use escrow agreement seal ($7.99).
// Mirrors create-transfer-payment.js: creates a Stripe PaymentIntent for an
// existing PENDING agreement, with metadata.product='vxpay_agreement' so the
// Stripe webhook seals it after payment succeeds.
//
// NOTE: VX Pay agreements are persisted on the Netlify Database (managed
// Postgres), so the agreement lookup uses the Netlify DB driver. The `payments`
// audit table still lives in Supabase, matching the Transfer flow.
//
// Flow: user fills vxpay.html → create-vxpay inserts the pending agreement →
// this creates the PaymentIntent → user pays → webhook seals (RAC + signature).

import Stripe from 'stripe';
import { getDb, getSupabase, CORS_HEADERS } from './_vxpay-common.js';

const VXPAY_PRICE_CENTS = 799; // $7.99 per escrow agreement

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }) };
    const stripe = Stripe(stripeKey);

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    const { agreementId, payerEmail } = body;
    if (!agreementId || !agreementId.startsWith('VXPAY-')) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Valid VX Pay agreement ID required' }) };
    if (!payerEmail || !isValidEmail(payerEmail)) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Valid email required' }) };

    // Confirm the agreement exists and is still pending (not already sealed).
    const db = getDb();
    const rows = await db.sql`SELECT id, is_valid, item_title FROM vxpay_agreements WHERE id = ${agreementId}`;
    if (!rows || rows.length === 0) return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Agreement not found' }) };
    if (rows[0].is_valid) return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Agreement already sealed' }) };

    const paymentIntent = await stripe.paymentIntents.create({
      amount: VXPAY_PRICE_CENTS,
      currency: 'usd',
      metadata: {
        product: 'vxpay_agreement',
        vxpay_id: agreementId,
        payer_email: payerEmail
      }
    });

    // Audit row in Supabase `payments` (non-fatal) — mirrors the Transfer flow.
    try {
      const supabase = getSupabase();
      await supabase.from('payments').insert({
        stripe_payment_id: paymentIntent.id,
        user_email: payerEmail,
        amount: VXPAY_PRICE_CENTS,
        currency: 'usd',
        payment_type: 'vxpay_agreement',
        status: 'pending',
        created_at: new Date().toISOString()
      });
    } catch (e) { console.error('[create-vxpay-payment] audit insert failed (non-fatal):', e.message); }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        agreementId,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
      })
    };
  } catch (err) {
    console.error('[create-vxpay-payment] error:', err.message);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Payment initialization failed. Please try again.' }) };
  }
}
