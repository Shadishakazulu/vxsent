// netlify/functions/get-proof.js
// RAC v1 — Proof Retrieval (fully self-contained, no relative imports)

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
    const proofId = event.queryStringParameters?.id;
    if (!proofId) return err('Proof ID required');

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('proofs')
      .select('*')
      .eq('id', proofId)
      .single();

    if (error || !data) return err('Proof not found', 404);

    return ok({
      ...data,
      recipientConfirmed: data.recipient_confirmed,
      recipientConfirmedAt: data.recipient_confirmed_at,
      recipientConfirmationIp: data.recipient_confirmation_ip,
      recipientConfirmationUserAgent: data.recipient_confirmation_user_agent
    });

  } catch (e) {
    console.error('[get-proof] Error:', e.message);
    return err('Failed to retrieve proof: ' + e.message);
  }
};
