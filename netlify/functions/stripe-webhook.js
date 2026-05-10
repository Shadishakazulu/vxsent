// netlify/functions/stripe-webhook.js
// SENT. Master Reference v1.0 — Sections 2, 6, 9, 13
// Handles all 6 Stripe webhook events exactly per spec

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  );
}

async function supabaseUpdate(table, id, updates) {
  const supabase = getSupabase();
  const { error } = await supabase.from(table).update(updates).eq('id', id);
  if (error) throw new Error('Supabase update ' + table + ': ' + error.message);
}

async function supabaseUpsert(table, record, onConflict) {
  const supabase = getSupabase();
  const opts = onConflict ? { onConflict } : {};
  const { error } = await supabase.from(table).upsert(record, opts);
  if (error) throw new Error('Supabase upsert ' + table + ': ' + error.message);
}

async function supabaseSelect(table, field, value) {
  const supabase = getSupabase();
  const { data, error } = await supabase.from(table).select('*').eq(field, value).maybeSingle();
  if (error) throw new Error('Supabase select ' + table + ': ' + error.message);
  return data;
}

async function supabaseCount(table, field, value) {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(field, value)
    .eq('is_valid', true);
  if (error) return 0;
  return count || 0;
}

async function sendEmail(to, subject, html, fromAddress) {
  const resendKey = process.env.RESEND_API_KEY;
  const from = fromAddress || 'SENT. <receipts@vxsent.com>';
  if (!resendKey) {
    console.log('[SENT] Email (dev):', to, subject);
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html })
    });
    if (!res.ok) console.error('[SENT] Email failed:', to, await res.text());
    else console.log('[SENT] Email sent:', to, subject);
  } catch (e) {
    console.error('[SENT] Email error:', e.message);
  }
}

function buildRACToken(senderEmail, recipientEmail, fileName, fileHash, proofId, paymentId, timestamp) {
  const identityHash = crypto.createHash('sha256').update(senderEmail + proofId).digest('hex');
  const layer1 = { principal: senderEmail, identity_hash: identityHash, authority_level: 'freelancer_delivery', role: 'content_deliverer' };
  const recipient = recipientEmail || 'unspecified';
  const scopeHash = crypto.createHash('sha256').update(recipient + ':' + fileName + ':' + fileHash).digest('hex');
  const layer2 = { recipient, action_scope: 'file_delivery to ' + recipient, deliverable: fileName, project: 'freelance_delivery', scope_hash: scopeHash, scope_lock_ref: null };
  const chainHash = crypto.createHash('sha256').update(identityHash + ':' + scopeHash + ':' + paymentId + ':' + timestamp).digest('hex');
  const layer3 = { confirmation_method: 'stripe_payment_verified', payment_reference: paymentId, file_hash: fileHash, timestamp, chain_hash: chainHash };
  return { layer1, layer2, layer3, chain_hash: chainHash };
}

async function callVeridex(proofId, fileHash, fileName, timestamp, paymentId, racToken) {
  const veridexUrl = process.env.VERIDEX_API_URL;
  const veridexKey = process.env.VERIDEX_API_KEY;
  if (!veridexUrl || !veridexKey) {
    console.warn('[SENT] Veridex not configured - using local fallback');
    const sig = crypto.createHash('sha256').update(proofId + ':' + fileHash + ':' + paymentId).digest('hex');
    return { proof_id: proofId, signature: sig, sealed_at: new Date().toISOString(), algorithm: 'SHA-256-fallback', hash_algorithm: 'SHA-256', rac_sealed: true, rac_chain_hash: racToken.chain_hash };
  }
  const response = await fetch(veridexUrl + '/v1/guardedCommit', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + veridexKey, 'X-Idempotency-Key': proofId, 'X-RAC-Version': '1.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'seal_delivery_proof', proof_id: proofId, file_hash: fileHash, file_name: fileName, timestamp, payment_reference: paymentId, rac_token: racToken })
  });
  if (!response.ok) { const errText = await response.text(); throw new Error('Veridex ' + response.status + ': ' + errText); }
  return await response.json();
}

