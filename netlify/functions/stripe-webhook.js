// netlify/functions/stripe-webhook.js
// SENT. Master Reference v1.0 — Sections 2, 6, 9, 13
// Handles: checkout.session.completed, payment_intent.succeeded,
//          payment_intent.payment_failed, invoice.payment_succeeded,
//          invoice.payment_failed, customer.subscription.deleted,
//          customer.subscription.updated

const crypto = require('crypto');

// ─── HELPERS ────────────────────────────────────────────────────────────────

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function buildRacToken({ senderEmail, recipientEmail, fileName, fileHash, paymentIntentId, timestamp, proofId }) {
  const identityHash = sha256(senderEmail + proofId);
  const recipient = recipientEmail || 'unspecified';
  const scopeHash = sha256(`${recipient}:${fileName}:${fileHash}`);
  const chainHash = sha256(`${identityHash}:${scopeHash}:${paymentIntentId}:${timestamp}`);

  return {
    layer1_who: {
      principal: senderEmail,
      identity_hash: identityHash,
      authority_level: 'freelancer_delivery',
      role: 'content_deliverer'
    },
    layer2_which: {
      recipient,
      action_scope: `file_delivery → ${recipient}`,
      deliverable: fileName,
      project: 'freelance_delivery',
      scope_hash: scopeHash,
      scope_lock_ref: null
    },
    layer3_what: {
      confirmation_method: 'stripe_payment_verified',
      payment_reference: paymentIntentId,
      file_hash: fileHash,
      timestamp,
      chain_hash: chainHash
    }
  };
}

