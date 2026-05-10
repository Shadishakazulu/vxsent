// netlify/functions/stripe-webhook.js
// SENT. RAC v1 — Stripe Webhook Handler (fully self-contained, no relative imports)

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function ok(data) {
  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(data) };
}

function err(message, statusCode) {
  return { statusCode: statusCode || 400, headers: corsHeaders, body: JSON.stringify({ error: message }) };
}

async function sendEmail(to, subject, html) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) { console.log('[SENT] Email (dev):', to, subject); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + resendKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'SENT. <receipts@vxsent.com>', to, subject, html })
  });
  if (!res.ok) console.error('[SENT] Email failed:', to, await res.text());
  else console.log('[SENT] Email sent:', to);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return err('Method not allowed', 405);

  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('[SENT] Webhook sig failed:', e.message);
    return err('Signature failed: ' + e.message, 400);
  }

  console.log('[SENT] Event:', stripeEvent.type, stripeEvent.id);

  if (stripeEvent.type !== 'checkout.session.completed') {
    return ok({ received: true, type: stripeEvent.type });
  }

  const session = stripeEvent.data.object;
  const metadata = session.metadata || {};
  const senderEmail = metadata.sender_email;
  const recipientEmail = metadata.recipient_email || null;
  const fileName = metadata.file_name || 'unknown';
  const fileHash = metadata.file_hash || '';
  const fileSize = metadata.file_size || '';
  const projectName = metadata.project_name || '';

  if (!senderEmail) {
    console.error('[SENT] Missing sender_email. Metadata:', JSON.stringify(metadata));
    return err('Missing sender email', 400);
  }

  const supabase = getSupabase();
  const now = new Date().toISOString();
  const proofId = crypto.randomUUID();

  const chainData = proofId + ':' + fileHash + ':' + senderEmail + ':' + now;
  const racChainHash = crypto.createHash('sha256').update(chainData).digest('hex');

  const proofRecord = {
    proof_id:           proofId,
    file_name:          fileName,
    file_size:          fileSize,
    file_hash:          fileHash,
    sealed_at:          now,
    stripe_payment_id:  session.payment_intent || session.id,
    stripe_session_id:  session.id,
    user_email:         senderEmail,
    sender_email:       senderEmail,
    recipient_email:    recipientEmail,
    project_name:       projectName,
    rac_chain_hash:     racChainHash,
    rac_enabled:        true,
    rac_version:        'v1',
    status:             'sealed',
    is_valid:           true,
    amount_cents:       session.amount_total || 99,
    timestamp:          now,
    created_at:         now,
    receipt_email_sent: false,
  };

  console.log('[SENT] Inserting proof:', proofId, 'for', senderEmail);

  const { data: proof, error: dbError } = await supabase
    .from('proofs')
    .insert(proofRecord)
    .select()
    .single();

  if (dbError) {
    console.error('[SENT] DB error:', dbError.message);
    return err('DB error: ' + dbError.message, 500);
  }

  console.log('[SENT] Proof created:', proof.id, proof.proof_id);

  const receiptUrl = 'https://vxsent.com/receipt?id=' + proof.proof_id;

  await supabase
    .from('proofs')
    .update({ receipt_url: receiptUrl, receipt_email_sent: true })
    .eq('id', proof.id);

  const senderHtml = '<div style="font-family:monospace;background:#0a1628;color:#00ff88;padding:32px;max-width:600px;"><h1 style="color:#00ff88;font-size:24px;letter-spacing:4px;">SENT.</h1><p style="color:#8892a4;">YOUR PROOF HAS BEEN SEALED ON THE RAC CHAIN</p><hr style="border-color:#1a2a4a;"/><table style="width:100%;color:#cdd6f4;font-size:14px;"><tr><td style="padding:8px 0;color:#8892a4;">FILE</td><td>' + fileName + '</td></tr><tr><td style="padding:8px 0;color:#8892a4;">SEALED AT</td><td>' + new Date(now).toLocaleString() + '</td></tr><tr><td style="padding:8px 0;color:#8892a4;">PROOF ID</td><td style="color:#00ff88;font-size:12px;">' + proofId + '</td></tr><tr><td style="padding:8px 0;color:#8892a4;">RAC HASH</td><td style="font-size:11px;word-break:break-all;">' + racChainHash.substring(0,32) + '...</td></tr></table><hr style="border-color:#1a2a4a;"/><a href="' + receiptUrl + '" style="display:inline-block;background:#00ff88;color:#0a1628;padding:12px 24px;text-decoration:none;font-weight:bold;letter-spacing:2px;margin-top:16px;">VIEW RECEIPT</a><p style="color:#8892a4;font-size:12px;margin-top:24px;">This proof is permanently sealed and tamper-evident.</p></div>';
  await sendEmail(senderEmail, 'SENT. — Your Proof Has Been Sealed', senderHtml);

  if (recipientEmail) {
    const recipientHtml = '<div style="font-family:monospace;background:#0a1628;color:#00ff88;padding:32px;max-width:600px;"><h1 style="color:#00ff88;font-size:24px;letter-spacing:4px;">SENT.</h1><p style="color:#8892a4;">YOU HAVE RECEIVED A VERIFIED DELIVERY PROOF</p><hr style="border-color:#1a2a4a;"/><p style="color:#cdd6f4;"><strong style="color:#00ff88;">' + senderEmail + '</strong> has sent you a cryptographically sealed proof of delivery.</p><table style="width:100%;color:#cdd6f4;font-size:14px;"><tr><td style="padding:8px 0;color:#8892a4;">FILE</td><td>' + fileName + '</td></tr>' + (projectName ? '<tr><td style="padding:8px 0;color:#8892a4;">PROJECT</td><td>' + projectName + '</td></tr>' : '') + '<tr><td style="padding:8px 0;color:#8892a4;">SEALED AT</td><td>' + new Date(now).toLocaleString() + '</td></tr></table><hr style="border-color:#1a2a4a;"/><a href="' + receiptUrl + '" style="display:inline-block;background:#00ff88;color:#0a1628;padding:12px 24px;text-decoration:none;font-weight:bold;letter-spacing:2px;margin-top:16px;">VIEW AND CONFIRM RECEIPT</a><p style="color:#8892a4;font-size:12px;margin-top:24px;">Click to view and confirm receipt. This creates an immutable record on the RAC chain.</p></div>';
    await sendEmail(recipientEmail, 'SENT. — ' + senderEmail + ' has sent you a verified proof', recipientHtml);
  }

  return ok({ success: true, proof_id: proofId, receipt_url: receiptUrl });
};
