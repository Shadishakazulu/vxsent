// netlify/functions/get-proof.js
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  // Read ID from query param OR from path
  let proofId = (event.queryStringParameters && event.queryStringParameters.id)
    || event.path.split('/').pop();

  // Clean up the ID
  if (proofId) proofId = decodeURIComponent(proofId).trim();

  console.log('[get-proof] proofId:', proofId, '| path:', event.path, '| qs:', JSON.stringify(event.queryStringParameters));

  if (!proofId || !proofId.startsWith('SENT-')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid Proof ID required', received: proofId }) };
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not configured' }) };
  }

  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(supabaseUrl, supabaseKey);

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
      console.log('[get-proof] Not found:', proofId);
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Proof not found' }) };
    }

    // Normalize proof_id field
    proof.proof_id = proof.id;

    // Log access event (best effort)
    try {
      await supabase.from('proof_access_events').insert({
        proof_id: proofId,
        accessed_at: new Date().toISOString(),
        ip_address: event.headers['x-forwarded-for'] || null,
        user_agent: event.headers['user-agent'] || null,
        referrer: event.headers['referer'] || null,
        confirmed: false
      });
    } catch (logErr) {}

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
