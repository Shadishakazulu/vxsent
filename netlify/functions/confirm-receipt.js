// netlify/functions/confirm-receipt.js
// RAC v1 — Recipient Confirmation Handler
// Records when recipient confirms they received the delivery

const { getSupabase, ok, err, corsHeaders } = require('../../src/lib/index.js' );

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS' ) {
    return { statusCode: 204, headers: corsHeaders };
  }

  if (event.httpMethod !== 'POST' ) {
    return err('Method not allowed', 405);
  }

  try {
    const body = JSON.parse(event.body);
    const proofId = body.proofId;

    if (!proofId) return err('Proof ID required');

    const supabase = getSupabase();

    // Get recipient IP and user-agent
    const recipientIp = event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown';
    const userAgent = event.headers['user-agent'] || 'unknown';
    const confirmedAt = new Date().toISOString();

    // Update proof with recipient confirmation
    const { data, error } = await supabase
      .from('proofs')
      .update({
        recipient_confirmed: true,
        recipient_confirmed_at: confirmedAt,
        recipient_confirmation_ip: recipientIp,
        recipient_confirmation_user_agent: userAgent,
        status: 'confirmed'
      })
      .eq('proof_id', proofId)
      .select();

    if (error) return err(`Confirmation failed: ${error.message}`);
    if (!data || data.length === 0) return err('Proof not found', 404);

    console.log(`[confirm-receipt] Proof ${proofId} confirmed by recipient at ${recipientIp}`);

    return ok({
      success: true,
      proofId,
      confirmedAt,
      recipientIp
    });

  } catch (error) {
    console.error('[confirm-receipt] Error:', error.message);
    return err(`Failed to confirm receipt: ${error.message}`);
  }
};
