// netlify/functions/create-transfer-payment.js
// SENT Transfer — single-transfer pay-per-use ($X.99).
// Mirrors create-payment-intent.js: creates a PaymentIntent for an existing
// PENDING transfer, with metadata.product='single_transfer' so the webhook seals it.
//
// Flow: seller fills transfer.html WITHOUT an active plan → create-transfer still
// inserts the pending record (see note) → this creates the PI → buyer pays →
// webhook seals. For the FIRST release we gate sealing behind a plan in
// create-transfer.js; this endpoint is the pay-per-use alternative for guests.

const crypto = require('crypto');

const SINGLE_TRANSFER_PRICE_CENTS = 499; // $4.99

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }) };
    const stripe = require('stripe')(stripeKey);

    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    const { transferId, sellerEmail } = body;
    if (!transferId || !transferId.startsWith('SENT-TX-')) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid transfer ID required' }) };
    if (!sellerEmail || !isValidEmail(sellerEmail)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid seller email required' }) };

    // Confirm the transfer exists and is still pending
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not configured' }) };

    const lookup = await fetch(`${supabaseUrl}/rest/v1/transfers?id=eq.${encodeURIComponent(transferId)}&select=id,is_valid,item_title`, {
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' }
    });
    const rows = await lookup.json();
    if (!Array.isArray(rows) || rows.length === 0) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Transfer not found' }) };
    if (rows[0].is_valid) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Transfer already sealed' }) };

    const paymentIntent = await stripe.paymentIntents.create({
      amount: SINGLE_TRANSFER_PRICE_CENTS,
      currency: 'usd',
      metadata: {
        product: 'single_transfer',
        transfer_id: transferId,
        seller_email: sellerEmail
      }
    });

    // Audit row (non-fatal)
    try {
      await fetch(`${supabaseUrl}/rest/v1/payments`, {
        method: 'POST',
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stripe_payment_id: paymentIntent.id,
          user_email: sellerEmail,
          amount: SINGLE_TRANSFER_PRICE_CENTS,
          currency: 'usd',
          payment_type: 'single_transfer',
          status: 'pending',
          created_at: new Date().toISOString()
        })
      });
    } catch (e) { console.error('[create-transfer-payment] audit insert failed (non-fatal):', e.message); }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        transferId,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
      })
    };
  } catch (err) {
    console.error('[create-transfer-payment] error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payment initialization failed. Please try again.' }) };
  }
};
