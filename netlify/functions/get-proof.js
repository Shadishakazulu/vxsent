// netlify/functions/get-proof.js
// RAC v1 — Proof Retrieval with Recipient Confirmation Status
// Returns full proof data including recipient confirmation fields

const { getSupabase, ok, err, corsHeaders } = require('../../src/lib/index.js' );

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS' ) {
    return { statusCode: 204, headers: corsHeaders };
  }

  if (event.httpMethod !== 'GET' ) {
    return err('Method not allowed', 405);
  }

  try {
    const proofId = event.queryStringParameters?.id;
    if (!proofId) return err('Proof ID required');

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('proofs')
      .select('*')
      .eq('proof_id', proofId)
      .single();

    if (error || !data) return err('Proof not found', 404);

    // Return proof with recipient confirmation fields
    return ok({
      ...data,
      recipientConfirmed: data.recipient_confirmed,
      recipientConfirmedAt: data.recipient_confirmed_at,
      recipientConfirmationIp: data.recipient_confirmation_ip,
      recipientConfirmationUserAgent: data.recipient_confirmation_user_agent
    });

  } catch (error) {
    console.error('[get-proof] Error:', error.message);
    return err(`Failed to retrieve proof: ${error.message}`);
  }
};
