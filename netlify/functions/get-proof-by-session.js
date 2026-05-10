// netlify/functions/get-proof-by-session.js
// SENT. Master Reference v1.0 — Section 3
// Looks up a proof by Stripe session_id or payment_intent_id
// Called by receipt.html when only session_id is in the URL

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }

  const sessionId = event.queryStringParameters?.session_id;
  if (!sessionId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'session_id required' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB not configured' }) };
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Strategy 1: Query by stripe_session_id directly
    const { data: bySession } = await supabase
      .from('proofs')
      .select('id, is_valid, status')
      .eq('stripe_session_id', sessionId)
      .single();

    if (bySession) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ proofId: bySession.id, isValid: bySession.is_valid })
      };
    }

    // Strategy 2: Query by stripe_payment_id = sessionId (fallback)
    const { data: byPayment } = await supabase
      .from('proofs')
      .select('id, is_valid, status')
      .eq('stripe_payment_id', sessionId)
      .single();

    if (byPayment) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ proofId: byPayment.id, isValid: byPayment.is_valid })
      };
    }

    // Strategy 3: Use Stripe API to get the PaymentIntent from the session
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey && sessionId.startsWith('cs_')) {
      try {
        const stripe = require('stripe')(stripeKey);
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        // Check metadata for proof_id
        if (session.metadata?.proof_id) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ proofId: session.metadata.proof_id, isValid: false })
          };
        }

        // Try to find by PaymentIntent ID
        if (session.payment_intent) {
          const { data: byPI } = await supabase
            .from('proofs')
            .select('id, is_valid')
            .eq('stripe_payment_id', session.payment_intent)
            .single();

          if (byPI) {
            return {
              statusCode: 200,
              headers,
              body: JSON.stringify({ proofId: byPI.id, isValid: byPI.is_valid })
            };
          }
        }
      } catch (stripeErr) {
        console.error('[get-proof-by-session] Stripe lookup error:', stripeErr.message);
      }
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Proof not found yet' })
    };

  } catch (err) {
    console.error('[get-proof-by-session] Error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error' })
    };
  }
};
