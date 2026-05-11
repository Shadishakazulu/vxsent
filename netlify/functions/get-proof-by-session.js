// netlify/functions/get-proof-by-session.js
// SENT. — Get proof by Stripe session_id
// Used by receipt page when only session_id is available in URL

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  const sessionId = event.queryStringParameters && event.queryStringParameters.session_id;

  if (!sessionId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Session ID required' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Query by stripe_session_id first (fastest)
    const { data: proof, error } = await supabase
      .from('proofs')
      .select('*')
      .eq('stripe_session_id', sessionId)
      .maybeSingle();

    if (error) {
      console.error('[get-proof-by-session] DB error:', JSON.stringify(error));
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database error' }) };
    }

    if (!proof) {
      // Also try stripe_payment_id in case session_id was stored there
      const { data: proof2, error: err2 } = await supabase
        .from('proofs')
        .select('*')
        .eq('stripe_payment_id', sessionId)
        .maybeSingle();

      if (err2 || !proof2) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Proof not found yet' }) };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ proof: proof2 }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ proof })
    };

  } catch (err) {
    console.error('[get-proof-by-session] Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