function receiptEmailHtml(proofId, fileName, fileSize, timestamp, racEnabled, recipientEmail, projectName) {
  const receiptUrl = 'https://vxsent.com/receipt?id=' + proofId;
  const racBlock = racEnabled && recipientEmail ? '<div style="background:#0a1628;border:1px solid #00ff88;border-radius:4px;padding:16px;margin:16px 0;font-family:monospace;font-size:13px;color:#00ff88;"><div style="color:#888;margin-bottom:8px;">RAC CHAIN - SEALED</div><div>WHO: Freelancer - payment verified</div><div>FOR: ' + recipientEmail + '</div>' + (projectName ? '<div>UNDER: ' + projectName + '</div>' : '') + '<div>CONFIRMED BY: Stripe payment</div></div>' : '';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#0a1628;color:#e0e8ff;font-family:system-ui,sans-serif;padding:32px;max-width:600px;margin:0 auto;"><div style="border-bottom:2px solid #00ff88;padding-bottom:16px;margin-bottom:24px;"><span style="color:#00ff88;font-weight:700;font-size:20px;letter-spacing:2px;">SENT.</span><span style="color:#888;margin-left:8px;font-size:12px;">CRYPTOGRAPHIC PROOF OF DELIVERY</span></div><h2 style="color:#00ff88;margin:0 0 8px;">Your SENT. receipt</h2><p style="color:#888;margin:0 0 24px;">Your delivery has been cryptographically sealed.</p><table style="width:100%;border-collapse:collapse;margin-bottom:16px;"><tr><td style="color:#888;padding:6px 0;font-size:13px;">PROOF ID</td><td style="color:#e0e8ff;font-family:monospace;font-size:13px;">' + proofId + '</td></tr><tr><td style="color:#888;padding:6px 0;font-size:13px;">FILE</td><td style="color:#e0e8ff;font-size:13px;">' + fileName + '</td></tr><tr><td style="color:#888;padding:6px 0;font-size:13px;">SIZE</td><td style="color:#e0e8ff;font-size:13px;">' + fileSize + '</td></tr><tr><td style="color:#888;padding:6px 0;font-size:13px;">SEALED</td><td style="color:#e0e8ff;font-size:13px;">' + timestamp + '</td></tr></table>' + racBlock + '<a href="' + receiptUrl + '" style="display:inline-block;background:#00ff88;color:#0a1628;font-weight:700;padding:14px 28px;text-decoration:none;border-radius:4px;letter-spacing:1px;margin-top:8px;">VIEW RECEIPT</a><p style="color:#444;font-size:11px;margin-top:32px;">This receipt is permanently valid.</p></body></html>';
}

function recipientEmailHtml(proofId, senderEmail, fileName, timestamp) {
  const confirmUrl = 'https://vxsent.com/verify/' + proofId + '?confirm=true';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#0a1628;color:#e0e8ff;font-family:system-ui,sans-serif;padding:32px;max-width:600px;margin:0 auto;"><div style="border-bottom:2px solid #00ff88;padding-bottom:16px;margin-bottom:24px;"><span style="color:#00ff88;font-weight:700;font-size:20px;letter-spacing:2px;">SENT.</span><span style="color:#888;margin-left:8px;font-size:12px;">VERIFIED DELIVERY</span></div><h2 style="color:#00ff88;margin:0 0 8px;">You have a verified delivery</h2><p style="color:#888;margin:0 0 24px;"><strong style="color:#e0e8ff;">' + senderEmail + '</strong> sent you a file and created a cryptographic proof of delivery.</p><table style="width:100%;border-collapse:collapse;margin-bottom:16px;"><tr><td style="color:#888;padding:6px 0;font-size:13px;">FROM</td><td style="color:#e0e8ff;font-size:13px;">' + senderEmail + '</td></tr><tr><td style="color:#888;padding:6px 0;font-size:13px;">FILE</td><td style="color:#e0e8ff;font-size:13px;">' + fileName + '</td></tr><tr><td style="color:#888;padding:6px 0;font-size:13px;">PROOF ID</td><td style="color:#e0e8ff;font-family:monospace;font-size:13px;">' + proofId + '</td></tr><tr><td style="color:#888;padding:6px 0;font-size:13px;">SEALED</td><td style="color:#e0e8ff;font-size:13px;">' + timestamp + '</td></tr></table><a href="' + confirmUrl + '" style="display:inline-block;background:#00ff88;color:#0a1628;font-weight:700;padding:14px 28px;text-decoration:none;border-radius:4px;letter-spacing:1px;margin-top:8px;">CONFIRM I RECEIVED THIS</a><p style="color:#444;font-size:11px;margin-top:32px;">Clicking confirm adds a fourth cryptographic layer to the proof.</p></body></html>';
}