async function callVeridex({ proofId, fileHash, fileName, timestamp, paymentIntentId, racToken }) {
  const veridexUrl = process.env.VERIDEX_API_URL;
  const veridexKey = process.env.VERIDEX_API_KEY;

  if (!veridexUrl || !veridexKey) {
    console.warn('[webhook] Veridex not configured — using fallback signature');
    const fallbackSig = sha256(`${proofId}:${fileHash}:${timestamp}`);
    const fallbackChain = sha256(`${fallbackSig}:${paymentIntentId}`);
    return {
      proof_id: proofId,
      signature: fallbackSig,
      sealed_at: timestamp,
      algorithm: 'SHA-256-fallback',
      rac_sealed: true,
      rac_chain_hash: fallbackChain
    };
  }

  const response = await fetch(`${veridexUrl}/v1/guardedCommit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${veridexKey}`,
      'X-Idempotency-Key': proofId,
      'X-RAC-Version': '1.0'
    },
    body: JSON.stringify({
      action: 'seal_delivery_proof',
      proof_id: proofId,
      file_hash: fileHash,
      file_name: fileName,
      timestamp,
      payment_reference: paymentIntentId,
      rac_token: racToken
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Veridex error ${response.status}: ${errText}`);
  }

  return response.json();
}

async function sendEmail({ resend, from, to, subject, html }) {
  if (!resend) return;
  try {
    await resend.emails.send({ from, to, subject, html });
    console.log(`[webhook] Email sent to ${to}: ${subject}`);
  } catch (err) {
    console.error(`[webhook] Email failed to ${to}:`, err.message);
  }
}

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
    delivery_message: deliveryMessage,
    timestamp
  } = metadata;

  const senderAddr = senderEmail || userEmail;
  const sealedAt = timestamp || new Date().toISOString();

  if (!proofId || !fileHash || !senderAddr) {
    console.error('[webhook] Missing required metadata:', { proofId, fileHash, senderAddr });
    return;
  }

  // Idempotency check — also pull the note saved during create-payment-intent so
  // the full (untruncated) message survives sealing, since Stripe metadata caps
  // values at 500 chars.
  const { data: existing } = await supabase
    .from('proofs')
    .select('id, is_valid, delivery_message')
    .eq('id', proofId)
    .single();

  if (existing && existing.is_valid) {
    console.log('[webhook] Proof already sealed, skipping:', proofId);
    return;
  }

  // Prefer the full note persisted on the pending row; fall back to the truncated
  // copy carried in Stripe metadata. Collapse blank to null.
  const effectiveMessage = (existing && existing.delivery_message)
    || (typeof deliveryMessage === 'string' && deliveryMessage.trim() ? deliveryMessage.trim() : null)
    || null;

  // Build RAC token
  const racToken = buildRacToken({
    senderEmail: senderAddr,
    recipientEmail,
    fileName,
    fileHash,
    paymentIntentId,
    timestamp: sealedAt,
    proofId
  });

  // Call Veridex
  let veridexResult;
  try {
    veridexResult = await callVeridex({
      proofId, fileHash, fileName,
      timestamp: sealedAt, paymentIntentId,
      racToken
    });
    console.log('[webhook] Veridex sealed:', proofId);
  } catch (err) {
    console.error('[webhook] Veridex failed:', err.message);
    // Use fallback
    const fallbackSig = sha256(`${proofId}:${fileHash}:${sealedAt}`);
    veridexResult = {
      proof_id: proofId,
      signature: fallbackSig,
      sealed_at: sealedAt,
      rac_sealed: true,
      rac_chain_hash: sha256(`${fallbackSig}:${paymentIntentId}`)
    };
  }

  // Upsert proof record (handles both pending-exists and new-insert cases)
  const proofData = {
    id: proofId,
    file_name: fileName,
    file_size: fileSize || null,
    file_hash: fileHash,
    sealed_at: sealedAt,
    stripe_payment_id: paymentIntentId,
    user_email: senderAddr,
    recipient_email: recipientEmail || null,
    project_name: projectName || null,
    delivery_message: effectiveMessage,
    veridex_proof_id: veridexResult.proof_id || proofId,
    veridex_signature: veridexResult.signature,
    rac_chain_hash: veridexResult.rac_chain_hash,
    rac_enabled: true,
    is_valid: true,
    status: 'sealed',
    updated_at: new Date().toISOString()
  };

  const { error: upsertError } = await supabase
    .from('proofs')
    .upsert(proofData, { onConflict: 'id' });

  if (upsertError) {
    console.error('[webhook] Proof upsert error:', upsertError.message);
    throw new Error(`DB upsert failed: ${upsertError.message}`);
  }

  console.log('[webhook] Proof sealed in DB:', proofId);

  // Update payment record
  await supabase
    .from('payments')
    .update({ status: 'succeeded' })
    .eq('stripe_payment_id', paymentIntentId);

  // Count proofs for this sender
  const { count: proofCount } = await supabase
    .from('proofs')
    .select('id', { count: 'exact', head: true })
    .eq('user_email', senderAddr)
    .eq('is_valid', true);

  const verifyUrl = `https://vxsent.com/receipt?id=${proofId}`;
  const confirmUrl = `https://vxsent.com/verify/${proofId}?confirm=true`;

  // EMAIL 1: Receipt to sender
  if (resend && senderAddr) {
    await sendEmail({
      resend,
      from: 'receipts@vxsent.com',
      to: senderAddr,
      subject: `Your SENT. receipt — ${fileName}`,
      html: `
        <div style="font-family:monospace;background:#0a1628;color:#00ff88;padding:32px;max-width:600px">
          <h1 style="font-size:24px;letter-spacing:4px;margin:0 0 8px">SENT.</h1>
          <p style="color:#8899aa;margin:0 0 24px;letter-spacing:2px">PROOF OF DELIVERY RECEIPT</p>
          <hr style="border-color:#1e3a5f;margin:0 0 24px">
          ${effectiveMessage ? `<div style="margin:0 0 24px;padding:16px;background:#0d2137;border-left:3px solid #00ff88"><p style="color:#8899aa;font-size:11px;letter-spacing:1px;margin:0 0 8px">SEALED MESSAGE</p><p style="color:#e0e0e0;font-size:13px;line-height:1.6;margin:0;white-space:pre-wrap">${escapeHtml(effectiveMessage)}</p></div>` : ''}
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">PROOF ID</td><td style="color:#00ff88;font-size:12px">${proofId}</td></tr>
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">FILE</td><td style="color:#e0e0e0;font-size:12px">${fileName}</td></tr>
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">SIZE</td><td style="color:#e0e0e0;font-size:12px">${fileSize || 'N/A'}</td></tr>
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">SEALED</td><td style="color:#e0e0e0;font-size:12px">${sealedAt}</td></tr>
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">HASH</td><td style="color:#e0e0e0;font-size:11px;word-break:break-all">${fileHash}</td></tr>
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">RAC CHAIN</td><td style="color:#e0e0e0;font-size:11px;word-break:break-all">${veridexResult.rac_chain_hash}</td></tr>
          </table>
          <div style="margin:24px 0;padding:16px;background:#0d2137;border:1px solid #1e3a5f">
            <p style="color:#8899aa;font-size:11px;letter-spacing:1px;margin:0 0 8px">RAC CHAIN — LAYER 1 (WHO)</p>
            <p style="color:#e0e0e0;font-size:12px;margin:0">Principal: ${senderAddr}</p>
            ${recipientEmail ? `<p style="color:#e0e0e0;font-size:12px;margin:4px 0 0">Recipient: ${recipientEmail}</p>` : ''}
          </div>
          <a href="${verifyUrl}" style="display:block;background:#00ff88;color:#0a1628;text-align:center;padding:14px;text-decoration:none;font-weight:bold;letter-spacing:2px;font-size:13px;margin-top:24px">VIEW RECEIPT →</a>
          <p style="color:#8899aa;font-size:11px;margin:16px 0 0;text-align:center">This proof is permanently sealed and independently verifiable.</p>
        </div>
      `
    });
  }

  // EMAIL 2: Recipient notification
  if (resend && recipientEmail) {
    await sendEmail({
      resend,
      from: 'receipts@vxsent.com',
      to: recipientEmail,
      subject: `You have a verified delivery — ${fileName}`,
      html: `
        <div style="font-family:monospace;background:#0a1628;color:#00ff88;padding:32px;max-width:600px">
          <h1 style="font-size:24px;letter-spacing:4px;margin:0 0 8px">SENT.</h1>
          <p style="color:#8899aa;margin:0 0 24px;letter-spacing:2px">VERIFIED DELIVERY NOTIFICATION</p>
          <hr style="border-color:#1e3a5f;margin:0 0 24px">
          <p style="color:#e0e0e0;font-size:14px;margin:0 0 16px"><strong style="color:#00ff88">${senderAddr}</strong> has sent you a verified delivery.</p>
          ${effectiveMessage ? `<div style="margin:0 0 16px;padding:16px;background:#0d2137;border-left:3px solid #00ff88"><p style="color:#8899aa;font-size:11px;letter-spacing:1px;margin:0 0 8px">MESSAGE FROM ${escapeHtml(senderAddr)}</p><p style="color:#e0e0e0;font-size:14px;line-height:1.6;margin:0;white-space:pre-wrap">${escapeHtml(effectiveMessage)}</p></div>` : ''}
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">FILE</td><td style="color:#e0e0e0;font-size:12px">${fileName}</td></tr>
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">PROOF ID</td><td style="color:#00ff88;font-size:12px">${proofId}</td></tr>
            <tr><td style="color:#8899aa;padding:6px 0;font-size:12px;letter-spacing:1px">SEALED</td><td style="color:#e0e0e0;font-size:12px">${sealedAt}</td></tr>
          </table>
          <p style="color:#8899aa;font-size:12px;margin:16px 0">This delivery has been cryptographically sealed. Click below to confirm you received it.</p>
          <a href="${confirmUrl}" style="display:block;background:#00ff88;color:#0a1628;text-align:center;padding:14px;text-decoration:none;font-weight:bold;letter-spacing:2px;font-size:13px;margin-top:16px">CONFIRM I RECEIVED THIS →</a>
        </div>
      `
    });
  }

  // EMAIL 4: Habit email (first proof)
  if (resend && proofCount === 1) {
    await sendEmail({
      resend,
      from: 'hello@vxsent.com',
      to: senderAddr,
      subject: 'Next time you send work — do this first',
      html: `
        <div style="font-family:monospace;background:#0a1628;color:#00ff88;padding:32px;max-width:600px">
          <h2 style="letter-spacing:3px;margin:0 0 16px">THE 3-STEP ROUTINE</h2>
          <p style="color:#e0e0e0;font-size:14px;line-height:1.6">1. Finish your work<br>2. Drop it → Create proof → Copy link<br>3. Paste the link with your delivery</p>
          <p style="color:#ff4444;font-size:13px;margin:16px 0;letter-spacing:1px">SKIP THIS ONCE, AND THAT'S THE ONE TIME IT MATTERS.</p>
          <a href="https://vxsent.com" style="display:block;background:#00ff88;color:#0a1628;text-align:center;padding:14px;text-decoration:none;font-weight:bold;letter-spacing:2px;font-size:13px;margin-top:16px">PROOF YOUR NEXT FILE →</a>
        </div>
      `
    });
  }

  // EMAIL 5: Subscription nudge (second proof)
  if (resend && proofCount === 2) {
    await sendEmail({
      resend,
      from: 'hello@vxsent.com',
      to: senderAddr,
      subject: "You've created 2 proofs — unlimited is $12.99",
      html: `
        <div style="font-family:monospace;background:#0a1628;color:#00ff88;padding:32px;max-width:600px">
          <h2 style="letter-spacing:3px;margin:0 0 16px">YOU'VE CREATED 2 PROOFS</h2>
          <p style="color:#e0e0e0;font-size:14px;line-height:1.6">$0.99 × 2 = $1.98 already spent.<br>Unlimited proofs: $12.99/month.</p>
          <a href="https://vxsent.com/pricing" style="display:block;background:#00ff88;color:#0a1628;text-align:center;padding:14px;text-decoration:none;font-weight:bold;letter-spacing:2px;font-size:13px;margin-top:16px">GO UNLIMITED — $12.99/MO →</a>
        </div>
      `
    });
  }
}

// ─── SENT TRANSFER: single-transfer seal (mirrors _transfer-finalize-helper.js) ──
// Inlined here because the webhook is CJS and the helper is ESM (same reason the
// webhook already inlines its own buildRacToken/callVeridex rather than importing).

function canonicalTransferAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) return {};
  const out = {};
  for (const k of Object.keys(attrs).sort()) {
    const v = attrs[k];
    if (v === null || v === undefined || v === '') continue;
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function buildTransferAgreementHash(transfer, evidenceHashes) {
  const canonical = JSON.stringify({
    seller: { name: transfer.seller_name, email: transfer.seller_email },
    buyer: { name: transfer.buyer_name, email: transfer.buyer_email },
    item: {
      title: transfer.item_title, category: transfer.category || '',
      price: transfer.sale_price != null ? String(transfer.sale_price) : '',
      date: transfer.transfer_date || '', description: transfer.description || '',
      condition: transfer.condition || '', condition_custom: transfer.condition_custom || '',
      provenance: transfer.provenance || '', attributes: canonicalTransferAttributes(transfer.category_attributes),
      location: transfer.location || '', notes: transfer.notes || ''
    },
    disclosures: {
      defects: transfer.disclosed_defects || '', damage: transfer.disclosed_damage || '',
      missing_parts: transfer.disclosed_missing_parts || '', repairs: transfer.disclosed_repairs || '',
      special: transfer.disclosed_special_conditions || ''
    },
    toggles: {
      sold_as_is: !!transfer.sold_as_is, no_warranty: !!transfer.no_warranty,
      buyer_inspected: !!transfer.buyer_inspected, inspection_completed: !!transfer.inspection_completed,
      buyer_acknowledged_condition: !!transfer.buyer_acknowledged_condition
    },
    evidence: (evidenceHashes || []).slice().sort()
  });
  return sha256(canonical);
}

function buildTransferChainHash({ transferId, sellerEmail, buyerEmail, agreementHash, timestamp }) {
  const identityHash = sha256(sellerEmail + transferId);
  const scopeHash = sha256(`${buyerEmail}:${agreementHash}`);
  return sha256(`${identityHash}:${scopeHash}:transfer:${timestamp}`);
}

async function sealSingleTransfer({ supabase, resend, metadata, paymentIntentId }) {
  const transferId = metadata.transfer_id;
  if (!transferId) { console.warn('[webhook] single_transfer with no transfer_id'); return; }

  // Load transfer
  const { data: transfer } = await supabase.from('transfers').select('*').eq('id', transferId).maybeSingle();
  if (!transfer) { console.error('[webhook] transfer not found:', transferId); return; }
  if (transfer.is_valid) { console.log('[webhook] transfer already sealed:', transferId); return; }

  // Evidence hashes
  const { data: evidence } = await supabase.from('transfer_evidence').select('file_hash').eq('transfer_id', transferId);
  const evidenceHashes = (evidence || []).map(e => e.file_hash);

  const sealedAt = new Date().toISOString();
  const agreementHash = buildTransferAgreementHash(transfer, evidenceHashes);
  const chainHash = buildTransferChainHash({
    transferId, sellerEmail: transfer.seller_email, buyerEmail: transfer.buyer_email, agreementHash, timestamp: sealedAt
  });

  // Signature: reuse callVeridex with transfer context (fallback = SHA-256)
  let signature;
  try {
    const veridexUrl = process.env.VERIDEX_API_URL;
    const veridexKey = process.env.VERIDEX_API_KEY;
    if (veridexUrl && veridexKey) {
      const r = await fetch(`${veridexUrl}/v1/guardedCommit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${veridexKey}`, 'X-Idempotency-Key': transferId, 'X-RAC-Version': '1.0' },
        body: JSON.stringify({ action: 'seal_transfer', transfer_id: transferId, agreement_hash: agreementHash, rac_chain_hash: chainHash, timestamp: sealedAt })
      });
      if (!r.ok) throw new Error(`Veridex ${r.status}`);
      const j = await r.json();
      signature = j.signature;
    } else {
      signature = sha256(`${transferId}:${agreementHash}:${sealedAt}`);
    }
  } catch (e) {
    console.error('[webhook] transfer Veridex failed, fallback:', e.message);
    signature = sha256(`${transferId}:${agreementHash}:${sealedAt}`);
  }

  const { error: upErr } = await supabase.from('transfers').update({
    agreement_hash: agreementHash,
    rac_chain_hash: chainHash,
    veridex_signature: signature,
    sealed_at: sealedAt,
    is_valid: true,
    status: 'sealed',
    payment_ref: paymentIntentId,
    updated_at: sealedAt
  }).eq('id', transferId);
  if (upErr) { console.error('[webhook] transfer seal update failed:', upErr.message); throw new Error(upErr.message); }

  await supabase.from('payments').update({ status: 'succeeded' }).eq('stripe_payment_id', paymentIntentId);

  // Emails: seller receipt + buyer acknowledgment request
  const baseUrl = 'https://vxsent.com';
  if (resend) {
    await sendEmail({
      resend, from: 'receipts@vxsent.com', to: transfer.seller_email,
      subject: `Verified Transfer sealed — ${transfer.item_title}`,
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8"><div style="background:#00b356;color:#fff;padding:14px 28px;border-radius:8px 8px 0 0"><div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:0.1em">✓ TRANSFER SEALED</div></div><div style="background:#fff;border:1px solid #e1e4e8;border-top:none;border-radius:0 0 8px 8px;padding:32px"><h2 style="font-family:'Bebas Neue',sans-serif;font-size:24px;color:#111318;margin-bottom:8px">PROOF CREATED. AWAITING ACKNOWLEDGMENT.</h2><p style="font-size:13px;color:#374151;line-height:1.65;margin-bottom:20px">Your verified transfer is sealed and timestamped. <strong>${transfer.buyer_name}</strong> has been sent a secure link to review and acknowledge.</p><a href="${baseUrl}/verify/${transferId}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">VIEW TRANSFER →</a></div></div>`
    });
    await sendEmail({
      resend, from: 'receipts@vxsent.com', to: transfer.buyer_email,
      subject: `${transfer.seller_name} sent you a Verified Transfer — review & acknowledge`,
      html: `<div style="font-family:'DM Sans',sans-serif;max-width:560px;margin:0 auto;padding:40px 20px;background:#f5f6f8"><div style="background:#fff;border:1px solid #e1e4e8;border-radius:8px;padding:32px;border-top:3px solid #00b356"><h2 style="font-size:20px;color:#111318;margin-bottom:12px">You have a Verified Transfer.</h2><p style="font-size:14px;color:#374151;line-height:1.65;margin-bottom:24px"><strong>${transfer.seller_name}</strong> has sent you a verified record of a sale. Review the condition, photos, and disclosures, then acknowledge. Your acknowledgment is cryptographically sealed and protects both parties.</p><a href="${baseUrl}/transfer-ack?id=${transferId}" style="display:inline-block;padding:14px 28px;background:#00b356;color:#fff;text-decoration:none;font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:0.1em;border-radius:4px">REVIEW & ACKNOWLEDGE →</a></div></div>`
    });
  }

  console.log('[webhook] single transfer sealed:', transferId);
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!stripeKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Stripe not configured' }) };
  }

  const stripe = require('stripe')(stripeKey);

  // Verify Stripe signature
  let stripeEvent;
  try {
    const sig = event.headers['stripe-signature'];
    if (!sig) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Signature failed: No stripe-signature header value was provided.' }) };
    }
    if (webhookSecret) {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
    } else {
      stripeEvent = JSON.parse(event.body);
      console.warn('[webhook] No STRIPE_WEBHOOK_SECRET — skipping signature verification');
    }
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return { statusCode: 400, body: JSON.stringify({ error: `Signature failed: ${err.message}` }) };
  }

  // Test event passthrough
  if (stripeEvent.id && stripeEvent.id.startsWith('evt_test_')) {
    console.log('[webhook] Test event detected:', stripeEvent.type);
    return { statusCode: 200, body: JSON.stringify({ verified: true }) };
  }

  console.log('[webhook] Event received:', stripeEvent.type, stripeEvent.id);

  // Initialize clients
  let supabase = null;
  if (supabaseUrl && supabaseKey) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(supabaseUrl, supabaseKey);
  } else {
    console.error('[webhook] Supabase not configured');
    return { statusCode: 200, body: JSON.stringify({ received: true, warning: 'DB not configured' }) };
  }

  let resend = null;
  if (resendKey) {
    const { Resend } = require('resend');
    resend = new Resend(resendKey);
  }

  try {
    switch (stripeEvent.type) {

      // ── checkout.session.completed (Stripe Checkout flow) ──────────────────
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const meta = session.metadata || {};

        console.log('[webhook] checkout.session.completed:', session.id, 'proofId:', meta.proof_id);

        // Get the PaymentIntent ID from the session
        const paymentIntentId = session.payment_intent || session.id;

        // SENT Transfer single-transfer via Checkout
        if (meta.product === 'single_transfer') {
          await sealSingleTransfer({ supabase, resend, metadata: meta, paymentIntentId });
          break;
        }

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

      // ── payment_intent.succeeded (PaymentIntent flow) ──────────────────────
      case 'payment_intent.succeeded': {
        const pi = stripeEvent.data.object;
        const meta = pi.metadata || {};

        console.log('[webhook] payment_intent.succeeded:', pi.id, 'product:', meta.product, 'proofId:', meta.proof_id);

        // SENT Transfer single-transfer path
        if (meta.product === 'single_transfer') {
          await sealSingleTransfer({ supabase, resend, metadata: meta, paymentIntentId: pi.id });
          break;
        }

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

      // ── payment_intent.payment_failed ──────────────────────────────────────
      case 'payment_intent.payment_failed': {
        const pi = stripeEvent.data.object;
        const meta = pi.metadata || {};

        // Transfer payment failed — leave transfer pending (seller can retry); mark payment failed
        if (meta.product === 'single_transfer' && meta.transfer_id) {
          await supabase.from('payments').update({ status: 'failed' }).eq('stripe_payment_id', pi.id);
          console.log('[webhook] Transfer payment failed:', meta.transfer_id);
          break;
        }

        const proofId = meta.proof_id;

        if (proofId) {
          await supabase.from('proofs').delete().eq('id', proofId).eq('is_valid', false);
          await supabase.from('payments').update({ status: 'failed' }).eq('stripe_payment_id', pi.id);
          console.log('[webhook] Payment failed, pending proof deleted:', proofId);
        }
        break;
      }

      // ── invoice.payment_succeeded (Solo subscription) ──────────────────────
      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        const customerId = invoice.customer;
        const periodEnd = invoice.lines?.data?.[0]?.period?.end;

        if (customerId) {
          const planExpiresAt = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
          await supabase.from('users').update({
            plan: 'solo',
            plan_expires_at: planExpiresAt,
            updated_at: new Date().toISOString()
          }).eq('stripe_customer_id', customerId);

          console.log('[webhook] Solo plan activated for customer:', customerId);
        }
        break;
      }

      // ── invoice.payment_failed ─────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        const customerId = invoice.customer;

        if (customerId) {
          await supabase.from('users').update({
            plan: 'none',
            updated_at: new Date().toISOString()
          }).eq('stripe_customer_id', customerId);

          console.log('[webhook] Plan downgraded to none for customer:', customerId);
        }
        break;
      }

      // ── customer.subscription.deleted ─────────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const customerId = sub.customer;

        if (customerId) {
          await supabase.from('users').update({
            plan: 'none',
            updated_at: new Date().toISOString()
          }).eq('stripe_customer_id', customerId);

          await supabase.from('subscriptions').update({
            status: 'canceled',
            canceled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }).eq('stripe_customer_id', customerId);

          console.log('[webhook] Subscription canceled for customer:', customerId);
        }
        break;
      }

      // ── customer.subscription.updated ─────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const customerId = sub.customer;
        const periodEnd = sub.current_period_end;

        if (customerId && periodEnd) {
          await supabase.from('users').update({
            plan_expires_at: new Date(periodEnd * 1000).toISOString(),
            updated_at: new Date().toISOString()
          }).eq('stripe_customer_id', customerId);

          console.log('[webhook] Subscription updated for customer:', customerId);
        }
        break;
      }

      default:
        console.log('[webhook] Unhandled event type:', stripeEvent.type);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };

  } catch (err) {
    console.error('[webhook] Handler error:', err.message, err.stack);
    // Return 200 to prevent Stripe retries for non-signature errors
    return { statusCode: 200, body: JSON.stringify({ received: true, error: err.message }) };
  }
};
