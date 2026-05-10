// netlify/functions/stripe-webhook.js
// SENT. RAC v1 — Stripe Webhook Handler (PRODUCTION)
// After payment succeeds: Ed25519 sign, chain link, finalize proof, send receipt emails
// Also handles: payment_failed, charge.refunded

const crypto = require('crypto');
const { sendRecipientNotification } = require('../../src/lib/index.js');

// ─── Ed25519 Signing ───────────────────────────────────────────────────────────

function signProof(proofId, fileHash, fileName, fileSize, sealedAt) {
  const privateKeyHex = process.env.ED25519_PRIVATE_KEY;
  if (!privateKeyHex || privateKeyHex.length !== 64) {
    throw new Error('ED25519_PRIVATE_KEY not configured or invalid (must be 64 hex chars = 32 bytes)');
  }

  // Convert hex seed to Buffer
  const seed = Buffer.from(privateKeyHex, 'hex');

  // Create Ed25519 private key from seed using PKCS8 DER encoding (RFC 8410)
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'), // PKCS8 DER prefix for Ed25519
      seed
    ]),
    format: 'der',
    type: 'pkcs8'
  });

  // Derive public key from private key
  const publicKey = crypto.createPublicKey(privateKey);

  // Construct canonical payload — this is what gets signed
  // Format: SENT.PROOF.V1|{proof_id}|{file_hash}|{file_name}|{file_size}|{sealed_at_iso}
  const canonicalPayload = `SENT.PROOF.V1|${proofId}|${fileHash}|${fileName}|${fileSize}|${sealedAt}`;

  // Sign with Ed25519 (null algorithm = use key's built-in algorithm)
  const signature = crypto.sign(null, Buffer.from(canonicalPayload, 'utf8'), privateKey);

  // Export public key as raw 32 bytes (hex)
  const pubKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  // Ed25519 SPKI DER: 12 bytes prefix + 32 bytes key
  const pubKeyRaw = pubKeyDer.slice(-32);

  return {
    signature: signature.toString('hex'),
    publicKey: pubKeyRaw.toString('hex'),
    canonicalPayload
  };
}

// ─── Chain Hash Computation ────────────────────────────────────────────────────

function computeChainHash(previousChainHash, currentSignature) {
  if (!previousChainHash) {
    // Genesis proof — no previous chain exists
    const genesisInput = `GENESIS|${currentSignature}`;
    return crypto.createHash('sha256').update(genesisInput).digest('hex');
  }

  // Chain: SHA-256(previous_chain_hash + current_signature)
  const chainInput = `${previousChainHash}${currentSignature}`;
  return crypto.createHash('sha256').update(chainInput).digest('hex');
}

// ─── Supabase Helpers ──────────────────────────────────────────────────────────

