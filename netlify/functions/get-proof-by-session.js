// netlify/functions/get-proof-by-session.js
// Looks up a proof by Stripe checkout session ID (stripe_payment_id)
// Called by receipt.html after Stripe redirects back with ?session_id=

const { getSupabase, ok, err, corsHeaders } = require('../../src/lib/index.js');

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  if (event.httpMethod !== 'GET') {
    return err('Method not allowed', 405);
  }

  try {
    const sessionId = event.queryStringParameters?.session_id;
    if (!sessionId) return err('session_id is required');

    const supabase = getSupabase();

    // The webhook stores the Stripe session ID in stripe_payment_id
    const { data, error } = await supabase
      .from('proofs')
      .select('*')
      .eq('stripe_payment_id', sessionId)
      .single();

    if (error || !data) {
      // Proof may not be created yet (webhook hasn't fired) — return 404 so client can retry
      return err('Proof not found yet', 404);
    }

    return ok({
      ...data,
      recipientConfirmed: data.recipient_confirmed,
      recipientConfirmedAt: data.recipient_confirmed_at,
      recipientConfirmationIp: data.recipient_confirmation_ip,
      recipientConfirmationUserAgent: data.recipient_confirmation_user_agent
    });

  } catch (error) {
    console.error('[get-proof-by-session] Error:', error.message);
    return err(`Failed to retrieve proof: ${error.message}`);
  }
};