function habitEmailHtml() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#0a1628;color:#e0e8ff;font-family:system-ui,sans-serif;padding:32px;max-width:600px;margin:0 auto;"><div style="border-bottom:2px solid #00ff88;padding-bottom:16px;margin-bottom:24px;"><span style="color:#00ff88;font-weight:700;font-size:20px;letter-spacing:2px;">SENT.</span></div><h2 style="color:#00ff88;">Next time you send work - do this first</h2><p style="color:#e0e8ff;">You just created your first SENT. proof. Here is the 3-step routine to protect every delivery:</p><ol style="color:#e0e8ff;line-height:2;"><li><strong>Finish</strong> your work</li><li><strong>Drop</strong> the file at vxsent.com - $0.99</li><li><strong>Proof it</strong>, then send the link with your delivery</li></ol><p style="color:#ff4444;font-weight:700;border-left:3px solid #ff4444;padding-left:12px;margin:24px 0;">SKIP THIS ONCE, AND THAT IS THE ONE TIME IT MATTERS.</p><a href="https://vxsent.com" style="display:inline-block;background:#00ff88;color:#0a1628;font-weight:700;padding:14px 28px;text-decoration:none;border-radius:4px;letter-spacing:1px;">PROOF YOUR NEXT FILE</a></body></html>';
}

