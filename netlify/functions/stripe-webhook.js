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
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
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

  const sealedAt = new Date().toISOString();
  const stripePaymentId = session.payment_intent || session.id;
  const proofId = crypto.randomUUID();
  const racHash = crypto.createHash('sha256')
    .update(JSON.stringify({ proofId, fileHash, senderEmail, recipientEmail: recipientEmail || '', sealedAt, stripePaymentId }))
    .digest('hex');

  console.log('[SENT] Creating proof:', proofId, 'sender:', senderEmail);

  try {
    const supabase = getSupabase();
    const { error: insertError } = await supabase.from('proofs').insert({
      id: proofId,
      sender_email: senderEmail,
      recipient_email: recipientEmail,
      file_name: fileName,
      file_hash: fileHash,
      file_size: fileSize,
      project_name: projectName,
      stripe_payment_id: stripePaymentId,
      rac_hash: racHash,
      sealed_at: sealedAt,
      status: 'sealed',
      recipient_confirmed: false
    });
    if (insertError) {
      console.error('[SENT] DB insert error:', JSON.stringify(insertError));
      return err('DB error: ' + insertError.message, 500);
    }
    console.log('[SENT] Proof saved:', proofId);
  } catch (dbErr) {
    console.error('[SENT] DB exception:', dbErr.message);
    return err('DB exception: ' + dbErr.message, 500);
  }

  const base = process.env.URL || 'https://vxsent.com';

  try {
    await sendEmail(senderEmail, 'Your proof is sealed — ' + fileName,
      '<div style="font-family:sans-serif;padding:32px;max-width:560px"><h2>SENT.</h2><p>Your proof for <strong>' + fileName + '</strong> is sealed.</p><p>Proof ID: <code>' + proofId + '</code></p><p>Sealed: ' + new Date(sealedAt).toUTCString() + '</p><a href="' + base + '/receipt?id=' + proofId + '" style="background:#00b356;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;margin-top:16px">VIEW RECEIPT</a></div>'
    );
    if (recipientEmail) {
      await sendEmail(recipientEmail, 'You have a verified delivery — ' + fileName,
        '<div style="font-family:sans-serif;padding:32px;max-width:560px"><h2>SENT.</h2><p><strong>' + senderEmail + '</strong> sent you a verified file: <strong>' + fileName + '</strong></p><p>Proof ID: <code>' + proofId + '</code></p><p>Sealed: ' + new Date(sealedAt).toUTCString() + '</p><a href="' + base + '/verify/' + proofId + '?confirm=true" style="background:#00b356;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;display:inline-block;margin-top:16px">CONFIRM RECEIPT</a></div>'
      );
    }
  } catch (emailErr) {
    console.error('[SENT] Email error (non-fatal):', emailErr.message);
  }

  return ok({ received: true, proofId, racHash, sealedAt });
};
