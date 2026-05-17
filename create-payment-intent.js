// create-payment-intent.js
// Spec-compliant: creates PaymentIntent + pending DB record immediately
// so receipt.html can find the proof while waiting for webhook to seal it.

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function generateProofId() {
  const y = new Date().getFullYear();
  const h = n => Math.random().toString(16).substring(2, 2 + n).toUpperCase();
  return `SENT-${y}-${h(6)}-${h(4)}-${h(4)}-${h(4)}`;
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { fileHash, fileName, fileSize, timestamp, email, recipientEmail, projectName } = body;

    // Validate required fields
    if (!fileHash || typeof fileHash !== 'string' || fileHash.length !== 64) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid 64-char file hash required' }) };
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
    }
    if (!fileName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'File name required' }) };
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!stripeKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payment service not configured' }) };
    }

    // Generate proofId BEFORE creating Stripe PaymentIntent
    const proofId = generateProofId();
    const sealedAt = timestamp || new Date().toISOString();

    // Initialize Stripe
    const stripe = require('stripe')(stripeKey);

    // Create Stripe PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 99, // $0.99 in cents
      currency: 'usd',
      metadata: {
        proof_id: proofId,
        file_hash: fileHash,
        file_name: fileName.substring(0, 100),
        file_size: String(fileSize || ''),
        sender_email: email,
        recipient_email: recipientEmail || '',
        user_email: email,
        project_name: (projectName || '').substring(0, 100),
        product: 'day_pass',
        timestamp: sealedAt
      },
      receipt_email: email
    });

    console.log('[create-payment-intent] PaymentIntent created:', paymentIntent.id, 'proofId:', proofId);

    // Create PENDING proof record in Supabase immediately
    // This allows receipt.html to find the proof while waiting for the webhook
    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { error: insertError } = await supabase.from('proofs').insert({
          proof_id: proofId,
          file_name: fileName,
          file_size: String(fileSize || '0'),
          file_hash: fileHash,
          sealed_at: sealedAt,
          stripe_payment_id: paymentIntent.id,
          stripe_session_id: null,
          user_email: email,
          sender_email: email,
          recipient_email: recipientEmail || null,
          project_name: projectName || null,
          is_valid: false,
          rac_enabled: false,
          recipient_confirmed: false,
          status: 'pending',
          amount_cents: 99,
          timestamp: sealedAt,
          rac_signature: '',
          veridex_proof_id: null,
          veridex_signature: null,
          ed25519_signature: null,
          ed25519_public_key: null,
          chain_hash: null,
          rac_chain_hash: null,
          receipt_email_sent: false,
          dispute_status: null,
          receipt_url: null,
          user_id: null,
          user_agent: event.headers['user-agent'] || null,
          ip_address: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null
        });

        if (insertError) {
          console.error('[create-payment-intent] DB insert error:', JSON.stringify(insertError));
          // Don't fail the payment — the webhook will try to upsert later
        } else {
          console.log('[create-payment-intent] Pending proof created:', proofId);
        }
      } catch (dbErr) {
        console.error('[create-payment-intent] DB error:', dbErr.message);
        // Don't fail the payment — continue
      }
    } else {
      console.warn('[create-payment-intent] Supabase not configured — skipping DB insert');
    }

    // Return clientSecret, proofId, and publishableKey to the frontend
    const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY || '';

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        proofId: proofId,
        publishableKey: publishableKey
      })
    };

  } catch (err) {
    console.error('[create-payment-intent] Error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Payment initialization failed. Please try again.' })
    };
  }
};
