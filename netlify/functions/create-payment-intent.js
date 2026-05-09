// netlify/functions/create-payment-intent.js
// SENT. RAC v1 — Creates PaymentIntent + inserts PENDING proof into Supabase

const crypto = require('crypto');

function generateProofId() {
  const year = new Date().getFullYear();
  const bytes = crypto.randomBytes(10).toString('hex').toUpperCase();
  return `SENT-${year}-${bytes.substring(0, 8)}-${bytes.substring(8, 12)}-${bytes.substring(12, 16)}-${bytes.substring(16, 20)}`;
}

async function supabaseInsert(table, record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured');
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
    throw new Error(`Supabase ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data[0] || data;
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
  if (event.httpMethod !== 'POST' ) {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'STRIPE_SECRET_KEY not configured' }) };
    }

    const stripe = require('stripe')(stripeKey);
    let body;
    try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    const { fileHash, fileName, fileSize, timestamp, email, recipientEmail, projectName } = body;

    if (!fileHash || fileHash.length !== 64) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid file hash' }) };
    if (!fileName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'File name required' }) };
    if (!fileSize) return { statusCode: 400, headers, body: JSON.stringify({ error: 'File size required' }) };
    if (!timestamp) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Timestamp required' }) };

    const proofId = generateProofId();
    const now = new Date().toISOString();

    const paymentIntent = await stripe.paymentIntents.create({
      amount: 99,
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
        project_name: (projectName || '').substring(0, 100)
      },
      description: `SENT. proof of delivery — ${fileName.substring(0, 80)}`,
      receipt_email: email || undefined,
      statement_descriptor_suffix: 'SENT PROOF'
    });

    // MINIMAL insert — only fields that definitely exist and won't cause type errors
    const proofRecord = {
      proof_id: proofId,
      file_name: fileName.substring(0, 255),
      file_size: fileSize,
      file_hash: fileHash,
      sender_email: email || null,
      recipient_email: recipientEmail || null,
      project_name: projectName ? projectName.substring(0, 100) : null,
      stripe_payment_id: paymentIntent.id,
      receipt_url: `https://vxsent.com/receipt?id=${proofId}`,
      is_valid: false,
      status: 'pending',
      rac_enabled: true,
      rac_version: 'SENT.RAC.V1'
    };

    await supabaseInsert('proofs', proofRecord );

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
    console.error('[RAC] Error:', error.message);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};
