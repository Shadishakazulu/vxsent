const crypto = require('crypto');

// ─── HELPERS ────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function buildRacToken({ senderEmail, recipientEmail, fileName, fileHash, paymentIntentId, timestamp, proofId }) {
  const identityHash = sha256(senderEmail + proofId);
  const scopeHash = sha256(`${recipientEmail}:${fileName}:${fileHash}`);
  const chainHash = sha256(`${identityHash}:${scopeHash}:${paymentIntentId}:${timestamp}`);

  return {
    rac_level: 3,
    layer1_who: { principal: senderEmail, identity_hash: identityHash },
    layer2_which: { recipient: recipientEmail, action_scope: `file_delivery → ${recipientEmail}`, deliverable: fileName, scope_hash: scopeHash },
    layer3_what: { confirmation_method: 'stripe_payment_verified', payment_reference: paymentIntentId, file_hash: fileHash, chain_hash: chainHash },
    layer4_when: { timestamp, proof_id: proofId, recipient_confirmation_pending: true }
  };
}

async function sendEmail({ resend, from, to, subject, html }) {
  try {
    await resend.emails.send({ from, to, subject, html });
    console.log('[webhook] Email sent to:', to);
  } catch (err) {
    console.error('[webhook] Email send failed to:', to, err.message);
  }
}

// ─── SEAL PROOF ─────────────────────────────────────────────────────────────

