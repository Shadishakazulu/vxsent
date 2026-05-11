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

  if (event.httpMethod === 'OPTIONS' ) {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'POST' ) return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }) };
    const stripe = require('stripe')(stripeKey);

    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

    const { fileHash, fileName, fileSize, timestamp, email, recipientEmail, projectName } = body;

    if (!fileHash || fileHash.length !== 64) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file hash (must be 64-char SHA-256)' }) };
    if (!fileName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'File name required' }) };
    if (!fileSize) return { statusCode: 400, headers, body: JSON.stringify({ error: 'File size required' }) };
    if (!email || !isValidEmail(email)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email address' }) };

    // RAC Level 3: recipient email is required
    if (!recipientEmail || !isValidEmail(recipientEmail)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Client email is required for RAC Level 3 proof' }) };
    }

    const proofId = generateProofId();
    const now = new Date().toISOString();

    // Step 1: Create Stripe PaymentIntent
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
        sender_email: email,
        recipient_email: recipientEmail,
        project_name: projectName || '',
        rac_level: '3',
        product: 'day_pass'
      }
    });

    // Step 2: Insert PENDING proof into Supabase using supabase-js
    try {
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

      if (!supabaseUrl || !supabaseKey) {
        throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not configured');
      }

      const { createClient } = require('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, supabaseKey);

      const { error: insertError } = await supabase
        .from('proofs')
        .insert({
          proof_id: proofId,
          file_hash: fileHash,
          file_name: fileName.substring(0, 255),
          file_size: fileSize,
          timestamp: timestamp || now,
          sender_email: email,
          recipient_email: recipientEmail,
          rac_level: 3,
          rac_signature: null,
          status: 'pending'
        });

      if (insertError) {
        console.error('[SENT] Proof insert failed:', insertError.message, insertError.details, insertError.hint);
      } else {
        console.log('[SENT] Pending proof created (RAC Level 3):', proofId);
      }
    } catch (dbErr) {
      console.error('[SENT] DB error (non-fatal):', dbErr.message);
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
