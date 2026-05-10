// netlify/functions/confirm-receipt.js
// RAC v1 — Recipient Confirmation Handler (fully self-contained)

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

  if (event.httpMethod !== 'POST') {
    return err('Method not allowed', 405);
  }

  try {
    const body = JSON.parse(event.body);
    const proofId = body.proofId;
    if (!proofId) return err('Proof ID required');

    const supabase = getSupabase();

    const recipientIp = event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown';
    const userAgent = event.headers['user-agent'] || 'unknown';
    const confirmedAt = new Date().toISOString();

    const { data, error } = await supabase
      .from('proofs')
      .update({
        recipient_confirmed: true,
        recipient_confirmed_at: confirmedAt,
        recipient_confirmation_ip: recipientIp,
        recipient_confirmation_user_agent: userAgent,
        status: 'confirmed'
      })
      .eq('id', proofId)
      .select();

    if (error) return err('Confirmation failed: ' + error.message);
    if (!data || data.length === 0) return err('Proof not found', 404);

    console.log('[confirm-receipt] Proof ' + proofId + ' confirmed by recipient at ' + recipientIp);

    return ok({
      success: true,
      proofId,
      confirmedAt,
      recipientIp
    });

  } catch (e) {
    console.error('[confirm-receipt] Error:', e.message);
    return err('Failed to confirm receipt: ' + e.message);
  }
};
