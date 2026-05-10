// netlify/functions/create-checkout-session.js
// SENT. Master Reference v1.0 — Checkout Session with proofId in success_url
// Creates pending DB record before redirecting to Stripe Checkout

const crypto = require('crypto');

function generateProofId() {
  const year = new Date().getFullYear();
  const rand1 = crypto.randomBytes(3).toString('hex').toUpperCase();
  const rand2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const rand3 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const rand4 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `SENT-${year}-${rand1}-${rand2}-${rand3}-${rand4}`;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (!stripeKey) {
      console.error('[create-checkout-session] STRIPE_SECRET_KEY not set');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payment service not configured' }) };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { email, recipientEmail, fileName, fileHash, fileSize, projectName, timestamp } = body;

    // Validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
    }
    if (!fileName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'File name is required' }) };
    }
    if (!fileHash || fileHash.length !== 64) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file hash' }) };
    }

    // Generate proofId BEFORE creating Stripe session
    const proofId = generateProofId();
    const sealedAt = timestamp || new Date().toISOString();

    // Initialize Stripe
    const stripe = require('stripe')(stripeKey);

    const origin = event.headers.origin || 'https://vxsent.com';

    // Create Stripe Checkout Session with proofId in success_url
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'SENT. Delivery Proof',
            description: `Proof of delivery for: ${fileName}`
          },
          unit_amount: 99
        },
        quantity: 1
      }],
      mode: 'payment',
      customer_email: email,
      // proofId embedded in success_url so receipt page gets it immediately
      success_url: `${origin}/receipt?id=${proofId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=true`,
      metadata: {
        proof_id: proofId,
        file_hash: fileHash,
        file_name: fileName.substring(0, 100),
        file_size: fileSize || '',
        sender_email: email,
        recipient_email: recipientEmail || '',
        user_email: email,
        project_name: (projectName || '').substring(0, 100),
        product: 'day_pass',
        timestamp: sealedAt
      },
      payment_intent_data: {
        metadata: {
          proof_id: proofId,
          file_hash: fileHash,
          file_name: fileName.substring(0, 100),
          file_size: fileSize || '',
          sender_email: email,
          recipient_email: recipientEmail || '',
          user_email: email,
          project_name: (projectName || '').substring(0, 100),
          product: 'day_pass',
          timestamp: sealedAt
        }
      }
    });

    console.log('[create-checkout-session] Session created:', session.id, 'proofId:', proofId);

    // Create pending proof record in Supabase BEFORE redirecting
    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(supabaseUrl, supabaseKey);

        const { error: insertError } = await supabase.from('proofs').insert({
          id: proofId,
          file_name: fileName,
          file_size: fileSize || null,
          file_hash: fileHash,
          sealed_at: sealedAt,
          stripe_payment_id: session.payment_intent || session.id,
          stripe_session_id: session.id,
          user_email: email,
          recipient_email: recipientEmail || null,
          project_name: projectName || null,
          is_valid: false,
          rac_enabled: false,
          status: 'pending',
          created_at: new Date().toISOString()
        });

        if (insertError) {
          console.error('[create-checkout-session] DB insert error:', insertError.message);
          // Don't fail — still redirect to Stripe, webhook will handle DB
        } else {
          console.log('[create-checkout-session] Pending proof created:', proofId);
        }
      } catch (dbErr) {
        console.error('[create-checkout-session] DB error:', dbErr.message);
        // Don't fail — webhook will create the record
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url })
    };

  } catch (error) {
    console.error('[create-checkout-session] Error:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || 'Checkout session creation failed' })
    };
  }
};
