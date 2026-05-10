// netlify/functions/get-proof-by-session.js
// Looks up a proof by Stripe checkout session ID (fully self-contained).

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function ok(data) {
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
}

function err(message, statusCode) {
  return { statusCode: statusCode || 400, headers: corsHeaders, body: JSON.stringify({ error: message }) };
}

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  if (event.httpMethod !== 'GET') {
    return err('Method not allowed', 405);
  }

  try {
    const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;
    if (!sessionId) return err('session_id is required');

    const supabase = getSupabase();

    // First try: look up by session ID directly (cs_xxx stored as stripe_payment_id)
    const { data: bySession } = await supabase
      .from('proofs')
      .select('*')
      .eq('stripe_payment_id', sessionId)
      .maybeSingle();

    if (bySession) {
      return ok(bySession);
    }

    // Second try: retrieve the session from Stripe to get the payment_intent ID
    let paymentIntentId = null;
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      paymentIntentId = session.payment_intent;
    } catch (stripeErr) {
      console.warn('[get-proof-by-session] Could not retrieve session from Stripe:', stripeErr.message);
    }

    if (paymentIntentId) {
      const { data: byIntent } = await supabase
        .from('proofs')
        .select('*')
        .eq('stripe_payment_id', paymentIntentId)
        .maybeSingle();

      if (byIntent) {
        return ok(byIntent);
      }
    }

    // Proof not found — webhook may not have fired yet, return 404 so client can retry
    return err('Proof not found yet', 404);

  } catch (e) {
    console.error('[get-proof-by-session] Error:', e.message);
    return err('Failed to retrieve proof: ' + e.message);
  }
};