function subscriptionNudgeHtml() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="background:#0a1628;color:#e0e8ff;font-family:system-ui,sans-serif;padding:32px;max-width:600px;margin:0 auto;"><div style="border-bottom:2px solid #00ff88;padding-bottom:16px;margin-bottom:24px;"><span style="color:#00ff88;font-weight:700;font-size:20px;letter-spacing:2px;">SENT.</span></div><h2 style="color:#00ff88;">You have created 2 proofs - unlimited is $12.99</h2><p style="color:#e0e8ff;">You have already spent <strong>$0.99 x 2 = $1.98</strong> on day passes.</p><p style="color:#e0e8ff;">For <strong style="color:#00ff88;">$12.99/month</strong> you get unlimited proofs.</p><a href="https://vxsent.com/pricing" style="display:inline-block;background:#00ff88;color:#0a1628;font-weight:700;padding:14px 28px;text-decoration:none;border-radius:4px;letter-spacing:1px;margin-top:8px;">GO UNLIMITED - $12.99/MO</a></body></html>';
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  const metadata = paymentIntent.metadata || {};
  const proofId = metadata.proof_id;
  const fileHash = metadata.file_hash || '';
  const fileName = metadata.file_name || 'unknown';
  const fileSize = metadata.file_size || '';
  const timestamp = metadata.timestamp || new Date().toISOString();
  const senderEmail = metadata.user_email || '';
  const recipientEmail = metadata.recipient_email || null;
  const projectName = metadata.project_name || null;
  const paymentId = paymentIntent.id;
  if (!proofId) { console.error('[SENT] payment_intent.succeeded: missing proof_id in metadata'); return; }
  const supabase = getSupabase();
  const { data: existingProof } = await supabase.from('proofs').select('id, is_valid').eq('id', proofId).maybeSingle();
  if (existingProof && existingProof.is_valid === true) { console.log('[SENT] Proof already sealed - skipping:', proofId); return; }
  const racToken = buildRACToken(senderEmail, recipientEmail, fileName, fileHash, proofId, paymentId, timestamp);
  let veridexResult;
  try {
    veridexResult = await callVeridex(proofId, fileHash, fileName, timestamp, paymentId, racToken);
  } catch (e) {
    console.error('[SENT] Veridex error:', e.message);
    veridexResult = { proof_id: proofId, signature: crypto.createHash('sha256').update(proofId + ':' + fileHash + ':' + paymentId).digest('hex'), sealed_at: new Date().toISOString(), algorithm: 'SHA-256-fallback', hash_algorithm: 'SHA-256', rac_sealed: true, rac_chain_hash: racToken.chain_hash };
  }
  const now = new Date().toISOString();
  const proofUpdates = { veridex_proof_id: veridexResult.proof_id || proofId, veridex_signature: veridexResult.signature, rac_chain_hash: veridexResult.rac_chain_hash || racToken.chain_hash, rac_enabled: true, is_valid: true, stripe_payment_id: paymentId, status: 'sealed', updated_at: now };
  if (!existingProof) {
    const fullRecord = { id: proofId, file_name: fileName.substring(0, 255), file_size: fileSize, file_hash: fileHash, sealed_at: timestamp, stripe_payment_id: paymentId, user_email: senderEmail, user_id: null, recipient_email: recipientEmail, project_name: projectName, is_valid: true, rac_enabled: true, veridex_proof_id: veridexResult.proof_id || proofId, veridex_signature: veridexResult.signature, rac_chain_hash: veridexResult.rac_chain_hash || racToken.chain_hash, status: 'sealed', receipt_url: 'https://vxsent.com/receipt?id=' + proofId, created_at: now, updated_at: now };
    try { await supabaseUpsert('proofs', fullRecord, 'id'); } catch (e) { console.error('[SENT] Proof upsert failed:', e.message); }
  } else {
    try { await supabaseUpdate('proofs', proofId, proofUpdates); } catch (e) { console.error('[SENT] Proof update failed:', e.message); }
  }
  try {
    const sc = getSupabase();
    await sc.from('payments').update({ status: 'succeeded', updated_at: now }).eq('stripe_payment_id', paymentId);
  } catch (e) { console.warn('[SENT] Payment status update failed (non-fatal):', e.message); }
  if (senderEmail) { await sendEmail(senderEmail, 'Your SENT. receipt - ' + fileName, receiptEmailHtml(proofId, fileName, fileSize, timestamp, true, recipientEmail, projectName), 'SENT. <receipts@vxsent.com>'); }
  if (recipientEmail) { await sendEmail(recipientEmail, 'You have a verified delivery - ' + fileName, recipientEmailHtml(proofId, senderEmail, fileName, timestamp), 'SENT. <receipts@vxsent.com>'); }
  if (senderEmail) {
    const totalProofs = await supabaseCount('proofs', 'user_email', senderEmail);
    if (totalProofs === 1) { await sendEmail(senderEmail, 'Next time you send work - do this first', habitEmailHtml(), 'SENT. <hello@vxsent.com>'); }
    else if (totalProofs === 2) { await sendEmail(senderEmail, "You have created 2 proofs - unlimited is $12.99", subscriptionNudgeHtml(), 'SENT. <hello@vxsent.com>'); }
  }
  console.log('[SENT] Proof sealed successfully:', proofId);
}

async function handlePaymentIntentFailed(paymentIntent) {
  const metadata = paymentIntent.metadata || {};
  const proofId = metadata.proof_id;
  const paymentId = paymentIntent.id;
  if (!proofId) return;
  const supabase = getSupabase();
  try {
    await supabase.from('payments').update({ status: 'failed' }).eq('stripe_payment_id', paymentId);
    await supabase.from('proofs').delete().eq('id', proofId).eq('is_valid', false);
  } catch (e) { console.error('[SENT] Failed payment cleanup error:', e.message); }
  console.log('[SENT] Payment failed, pending proof removed:', proofId);
}