async function sealProof({ supabase, resend, metadata, paymentIntentId }) {
  const {
    proof_id: proofId,
    file_hash: fileHash,
    file_name: fileName,
    file_size: fileSize,
    user_email: userEmail,
    sender_email: senderEmail,
    recipient_email: recipientEmail,
    project_name: projectName,
    timestamp
  } = metadata;

  const senderAddr = senderEmail || userEmail;
  const sealedAt = timestamp || new Date().toISOString();

  if (!proofId || !fileHash || !senderAddr) {
    console.error('[webhook] Missing required metadata:', { proofId, fileHash, senderAddr });
    return;
  }

  // RAC Level 3: recipient email is required
  if (!recipientEmail) {
    console.error('[webhook] Missing recipient_email for RAC Level 3 proof:', proofId);
    return;
  }

  // Idempotency check
  const { data: existing } = await supabase
    .from('proofs')
    .select('proof_id, is_valid')
    .eq('proof_id', proofId)
    .single();

  if (existing && existing.is_valid) {
    console.log('[webhook] Proof already sealed, skipping:', proofId);
    return;
  }

  // Build RAC Level 3 token
  const racToken = buildRacToken({
    senderEmail: senderAddr,
    recipientEmail,
    fileName,
    fileHash,
    paymentIntentId,
    timestamp: sealedAt,
    proofId
  });

  // Seal proof in database
  const proofData = {
    proof_id: proofId,
    file_name: fileName,
    file_size: fileSize || null,
    file_hash: fileHash,
    sealed_at: sealedAt,
    stripe_payment_id: paymentIntentId,
    user_email: senderAddr,
    sender_email: senderAddr,
    recipient_email: recipientEmail,
    project_name: projectName || null,
    rac_chain_hash: sha256(`${proofId}:${fileHash}:${sealedAt}`),
    rac_level: 3,
    rac_enabled: true,
    is_valid: true,
    status: 'sealed',
    updated_at: new Date().toISOString()
  };

  const { error: upsertError } = await supabase
    .from('proofs')
    .upsert(proofData, { onConflict: 'proof_id' });

  if (upsertError) {
    console.error('[webhook] Proof upsert error:', upsertError.message);
    throw new Error(`DB upsert failed: ${upsertError.message}`);
  }

  console.log('[webhook] Proof sealed in DB (RAC Level 3):', proofId);

  // Update payment record
  await supabase
    .from('payments')
    .update({ status: 'succeeded' })
    .eq('stripe_payment_id', paymentIntentId);

  const verifyUrl = `https://vxsent.com/receipt?id=${proofId}`;
  const confirmUrl = `https://vxsent.com/verify/${proofId}?confirm=true`;

  // EMAIL 1: Receipt to sender
  if (resend && senderAddr) {
    const senderHtml = `<!DOCTYPE html><html><body style="font-family:monospace;background:#0a1628;color:#00ff88;padding:32px;max-width:600px">
<h2 style="letter-spacing:3px">✓ PROOF SEALED — RAC LEVEL 3</h2>
<p style="color:#8899aa;font-size:12px">PROOF ID: <span style="color:#00ff88">${proofId}</span></p>
<p style="color:#8899aa;font-size:12px">FILE: <span style="color:#e0e0e0">${fileName}</span></p>
<p style="color:#8899aa;font-size:12px">SIZE: <span style="color:#e0e0e0">${fileSize || 'N/A'}</span></p>
<p style="color:#8899aa;font-size:12px">SEALED: <span style="color:#e0e0e0">${sealedAt}</span></p>
<p style="color:#8899aa;font-size:12px">TO: <span style="color:#e0e0e0">${recipientEmail}</span></p>
<p style="color:#8899aa;font-size:12px">RAC LEVEL: <span style="color:#00ff88;font-weight:bold">3 — FULL CHAIN</span></p>
<hr style="border-color:#1e3a5f;margin:24px 0">
<p style="color:#8899aa;font-size:12px;margin:0 0 16px">RAC CHAIN — FOUR LAYERS:</p>
<p style="color:#e0e0e0;font-size:12px;margin:0">L1 WHO: ${senderAddr}</p>
<p style="color:#e0e0e0;font-size:12px;margin:4px 0 0">L2 WHICH: ${fileName} → ${recipientEmail}</p>
<p style="color:#e0e0e0;font-size:12px;margin:4px 0 0">L3 WHAT: Stripe payment verified</p>
<p style="color:#e0e0e0;font-size:12px;margin:4px 0 0">L4 WHEN: Awaiting recipient confirmation</p>
<hr style="border-color:#1e3a5f;margin:24px 0">
<a href="${verifyUrl}" style="display:block;background:#00ff88;color:#0a1628;text-align:center;padding:14px;text-decoration:none;font-weight:bold;letter-spacing:2px;font-size:13px">VIEW RECEIPT →</a>
</body></html>`;
    await sendEmail({
      resend,
      from: 'receipts@vxsent.com',
      to: senderAddr,
      subject: `Your SENT. receipt — ${fileName}`,
      html: senderHtml
    });
  }

  // EMAIL 2: Recipient notification (RAC Level 3 — always sent)
  if (resend && recipientEmail) {
    const recipientHtml = `<!DOCTYPE html><html><body style="font-family:monospace;background:#0a1628;color:#00ff88;padding:32px;max-width:600px">
<h2 style="letter-spacing:3px">📦 FILE DELIVERY PROOF — RAC LEVEL 3</h2>
<p style="color:#8899aa;font-size:12px">FROM: <span style="color:#e0e0e0">${senderAddr}</span></p>
<p style="color:#8899aa;font-size:12px">FILE: <span style="color:#e0e0e0">${fileName}</span></p>
<p style="color:#8899aa;font-size:12px">PROOF ID: <span style="color:#00ff88">${proofId}</span></p>
<p style="color:#8899aa;font-size:12px">SEALED: <span style="color:#e0e0e0">${sealedAt}</span></p>
<p style="color:#8899aa;font-size:12px">RAC LEVEL: <span style="color:#00ff88;font-weight:bold">3 — FULL CHAIN</span></p>
<hr style="border-color:#1e3a5f;margin:24px 0">
<p style="color:#8899aa;font-size:12px;margin:0 0 16px">This delivery has been cryptographically sealed on the RAC chain. Click below to confirm receipt and complete Layer 4 (WHEN).</p>
<a href="${confirmUrl}" style="display:block;background:#00ff88;color:#0a1628;text-align:center;padding:14px;text-decoration:none;font-weight:bold;letter-spacing:2px;font-size:13px;margin:16px 0">CONFIRM RECEIPT — SEAL LAYER 4 →</a>
<p style="color:#8899aa;font-size:11px;margin:16px 0 0;text-align:center">Confirming receipt completes the four-layer RAC proof.</p>
</body></html>`;
    await sendEmail({
      resend,
      from: 'receipts@vxsent.com',
      to: recipientEmail,
      subject: `You have a verified delivery — ${fileName}`,
      html: recipientHtml
    });
  }

  console.log('[webhook] Emails sent for proof:', proofId);
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: '' };
  }

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const resendKey = process.env.RESEND_API_KEY;

    if (!stripeKey) throw new Error('STRIPE_SECRET_KEY not configured');
    if (!supabaseUrl || !supabaseKey) throw new Error('Supabase not configured');

    const stripe = require('stripe')(stripeKey);
    const { createClient } = require('@supabase/supabase-js');
    const { Resend } = require('resend');

    const supabase = createClient(supabaseUrl, supabaseKey);
    const resend = resendKey ? new Resend(resendKey) : null;

    // Verify Stripe webhook signature
    let stripeEvent;
    try {
      if (webhookSecret) {
        stripeEvent = stripe.webhooks.constructEvent(
          event.body,
          event.headers['stripe-signature'],
          webhookSecret
        );
      } else {
        stripeEvent = JSON.parse(event.body);
        console.warn('[webhook] No STRIPE_WEBHOOK_SECRET — skipping signature verification');
      }
    } catch (err) {
      console.error('[webhook] Signature verification failed:', err.message);
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    console.log('[webhook] Event:', stripeEvent.type, stripeEvent.id);

    switch (stripeEvent.type) {

      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const paymentIntentId = session.payment_intent;
        const meta = session.metadata || {};

        console.log('[webhook] checkout.session.completed:', session.id, 'proofId:', meta.proof_id);

        if (!meta.proof_id) {
          console.warn('[webhook] No proof_id in checkout session metadata — skipping');
          break;
        }

        await sealProof({
          supabase, resend,
          metadata: {
            ...meta,
            sender_email: meta.sender_email || meta.user_email || session.customer_email,
            user_email: meta.user_email || meta.sender_email || session.customer_email
          },
          paymentIntentId
        });
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = stripeEvent.data.object;
        const meta = pi.metadata || {};

        console.log('[webhook] payment_intent.succeeded:', pi.id, 'proofId:', meta.proof_id);

        if (!meta.proof_id) {
          console.warn('[webhook] No proof_id in PaymentIntent metadata — skipping');
          break;
        }

        await sealProof({
          supabase, resend,
          metadata: meta,
          paymentIntentId: pi.id
        });
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = stripeEvent.data.object;
        const proofId = pi.metadata?.proof_id;

        if (proofId) {
          await supabase.from('proofs').delete().eq('proof_id', proofId).eq('is_valid', false);
          await supabase.from('payments').update({ status: 'failed' }).eq('stripe_payment_id', pi.id);
          console.log('[webhook] Payment failed, pending proof deleted:', proofId);
        }
        break;
      }

      default:
        console.log('[webhook] Unhandled event type:', stripeEvent.type);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('[webhook] Handler error:', err.message, err.stack);
    return { statusCode: 200, body: JSON.stringify({ received: true, error: err.message }) };
  }
};
