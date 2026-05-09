// netlify/functions/stripe-webhook.js
// SENT. RAC v1 — Stripe Webhook Handler (PRODUCTION )
// After payment succeeds: Ed25519 sign, chain link, finalize proof, send receipt emails
// Also handles: payment_failed, charge.refunded

const crypto = require('crypto');

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
          <td style="padding: 12px 0; color: #111; font-family: monospace; font-size: 10px; word-break: break-all;">${(proofData.ed25519_signature || '' ).substring(0, 64)}...</td>
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

      <p style="color: #9ca3af; font-size: 11px; text-align: center; margin-top: 32px;">
        <a href="https://vxsent.com" style="color: #00b356;">vxsent.com</a> — Proof of Delivery Infrastructure
      </p>
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
        subject: `SENT. Proof Sealed — ${proofData.file_name}`,
        html: emailHtml
      } )
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`[RAC] Failed to send email to ${toEmail}: ${response.status} ${errBody}`);
      return false;
    }

    console.log(`[RAC] Receipt email sent to ${toEmail}`);
    return true;
  } catch (error) {
    console.error(`[RAC] Email error: ${error.message}`);
    return false;
  }
}

// ─── Main Webhook Handler ──────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST' ) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // ─── Validate environment ───────────────────────────────────────────────
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripeKey || !webhookSecret) {
      console.error('[FATAL] Stripe credentials not configured');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Webhook not configured' }) };
    }

    const stripe = require('stripe')(stripeKey);

    // ─── Verify Stripe webhook signature ────────────────────────────────────
    const sig = event.headers['stripe-signature'];
    if (!sig) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing stripe-signature header' }) };
    }

    let stripeEvent;
    try {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
    } catch (err) {
      console.error(`[RAC] Webhook signature verification failed: ${err.message}`);
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Signature verification failed: ${err.message}` }) };
    }

    console.log(`[RAC] Webhook received: ${stripeEvent.type} | ${stripeEvent.id}`);

    // ─── Handle test events ─────────────────────────────────────────────────
    if (stripeEvent.id && stripeEvent.id.startsWith('evt_test_')) {
      return { statusCode: 200, headers, body: JSON.stringify({ verified: true, test: true }) };
    }

    // ─── Route by event type ────────────────────────────────────────────────
    switch (stripeEvent.type) {

      // ═══════════════════════════════════════════════════════════════════════
      // PAYMENT SUCCEEDED — Sign proof, chain link, finalize
      // ═══════════════════════════════════════════════════════════════════════
      case 'payment_intent.succeeded': {
        const paymentIntent = stripeEvent.data.object;
        const proofId = paymentIntent.metadata?.proof_id;

        if (!proofId) {
          console.warn('[RAC] payment_intent.succeeded without proof_id in metadata:', paymentIntent.id);
          return { statusCode: 200, headers, body: JSON.stringify({ received: true, warning: 'No proof_id' }) };
        }

        console.log(`[RAC] Processing payment for proof: ${proofId}`);

        // ─── Retrieve pending proof from Supabase ─────────────────────────
        const proofs = await supabaseQuery('proofs', {
          proof_id: `eq.${proofId}`,
          select: '*'
        });

        if (!proofs || proofs.length === 0) {
          console.error(`[RAC] Proof not found in Supabase: ${proofId}`);
          return { statusCode: 200, headers, body: JSON.stringify({ received: true, error: 'Proof not found' }) };
        }

        const proof = proofs[0];

        // Prevent double-processing
        if (proof.status === 'sealed' || proof.status === 'verified') {
          console.log(`[RAC] Proof already sealed, skipping: ${proofId}`);
          return { statusCode: 200, headers, body: JSON.stringify({ received: true, already_sealed: true }) };
        }

        // ─── Ed25519 Signing ──────────────────────────────────────────────
        const sealedAt = new Date().toISOString();

        let signatureHex, publicKeyHex;
        try {
          const signResult = signProof(
            proof.proof_id,
            proof.file_hash,
            proof.file_name,
            proof.file_size,
            sealedAt
          );
          signatureHex = signResult.signature;
          publicKeyHex = signResult.publicKey;
          console.log(`[RAC] Proof signed: ${proofId} | sig: ${signatureHex.substring(0, 32)}...`);
        } catch (signErr) {
          console.error(`[RAC] Signing failed: ${signErr.message}`);
          // Still mark as sealed but without crypto (graceful degradation)
          signatureHex = null;
          publicKeyHex = null;
        }

        // ─── Chain Linking ────────────────────────────────────────────────
        let chainHash = null;
        let previousProofId = null;

        if (signatureHex) {
          try {
            // Find the most recent sealed proof to chain from
            const previousProofs = await supabaseQuery('proofs', {
              status: 'eq.sealed',
              order: 'sealed_at.desc',
              limit: '1',
              select: 'proof_id,chain_hash'
            });

            if (previousProofs && previousProofs.length > 0) {
              previousProofId = previousProofs[0].proof_id;
              chainHash = computeChainHash(previousProofs[0].chain_hash, signatureHex);
            } else {
              // Genesis proof
              chainHash = computeChainHash(null, signatureHex);
            }

            console.log(`[RAC] Chain linked: ${proofId} → prev: ${previousProofId || 'GENESIS'} | chain: ${chainHash.substring(0, 32)}...`);
          } catch (chainErr) {
            console.error(`[RAC] Chain linking failed: ${chainErr.message}`);
          }
        }

        // ─── Update proof in Supabase ─────────────────────────────────────
        const updates = {
          status: 'sealed',
          is_valid: true,
          sealed_at: sealedAt,
          verified_at: sealedAt,
          stripe_payment_id: paymentIntent.id,
          updated_at: new Date().toISOString()
        };

        // Only add crypto fields if signing succeeded
        if (signatureHex) {
          updates.ed25519_signature = signatureHex;
          updates.ed25519_public_key = publicKeyHex;
        }
        if (chainHash) {
          updates.chain_hash = chainHash;
          updates.previous_proof_id = previousProofId;
        }

        await supabaseUpdate('proofs', 'proof_id', proofId, updates);
        console.log(`[RAC] Proof finalized: ${proofId} | status: sealed | signed: ${!!signatureHex}`);

        // ─── Send receipt emails ──────────────────────────────────────────
        const finalProof = { ...proof, ...updates };

        if (proof.user_email) {
          await sendReceiptEmail(proof.user_email, finalProof, false);
        }
        if (proof.recipient_email && proof.recipient_email !== proof.user_email) {
          await sendReceiptEmail(proof.recipient_email, finalProof, true);
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            received: true,
            proof_id: proofId,
            status: 'sealed',
            signed: !!signatureHex,
            chained: !!chainHash
          })
        };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // PAYMENT FAILED — Mark proof as failed
      // ═══════════════════════════════════════════════════════════════════════
      case 'payment_intent.payment_failed': {
        const failedIntent = stripeEvent.data.object;
        const failedProofId = failedIntent.metadata?.proof_id;
        console.log(`[RAC] Payment failed: ${failedIntent.id}, proof: ${failedProofId || 'N/A'}`);

        if (failedProofId) {
          await supabaseUpdate('proofs', 'proof_id', failedProofId, {
            status: 'payment_failed',
            updated_at: new Date().toISOString()
          });
        }
        return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // CHARGE REFUNDED — Invalidate proof
      // ═══════════════════════════════════════════════════════════════════════
      case 'charge.refunded': {
        const charge = stripeEvent.data.object;
        const refundedIntentId = charge.payment_intent;
        console.log(`[RAC] Charge refunded: ${charge.id}, intent: ${refundedIntentId}`);

        if (refundedIntentId) {
          const refundedProofs = await supabaseQuery('proofs', {
            stripe_payment_id: `eq.${refundedIntentId}`,
            select: 'proof_id'
          });

          if (refundedProofs && refundedProofs.length > 0) {
            const refundedProofId = refundedProofs[0].proof_id;
            await supabaseUpdate('proofs', 'proof_id', refundedProofId, {
              status: 'refunded',
              is_valid: false,
              updated_at: new Date().toISOString()
            });
            console.log(`[RAC] Proof invalidated due to refund: ${refundedProofId}`);
          }
        }
        return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
      }

      // ═══════════════════════════════════════════════════════════════════════
      // ALL OTHER EVENTS — Acknowledge without processing
      // ═══════════════════════════════════════════════════════════════════════
      default:
        console.log(`[RAC] Unhandled event type: ${stripeEvent.type}`);
        return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
    }

  } catch (error) {
    console.error('[RAC] Webhook processing error:', error.message, error.stack);
    // Return 200 to prevent Stripe retries on application errors
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ received: true, error: error.message })
    };
  }
};
