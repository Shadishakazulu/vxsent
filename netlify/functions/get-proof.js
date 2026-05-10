// netlify/functions/get-proof.js
// SENT. Master Reference v1.0 — Section 3, Step 3
// GET /api/proof/:id — Returns full proof data, logs access event

const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Extract proofId from path: /api/proof/[proofId]
  const pathParts = event.path.split('/');
  const proofId = pathParts[pathParts.length - 1];

  if (!proofId || proofId === 'get-proof') {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Proof ID required' }) };
  }

  try {
    const supabase = getSupabase();

    // Fetch proof record
    const { data: proof, error } = await supabase
      .from('proofs')
      .select('*')
      .eq('id', proofId)
      .maybeSingle();

    if (error) {
      console.error('[SENT] get-proof error:', error.message);
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Failed to retrieve proof' }) };
    }

    if (!proof) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Proof not found' }) };
    }

    // Get access count from proof_access_events
    const { count: accessCount } = await supabase
      .from('proof_access_events')
      .select('id', { count: 'exact', head: true })
      .eq('proof_id', proofId);

    // Log access event (spec Section 3, Step 3)
    const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    const userAgent = event.headers['user-agent'] || 'unknown';
    const referrer = event.headers['referer'] || event.headers['referrer'] || null;

    try {
      await supabase.from('proof_access_events').insert({
        proof_id: proofId,
        accessed_at: new Date().toISOString(),
        ip_address: ip.split(',')[0].trim(),
        user_agent: userAgent.substring(0, 255),
        referrer: referrer ? referrer.substring(0, 500) : null,
        confirmed: false
      });
    } catch (logErr) {
      console.warn('[SENT] Access log failed (non-fatal):', logErr.message);
    }

    // Build response per spec Section 3, Step 3
    const response = {
      id: proof.id,
      fileName: proof.file_name,
      fileSize: proof.file_size,
      fileHash: proof.file_hash,
      veridexProofId: proof.veridex_proof_id,
      veridexSignature: proof.veridex_signature,
      sealedAt: proof.sealed_at,
      isValid: proof.is_valid,
      verifyUrl: `https://vxsent.com/verify/${proof.id}`,
      rac: {
        enabled: proof.rac_enabled || false,
        chainHash: proof.rac_chain_hash || null,
        authorizedRecipient: proof.recipient_email || null,
        project: proof.project_name || null
      },
      accessCount: (accessCount || 0) + 1,
      recipientConfirmed: proof.recipient_confirmed || false,
      recipientConfirmedAt: proof.recipient_confirmed_at || null,
      recipientConfirmationHash: proof.recipient_confirmation_hash || null,
      userEmail: proof.user_email,
      recipientEmail: proof.recipient_email,
      projectName: proof.project_name,
      status: proof.status
    };

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(response)
    };

  } catch (e) {
    console.error('[SENT] get-proof unhandled error:', e.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Failed to retrieve proof' })
    };
  }
};