async function handleInvoicePaymentSucceeded(invoice) {
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;
  const periodEnd = invoice.lines && invoice.lines.data && invoice.lines.data[0] ? invoice.lines.data[0].period.end : null;
  if (!customerId) return;
  const supabase = getSupabase();
  const { data: user } = await supabase.from('users').select('id, email').eq('stripe_customer_id', customerId).maybeSingle();
  if (!user) { console.warn('[SENT] invoice.payment_succeeded: user not found for customer:', customerId); return; }
  const planExpiresAt = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
  await supabase.from('users').update({ plan: 'solo', plan_expires_at: planExpiresAt, updated_at: new Date().toISOString() }).eq('id', user.id);
  if (subscriptionId) {
    const periodStart = invoice.lines && invoice.lines.data && invoice.lines.data[0] ? invoice.lines.data[0].period.start : null;
    await supabase.from('subscriptions').upsert({ stripe_subscription_id: subscriptionId, stripe_customer_id: customerId, user_id: user.id, plan: 'solo', status: 'active', current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : null, current_period_end: planExpiresAt, updated_at: new Date().toISOString() }, { onConflict: 'stripe_subscription_id' });
  }
  try { await supabase.from('payments').insert({ stripe_payment_id: invoice.payment_intent || invoice.id, user_id: user.id, user_email: user.email, amount: invoice.amount_paid, currency: invoice.currency, payment_type: 'solo_subscription', status: 'succeeded', created_at: new Date().toISOString() }); } catch (e) { console.warn('[SENT] Subscription payment log failed (non-fatal):', e.message); }
  console.log('[SENT] Solo plan activated for:', user.email);
}

async function handleInvoicePaymentFailed(invoice) {
  const customerId = invoice.customer;
  if (!customerId) return;
  const supabase = getSupabase();
  const { data: user } = await supabase.from('users').select('id').eq('stripe_customer_id', customerId).maybeSingle();
  if (!user) return;
  await supabase.from('users').update({ plan: 'none', plan_expires_at: null, updated_at: new Date().toISOString() }).eq('id', user.id);
  console.log('[SENT] Solo plan downgraded (payment failed) for customer:', customerId);
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  if (!customerId) return;
  const supabase = getSupabase();
  const { data: user } = await supabase.from('users').select('id').eq('stripe_customer_id', customerId).maybeSingle();
  if (!user) return;
  await supabase.from('users').update({ plan: 'none', plan_expires_at: null, updated_at: new Date().toISOString() }).eq('id', user.id);
  await supabase.from('subscriptions').update({ status: 'canceled', canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('stripe_subscription_id', subscription.id);
  console.log('[SENT] Solo subscription canceled for customer:', customerId);
}

async function handleSubscriptionUpdated(subscription) {
  const customerId = subscription.customer;
  if (!customerId) return;
  const supabase = getSupabase();
  const { data: user } = await supabase.from('users').select('id').eq('stripe_customer_id', customerId).maybeSingle();
  if (!user) return;
  const periodEnd = subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null;
  await supabase.from('users').update({ plan_expires_at: periodEnd, updated_at: new Date().toISOString() }).eq('id', user.id);
  await supabase.from('subscriptions').update({ status: subscription.status, current_period_end: periodEnd, updated_at: new Date().toISOString() }).eq('stripe_subscription_id', subscription.id);
  console.log('[SENT] Subscription updated for customer:', customerId);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[SENT] Webhook signature failed:', e.message);
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Signature failed: ' + e.message }) };
  }
  console.log('[SENT] Webhook event:', stripeEvent.type, stripeEvent.id);
  try {
    switch (stripeEvent.type) {
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(stripeEvent.data.object);
        break;
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(stripeEvent.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(stripeEvent.data.object);
        break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(stripeEvent.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(stripeEvent.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(stripeEvent.data.object);
        break;
      default:
        console.log('[SENT] Unhandled event type:', stripeEvent.type);
    }
  } catch (e) {
    console.error('[SENT] Webhook handler error:', stripeEvent.type, e.message);
  }
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ received: true, type: stripeEvent.type }) };
};
