// netlify/functions/create-payment-intent.js
// SENT. RAC v1 — Creates PaymentIntent + inserts PENDING proof into Supabase
// Signing and chain linking happen AFTER payment succeeds (webhook)

const crypto = require('crypto');

// ─── Proof ID Generation ───────────────────────────────────────────────────────
// Format: SENT-{YEAR}-{8HEX}-{4HEX}-{4HEX}-{4HEX}

function generateProofId() {
  const year = new Date().getFullYear();
  const bytes = crypto.randomBytes(10).toString('hex').toUpperCase();
  return `SENT-${year}-${bytes.substring(0, 8)}-${bytes.substring(8, 12)}-${bytes.substring(12, 16)}-${bytes.substring(16, 20)}`;
}

// ─── Supabase Helper ───────────────────────────────────────────────────────────

async function supabaseInsert(table, record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE credentials not configured');
  }

  const response = await fetch(`${url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(record)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Supabase insert failed: ${response.status} ${errText}`);
  }

  const data = await response.json();
  return data[0] || data;
}

// ─── Handler ───────────────────────────────────────────────────────────────────

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

  if (event.httpMethod !== 'POST' ) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // ─── Validate environment ───────────────────────────────────────────────
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('[FATAL] STRIPE_SECRET_KEY not configured');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payment service not configured' }) };
    }

    const stripe = require('stripe')(stripeKey);

    // ─── Parse and validate request body ────────────────────────────────────
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
    }

    const { fileHash, fileName, fileSize, timestamp, email, recipientEmail, projectName } = body;

    // Strict validation
    if (!fileHash || typeof fileHash !== 'string' || fileHash.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(fileHash)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid SHA-256 file hash (must be 64 hex characters)' }) };
    }
    if (!fileName || typeof fileName !== 'string' || fileName.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'File name required' }) };
    }
    if (!fileSize || typeof fileSize !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'File size required' }) };
    }
    if (!timestamp || typeof timestamp !== 'string') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Timestamp required' }) };
    }

    // ─── Generate proof ID ──────────────────────────────────────────────────
    const proofId = generateProofId();
    const createdAt = new Date().toISOString();

    console.log(`[RAC] Creating proof: ${proofId} | file: ${fileName} | hash: ${fileHash.substring(0, 16)}...`);

    // ─── Create Stripe PaymentIntent ────────────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 99, // $0.99 USD
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        proof_id: proofId,
        file_hash: fileHash,
        file_name: fileName.substring(0, 100),
        file_size: fileSize,
        timestamp: timestamp,
        user_email: email || '',
        recipient_email: recipientEmail || '',
        project_name: (projectName || '').substring(0, 100),
        product: 'sent_proof',
        rac_version: 'SENT.RAC.V1'
      },
      description: `SENT. proof of delivery — ${fileName.substring(0, 80)}`,
      receipt_email: email || undefined,
      statement_descriptor_suffix: 'SENT PROOF'
    });

    // ─── Insert PENDING proof into Supabase ─────────────────────────────────
    // No cryptographic signing yet — that happens in the webhook after payment confirms
    const proofRecord = {
      proof_id: proofId,
      file_name: fileName.substring(0, 255),
      file_size: fileSize,
      file_hash: fileHash.toLowerCase(), // Normalize to lowercase hex
      timestamp: timestamp,
      sealed_at: null,
      verified_at: null,
      user_email: email || null,
      sender_email: email || null,
      recipient_email: recipientEmail || null,
      project_name: projectName ? projectName.substring(0, 100) : null,
      ed25519_signature: null,
      ed25519_public_key: null,
      chain_hash: null,
      previous_proof_id: null,
      rac_version: 'SENT.RAC.V1',
      stripe_payment_id: paymentIntent.id,
      receipt_url: `https://vxsent.com/receipt?id=${proofId}`,
      is_valid: false,
      status: 'pending_payment',
      created_at: createdAt,
      updated_at: createdAt
    };

    await supabaseInsert('proofs', proofRecord );
    console.log(`[RAC] Pending proof inserted: ${proofId}`);

    // ─── Return to frontend ─────────────────────────────────────────────────
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        proofId: proofId,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
      })
    };

  } catch (error) {
    console.error('[RAC] create-payment-intent error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Payment initialization failed. Please try again.' })
    };
  }
};
