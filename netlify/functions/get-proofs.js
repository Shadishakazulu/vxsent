// netlify/functions/get-proof.js
// Production-grade: queries Supabase for proof data by proof_id

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // The redirect rule sends /api/proof/:id → get-proof?id=:id
    const proofId = event.queryStringParameters?.id || event.queryStringParameters?.proofId;

    if (!proofId) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Proof ID required' })
      };
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      console.error('Supabase credentials not configured');
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Service unavailable' })
      };
    }

    // Query Supabase for the proof record
    const response = await fetch(
      `${supabaseUrl}/rest/v1/proofs?proof_id=eq.${encodeURIComponent(proofId)}&limit=1`,
      {
        method: 'GET',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Supabase query failed: ${response.status} ${errText}`);
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Failed to retrieve proof' })
      };
    }

    const results = await response.json();

    if (!results || results.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Proof not found' })
      };
    }

    const proof = results[0];

    // Check if proof is still pending payment
    if (proof.status === 'pending') {
      return {
        statusCode: 202,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Proof is pending — payment not yet confirmed',
          status: 'pending',
          id: proof.proof_id
        })
      };
    }

    // Return full proof data for verified/sealed proofs
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      },
      body: JSON.stringify({
        id: proof.proof_id,
        proofId: proof.proof_id,
        fileName: proof.file_name,
        fileSize: proof.file_size,
        fileHash: proof.file_hash,
        sealedAt: proof.sealed_at || proof.timestamp,
        verifiedAt: proof.verified_at,
        status: proof.status,
        isValid: proof.is_valid,
        racSignature: proof.rac_signature,
        racEnabled: proof.rac_enabled,
        senderEmail: proof.sender_email,
        recipientEmail: proof.recipient_email,
        projectName: proof.project_name,
        receiptUrl: proof.receipt_url,
        veridexProofId: proof.veridex_proof_id,
        veridexSignature: proof.veridex_signature
      })
    };
  } catch (error) {
    console.error('get-proof error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to retrieve proof' })
    };
  }
};
