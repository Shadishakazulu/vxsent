// netlify/functions/get-proof.js
// SENT. — Get proof by proof_id
// Used by receipt page to poll for proof status

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

  const proofId = event.queryStringParameters && event.queryStringParameters.id;

  if (!proofId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Proof ID required' }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);

    // FIX: column is 'id' not 'proof_id'
    const { data: proof, error } = await supabase
      .from('proofs')
      .select('*')
      .eq('id', proofId)
      .maybeSingle();

    if (error) {
      console.error('[get-proof] DB error:', JSON.stringify(error));
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database error' }) };
    }

    if (!proof) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Proof not found' }) };
    }

    // Normalize proof_id field for receipt page
    proof.proof_id = proof.proof_id || proof.id;

    // Log access event (best effort)
    try {
      await supabase.from('proof_access_events').insert({
        proof_id: proofId,
        accessed_at: new Date().toISOString(),
        ip_address: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
        user_agent: event.headers['user-agent'] || null,
        referrer: event.headers['referer'] || null,
        confirmed: false
      });
    } catch (logErr) {
      // Non-fatal
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ proof })
    };

  } catch (err) {
    console.error('[get-proof] Error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
