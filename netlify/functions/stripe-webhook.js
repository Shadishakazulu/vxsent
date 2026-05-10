// netlify/functions/stripe-webhook.js
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getSupabase, ok, err, corsHeaders, sendRecipientNotification } = require('../../src/lib/index.js');

const ED25519_PRIVATE_KEY = process.env.ED25519_PRIVATE_KEY;

function signWithEd25519(message) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(ED25519_PRIVATE_KEY, 'base64'),
    format: 'der',
    type: 'pkcs8'
  });
  return crypto.sign('sha256', Buffer.from(message), key).toString('hex');
}

function computeChainHash(previousHash, signature) {
  return crypto.createHash('sha256').update((previousHash || '0') + signature).digest('hex');
}

exports.handler = async (event, context) => {
  console.log('[webhook] Received request');

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  if (event.httpMethod !== 'POST') {
    return err('Method not allowed', 405);
  }

  try {
    const sig = event.headers['stripe-signature'];
    const body = event.body;

    console.log('[webhook] Verifying signature');

    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      console.error('[webhook] Signature error:', e.message);
      return err(`Signature failed: ${e.message}`);
    }

    console.log(`[webhook] Event type: ${stripeEvent.type}`);

    // Handle checkout.session.completed (fired by Stripe Checkout Sessions)
    if (stripeEvent.type !== 'checkout.session.completed') {
      console.log('[webhook] Ignoring non-checkout event:', stripeEvent.type);
      return ok({ received: true });
    }

    const session = stripeEvent.data.object;
    const metadata = session.metadata || {};

    console.log('[webhook] Session metadata:', JSON.stringify(metadata));

    const recipientEmail = metadata.recipient_email;
    const senderEmail = metadata.sender_email;
    const fileName = metadata.file_name || 'Verified Delivery';
    const fileHash = metadata.file_hash || '';

    if (!recipientEmail || !senderEmail) {
      console.error('[webhook] Missing emails:', { recipientEmail, senderEmail });
      return err('Missing recipient or sender email');
    }

    console.log('[webhook] Creating proof');

    const proofId = `proof_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sealedAt = new Date().toISOString();
    const messageToSign = `${proofId}|${senderEmail}|${recipientEmail}|${sealedAt}`;
    const signature = signWithEd25519(messageToSign);
    const chainHash = computeChainHash(null, signature);

    console.log('[webhook] Proof ID:', proofId);
    console.log('[webhook] Signature:', signature.substring(0, 20) + '...');

    const supabase = getSupabase();

    console.log('[webhook] Inserting into Supabase');

    const { data, error } = await supabase
      .from('proofs')
      .insert({
        id: proofId,
        proof_id: proofId,
        file_name: fileName,
        file_hash: fileHash,
        sender_email: senderEmail,
        recipient_email: recipientEmail,
        status: 'sealed',
        is_valid: true,
        sealed_at: sealedAt,
        ed25519_signature: signature,
        chain_hash: chainHash,
        stripe_payment_id: session.payment_intent || session.id,
        amount_cents: session.amount_total,
        user_email: senderEmail,
        timestamp: sealedAt,
        rac_enabled: true,
        rac_version: '1.0'
      })
      .select();

    if (error) {
      console.error('[webhook] Supabase error:', error.message, error.details);
      return err(`Supabase failed: ${error.message}`);
    }

    console.log('[webhook] Proof created:', proofId);

    // Send emails
    try {
      await sendRecipientNotification({
        recipientEmail,
        senderEmail,
        proofId,
        fileName,
        sealedAt
      });
      console.log('[webhook] Emails sent');
    } catch (emailErr) {
      console.error('[webhook] Email error:', emailErr.message);
    }

    return ok({ received: true, proofId });

  } catch (error) {
    console.error('[webhook] Fatal error:', error.message, error.stack);
    return err(`Error: ${error.message}`);
  }
};
