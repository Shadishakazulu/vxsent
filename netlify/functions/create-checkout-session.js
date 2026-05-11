// netlify/functions/create-checkout-session.js
// SENT. — Stripe Checkout flow with proofId in success_url
// Uses EXACT column names from live Supabase proofs table

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

    // Create Stripe Checkout Session with proofId embedded in success_url
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
      allow_promotion_codes: true,
      success_url: `${origin}/receipt?id=${proofId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=true`,
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
      payment_intent_data: {
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
        }
      }
    });

    console.log('[create-checkout-session] Session created:', session.id, 'proofId:', proofId);

    // Create PENDING proof record in Supabase using EXACT column names from live DB
    if (supabaseUrl && supabaseKey) {
      try {
        const { createClient } = require('@supabase/supabase-js');
        const supabase = createClient(supabaseUrl, supabaseKey);

        // Use only columns that exist in the live proofs table
        // Columns confirmed from user's DB: id, file_name, file_size, file_hash,
        // veridex_proof_id, veridex_signature, sealed_at, stripe_payment_id,
        // stripe_session_id, user_id, user_email, receipt_url, is_valid,
        // created_at, recipient_email, project_name, rac_chain_hash, rac_enabled,
        // proof_id, sender_email, timestamp, rac_signature, status, verified_at,
        // updated_at, ed25519_signature, ed25519_public_key, chain_hash,
        // previous_proof_id, rac_version, receipt_email_sent, dispute_status,
        // amount_cents, user_agent, ip_address, recipient_confirmed,
        // recipient_confirmed_at, recipient_confirmation_ip,
        // recipient_confirmation_user_agent

        const { error: insertError } = await supabase.from('proofs').insert({
          proof_id: proofId,
          file_name: fileName,
          file_size: String(fileSize || '0'),
          file_hash: fileHash,
          sealed_at: sealedAt,
          stripe_session_id: session.id,
          stripe_payment_id: session.payment_intent || null,
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
          console.error('[create-checkout-session] DB insert error:', JSON.stringify(insertError));
        } else {
          console.log('[create-checkout-session] Pending proof created:', proofId);
        }
      } catch (dbErr) {
        console.error('[create-checkout-session] DB error:', dbErr.message);
      }
    } else {
      console.warn('[create-checkout-session] Supabase not configured — skipping DB insert');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ url: session.url })
    };

  } catch (err) {
    console.error('[create-checkout-session] Error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Payment initialization failed. Please try again.' })
    };
  }
};