async function supabaseQuery(table, params) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials not configured');
  }

  const queryString = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const response = await fetch(`${url}/rest/v1/${table}?${queryString}`, {
    method: 'GET',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase query failed: ${response.status} ${errText}`);
  }

  return response.json();
}

async function supabaseUpdate(table, matchColumn, matchValue, updates) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Supabase credentials not configured');
  }

  const response = await fetch(`${url}/rest/v1/${table}?${matchColumn}=eq.${encodeURIComponent(matchValue)}`, {
    method: 'PATCH',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(updates)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase update failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  return data[0] || data;
}

// ─── Email via Resend ──────────────────────────────────────────────────────────

async function sendReceiptEmail(toEmail, proofData, isRecipient = false) {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey || !toEmail) return false;

  const proofUrl = `https://vxsent.com/receipt?id=${proofData.proof_id}`;
  const roleLine = isRecipient
    ? 'A verified delivery proof has been created for a file sent to you.'
    : 'Your cryptographic proof of delivery has been sealed and verified.';

  const emailHtml = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
      <div style="text-align: center; margin-bottom: 32px;">
        <span style="font-family: 'Bebas Neue', Impact, sans-serif; font-size: 28px; letter-spacing: 2px; color: #111;">● SENT.</span>
      </div>
      
      <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; text-align: center; margin-bottom: 24px;">
        <span style="color: #16a34a; font-weight: 700;">✓ DELIVERY VERIFIED</span>
      </div>
      <p style="color: #374151; line-height: 1.6;">${roleLine}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
        <tr style="border-bottom: 1px solid #e5e7eb;">
          <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Proof ID</td>
          <td style="padding: 12px 0; color: #111; font-weight: 600; font-family: monospace;">${proofData.proof_id}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e5e7eb;">
          <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">File</td>
          <td style="padding: 12px 0; color: #111;">${proofData.file_name}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e5e7eb;">
          <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Size</td>
          <td style="padding: 12px 0; color: #111;">${proofData.file_size}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e5e7eb;">
          <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Sealed At</td>
          <td style="padding: 12px 0; color: #16a34a; font-family: monospace;">${proofData.sealed_at}</td>
        </tr>
        <tr style="border-bottom: 1px solid #e5e7eb;">
          <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">SHA-256</td>
          <td style="padding: 12px 0; color: #111; font-family: monospace; font-size: 11px; word-break: break-all;">${proofData.file_hash}</td>
        </tr>
        <tr>
          <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Signature</td>
          <td style="padding: 12px 0; color: #111; font-family: monospace; font-size: 10px; word-break: break-all;">${(proofData.ed25519_signature || '').substring(0, 64)}...</td>
        </tr>
      </table>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${proofUrl}" style="display: inline-block; background: #00b356; color: #fff; padding: 14px 32px; border-radius: 4px; text-decoration: none; font-weight: 700; letter-spacing: 0.5px;">VIEW FULL PROOF</a>
      </div>
      <div style="background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 4px; padding: 12px; margin-top: 24px;">
        <p style="color: #6b7280; font-size: 11px; margin: 0; text-align: center;">
          This proof is cryptographically sealed with Ed25519 and linked to the SENT. Receipt Authentication Chain (RAC v1).
          It cannot be altered, revoked, or disputed. Independently verifiable at any time.
        </p>
      </div>
    </div>
  `;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'SENT. <noreply@vxsent.com>',
        to: toEmail,
        subject: isRecipient ? '✓ Delivery Proof Received' : '✓ Proof of Delivery Sealed',
        html: emailHtml
      })
    });

    if (!response.ok) {
      console.error('[sendReceiptEmail] Resend error:', response.status);
      return false;
    }

    console.log(`[sendReceiptEmail] Email sent to ${toEmail}`);
    return true;
  } catch (error) {
    console.error('[sendReceiptEmail] Error:', error.message);
    return false;
  }
}

// ─── Main Webhook Handler ──────────────────────────────────────────────────────

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const sig = event.headers['stripe-signature'];
    const body = event.body;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    }

    // Handle test events (for webhook verification)
    let event_obj;
    try {
      event_obj = JSON.parse(body);
      if (event_obj.id && event_obj.id.startsWith('evt_test_')) {
        console.log('[webhook] Test event detected, returning verification response');
        return { statusCode: 200, headers, body: JSON.stringify({ verified: true }) };
      }
    } catch (e) {
      // Continue with signature verification
    }

    // Verify Stripe signature
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    try {
      event_obj = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } catch (err) {
      console.error('[webhook] Signature verification failed:', err.message);
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    const eventType = event_obj.type;
    const eventData = event_obj.data.object;

    console.log(`[webhook] Processing event: ${eventType}`);

    // ─── payment_intent.succeeded ───────────────────────────────────────────────

    if (eventType === 'payment_intent.succeeded') {
      const paymentIntentId = eventData.id;
      const clientRefId = eventData.client_reference_id;
      const metadata = eventData.metadata || {};

      const proofId = metadata.proof_id;
      const senderEmail = metadata.sender_email;
      const recipientEmail = metadata.recipient_email;
      const fileName = metadata.file_name;
      const fileSize = metadata.file_size;
      const fileHash = metadata.file_hash;

      if (!proofId) {
        console.error('[webhook] No proof_id in metadata');
        return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: 'No proof_id' }) };
      }

      try {
        // Fetch the proof from Supabase
        const proofs = await supabaseQuery('proofs', { proof_id: `eq.${proofId}`, select: '*' });
        if (!proofs || proofs.length === 0) {
          console.error(`[webhook] Proof ${proofId} not found`);
          return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: 'Proof not found' }) };
        }

        const proof = proofs[0];
        const sealedAt = new Date().toISOString();

        // Sign the proof with Ed25519
        const { signature, publicKey, canonicalPayload } = signProof(
          proofId,
          proof.file_hash,
          proof.file_name,
          proof.file_size,
          sealedAt
        );

        // Get the previous proof to chain-link
        const previousProofs = await supabaseQuery('proofs', {
          status: `eq.sealed`,
          proof_id: `neq.${proofId}`,
          select: 'chain_hash',
          order: 'sealed_at.desc',
          limit: '1'
        });

        const previousChainHash = previousProofs && previousProofs.length > 0 ? previousProofs[0].chain_hash : null;
        const chainHash = computeChainHash(previousChainHash, signature);

        // Update proof in Supabase with all crypto fields
        await supabaseUpdate('proofs', 'proof_id', proofId, {
          status: 'sealed',
          is_valid: true,
          sealed_at: sealedAt,
          ed25519_signature: signature,
          ed25519_public_key: publicKey,
          chain_hash: chainHash,
          canonical_payload: canonicalPayload,
          stripe_payment_intent_id: paymentIntentId
        });

        console.log(`[webhook] Proof ${proofId} sealed with Ed25519 signature`);

        // Send receipt email to sender
        await sendReceiptEmail(senderEmail, {
          proof_id: proofId,
          file_name: fileName,
          file_size: fileSize,
          file_hash: fileHash,
          sealed_at: sealedAt,
          ed25519_signature: signature
        }, false);

        // Send confirmation request email to recipient (RAC Level 3)
        await sendRecipientNotification(recipientEmail, proofId, `https://vxsent.com/receipt?id=${proofId}` );


        return { statusCode: 200, headers, body: JSON.stringify({ received: true, proofId }) };

      } catch (error) {
        console.error('[webhook] Error processing payment:', error.message);
        return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: error.message }) };
      }
    }

    // ─── payment_intent.payment_failed ─────────────────────────────────────────

    if (eventType === 'payment_intent.payment_failed') {
      const metadata = eventData.metadata || {};
      const proofId = metadata.proof_id;

      if (proofId) {
        try {
          await supabaseUpdate('proofs', 'proof_id', proofId, { status: 'payment_failed' });
          console.log(`[webhook] Proof ${proofId} marked as payment_failed`);
        } catch (error) {
          console.error('[webhook] Error updating payment_failed:', error.message);
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
    }

    // ─── charge.refunded ───────────────────────────────────────────────────────

    if (eventType === 'charge.refunded') {
      const chargeId = eventData.id;
      console.log(`[webhook] Refund detected for charge ${chargeId}`);

      try {
        // Find proof by stripe_charge_id and mark as refunded
        const proofs = await supabaseQuery('proofs', { stripe_charge_id: `eq.${chargeId}`, select: 'proof_id' });
        if (proofs && proofs.length > 0) {
          const proofId = proofs[0].proof_id;
          await supabaseUpdate('proofs', 'proof_id', proofId, { status: 'refunded' });
          console.log(`[webhook] Proof ${proofId} marked as refunded`);
        }
      } catch (error) {
        console.error('[webhook] Error processing refund:', error.message);
      }

      return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
    }

    // Unhandled event type
    console.log(`[webhook] Unhandled event type: ${eventType}`);
    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };

  } catch (error) {
    console.error('[webhook] Unexpected error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
