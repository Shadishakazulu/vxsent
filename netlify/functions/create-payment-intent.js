// netlify/functions/create-payment-intent.js
// SENT. Master Reference v1.0 — Section 2 Steps 2-3
// Creates PaymentIntent + inserts PENDING proof into Supabase

const crypto = require('crypto');

function generateProofId() {
  const year = new Date().getFullYear();
  const bytes = crypto.randomBytes(12).toString('hex').toUpperCase();
  return `SENT-${year}-${bytes.substring(0, 6)}-${bytes.substring(6, 10)}-${bytes.substring(10, 14)}-${bytes.substring(14, 18)}`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }) };
    const stripe = require('stripe')(stripeKey);

    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    const { fileHash, fileName, fileSize, timestamp, email, recipientEmail, projectName } = body;

    if (!fileHash || fileHash.length !== 64) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file hash' }) };
    if (!fileName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'File name required' }) };
    if (!fileSize) return { statusCode: 400, headers, body: JSON.stringify({ error: 'File size required' }) };
    if (!email || !isValidEmail(email)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email' }) };
    if (recipientEmail && !isValidEmail(recipientEmail)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid recipient email' }) };

    const proofId = generateProofId();
    const now = new Date().toISOString();

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 99,
      currency: 'usd',
      metadata: {
        proof_id: proofId,
        file_hash: fileHash,
        file_name: fileName.substring(0, 500),
        file_size: fileSize,
        timestamp: timestamp || now,
        user_email: email,
        recipient_email: recipientEmail || '',
        project_name: projectName || '',
        product: 'day_pass'
      }
    });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (supabaseUrl && supabaseKey) {
      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, supabaseKey);

      try {
        const { error: insertError } = await supabase.from('proofs').insert({
          proof_id: proofId,
          file_name: fileName.substring(0, 255),
          file_size: String(fileSize),
          file_hash: fileHash,
          sealed_at: timestamp || now,
          timestamp: timestamp || now,
          stripe_payment_id: paymentIntent.id,
          user_email: email,
          sender_email: email,
          user_id: null,
          recipient_email: recipientEmail || null,
          project_name: projectName || null,
          is_valid: false,
          rac_enabled: false,
          status: 'pending',
          amount_cents: 99,
          recipient_confirmed: false,
          receipt_email_sent: false
        });
        if (insertError) {
          console.error('[SENT] Proof insert error:', JSON.stringify(insertError));
        } else {
          console.log('[SENT] Pending proof created:', proofId);
        }
      } catch (dbErr) {
        console.error('[SENT] Proof insert failed (non-fatal):', dbErr.message);
      }

      try {
        const { error: payError } = await supabase.from('payments').insert({
          stripe_payment_id: paymentIntent.id,
          user_id: null,
          user_email: email,
          amount: 99,
          currency: 'usd',
          payment_type: 'day_pass',
          status: 'pending',
          proof_id: proofId
        });
        if (payError) {
          console.error('[SENT] Payment audit insert error:', JSON.stringify(payError));
        }
      } catch (payErr) {
        console.error('[SENT] Payment audit insert failed (non-fatal):', payErr.message);
      }
    } else {
      console.warn('[SENT] Supabase not configured — skipping DB inserts');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        proofId,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
      })
    };
  } catch (err) {
    console.error('[SENT] create-payment-intent error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payment initialization failed. Please try again.' }) };
  }
};
