// netlify/functions/stripe-webhook.js
// SENT. RAC v1 — Stripe Webhook Handler
// Processes payment_intent.succeeded events and seals proofs

const crypto = require('crypto' );
const { getSupabase, ok, err, corsHeaders, sendRecipientNotification } = require('../../src/lib/index.js');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const ED25519_PRIVATE_KEY = process.env.ED25519_PRIVATE_KEY;

// ─── Utilities ─────────────────────────────────────────────────────────────

function computeChainHash(previousHash, signature) {
  return crypto.createHash('sha256').update(previousHash + signature).digest('hex');
}

function signWithEd25519(message) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(ED25519_PRIVATE_KEY, 'base64'),
    format: 'der',
    type: 'pkcs8'
  });
  return crypto.sign('sha256', Buffer.from(message), key).toString('hex');
}

// ─── Webhook Handler ──────────────────────────────────────────────────────

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS' ) {
    return { statusCode: 204, headers: corsHeaders };
  }

  if (event.httpMethod !== 'POST' ) {
    return err('Method not allowed', 405);
  }

  try {
    const sig = event.headers['stripe-signature'];
    const body = event.body;

    // Verify Stripe signature
    const stripeEvent = stripe.webhooks.constructEvent(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    console.log(`[webhook] Processing event: ${stripeEvent.type}`);

    if (stripeEvent.type !== 'payment_intent.succeeded') {
      return ok({ received: true });
    }

    const paymentIntent = stripeEvent.data.object;
    const metadata = paymentIntent.metadata || {};

    // Extract metadata
    const recipientEmail = metadata.recipient_email;
    const senderEmail = metadata.sender_email;
    const fileName = metadata.file_name || 'Verified Delivery';
    const fileSize = metadata.file_size;
    const fileHash = metadata.file_hash;
    const amount = paymentIntent.amount;

    if (!recipientEmail || !senderEmail) {
      return err('Missing recipient or sender email in metadata');
    }

    const supabase = getSupabase();

    // Generate proof ID
    const proofId = `proof_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sealedAt = new Date().toISOString();

    // Create message for signing
    const messageToSign = `${proofId}|${senderEmail}|${recipientEmail}|${sealedAt}`;
    const signature = signWithEd25519(messageToSign);

    // Get previous proof for chain linking
    const previousProofs = await supabase
      .from('proofs')
      .select('chain_hash')
      .order('sealed_at', { ascending: false })
      .limit('1');

    const previousChainHash = previousProofs.data && previousProofs.data.length > 0 ? previousProofs.data[0].chain_hash : null;
    const chainHash = computeChainHash(previousChainHash || '0', signature);

    // Create proof in Supabase
    const { data, error } = await supabase
      .from('proofs')
      .insert({
        id: proofId,
        proof_id: proofId,
        file_name: fileName,
        file_size: fileSize,
        file_hash: fileHash,
        sender_email: senderEmail,
        recipient_email: recipientEmail,
        status: 'sealed',
        is_valid: true,
        sealed_at: sealedAt,
        ed25519_signature: signature,
        chain_hash: chainHash,
        stripe_payment_id: paymentIntent.id,
        stripe_session_id: metadata.session_id,
        amount_cents: amount,
        user_email: senderEmail,
        timestamp: sealedAt,
        receipt_email_sent: false,
        rac_enabled: true,
        rac_version: '1.0'
      })
      .select();

    if (error) {
      console.error('[webhook] Supabase insert failed:', error.message);
      return err(`Proof creation failed: ${error.message}`);
    }

    console.log(`[webhook] Proof ${proofId} sealed with Ed25519 signature`);

    // Send sender receipt email
    await sendReceiptEmail(senderEmail, {
      proof_id: proofId,
      file_name: fileName,
      file_size: fileSize,
      sealed_at: sealedAt,
      ed25519_signature: signature
    }, false);

    // Send recipient notification email
    await sendRecipientNotification({
      recipientEmail,
      senderEmail,
      proofId,
      fileName,
      sealedAt
    });

    console.log(`[webhook] Emails sent to sender and recipient`);

    return ok({
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ received: true, proofId })
    });

  } catch (error) {
    console.error('[webhook] Error:', error.message);
    return err(`Webhook failed: ${error.message}`);
  }
};

// ─── Email Helper ─────────────────────────────────────────────────────────

async function sendReceiptEmail(email, proof, isRecipient = false) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.log('[email] Dev mode - skipping email');
    return;
  }

  const subject = isRecipient 
    ? `You have a verified delivery — ${proof.file_name}`
    : `Proof sealed — ${proof.proof_id}`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'SENT. <receipts@vxsent.com>',
      to: email,
      subject,
      html: `
        <div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8">
          <div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:32px;border-top:3px solid #00b356">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:0.15em;color:#111318;margin-bottom:20px">SENT.</div>
            <h2 style="font-size:20px;color:#111318;margin-bottom:12px">Proof Sealed</h2>
            <p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:8px">Your delivery has been cryptographically sealed with an Ed25519 signature.</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px;margin-top:16px">
              <tr style="border-bottom:1px solid #e1e4e8">
                <td style="padding:10px 0;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:#6b7280;width:100px">Proof ID</td>
                <td style="padding:10px 0;font-size:11px;color:#111318;font-family:monospace">${proof.proof_id}</td>
              </tr>
              <tr style="border-bottom:1px solid #e1e4e8">
                <td style="padding:10px 0;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:#6b7280">File</td>
                <td style="padding:10px 0;font-size:13px;color:#111318">${proof.file_name}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;font-size:10px;text-transform:uppercase;letter-spacing:0.12em;color:#6b7280">Sealed At</td>
                <td style="padding:10px 0;font-size:13px;color:#00b356;font-weight:bold">${new Date(proof.sealed_at ).toUTCString()}</td>
              </tr>
            </table>
            <p style="font-size:11px;color:#9ca3af;margin-top:20px;font-family:'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:0.1em">SENT. — Proof of Delivery Infrastructure · vxsent.com</p>
          </div>
        </div>
      `
    })
  });
}
