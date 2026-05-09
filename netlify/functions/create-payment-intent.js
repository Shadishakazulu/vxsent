// netlify/functions/create-payment-intent.js
// Production-grade: creates PaymentIntent + inserts pending proof into Supabase

const crypto = require('crypto');

function generateProofId() {
  const prefix = 'PROOF';
  const segment = crypto.randomBytes(10).toString('hex').toUpperCase();
  return `${prefix}-${segment.substring(0, 8)}${segment.substring(8, 16)}${segment.substring(16, 20)}`;
}

function generateRACSignature(fileHash, timestamp, proofId) {
  const data = `${fileHash}|${timestamp}|${proofId}`;
  return crypto.createHash('sha256').update(data).digest('hex').toUpperCase();
}

async function supabaseInsert(table, record) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Supabase credentials not configured');
    return null;
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
    console.error(`Supabase insert failed: ${response.status} ${errText}`);
    return null;
  }

  const data = await response.json();
  return data[0] || data;
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('STRIPE_SECRET_KEY not set');
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Payment service not configured. Please contact support.' })
      };
    }

    const stripe = require('stripe')(stripeKey);

    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid request body' })
      };
    }

    const { fileHash, fileName, fileSize, timestamp, email, recipientEmail, projectName } = body;

    // Validation
    if (!fileHash || fileHash.length !== 64) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid file hash' })
      };
    }
    if (!fileName) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'File name required' })
      };
    }
    if (!fileSize) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'File size required' })
      };
    }
    if (!timestamp) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Timestamp required' })
      };
    }

    // Generate proof ID upfront so frontend can track it
    const proofId = generateProofId();
    const sealTimestamp = new Date().toISOString();
    const racSignature = generateRACSignature(fileHash, sealTimestamp, proofId);

    // Create Stripe Payment Intent with proofId in metadata
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 99, // $0.99 in cents
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
        product: 'day_pass'
      },
      description: `SENT. delivery proof — ${fileName}`,
      receipt_email: email || undefined,
      statement_descriptor_suffix: 'SENT PROOF'
    });

    // Insert pending proof record into Supabase
    const proofRecord = {
      proof_id: proofId,
      file_name: fileName.substring(0, 255),
      file_size: fileSize,
      file_hash: fileHash,
      timestamp: sealTimestamp,
      sealed_at: null,
      verified_at: null,
      user_email: email || null,
      sender_email: email || null,
      recipient_email: recipientEmail || null,
      project_name: projectName ? projectName.substring(0, 100) : null,
      rac_signature: racSignature,
      rac_chain_hash: null,
      rac_enabled: false,
      stripe_payment_id: paymentIntent.id,
      stripe_session_id: null,
      user_id: null,
      receipt_url: `https://vxsent.com/receipt?id=${proofId}`,
      is_valid: false,
      status: 'pending',
      veridex_proof_id: null,
      veridex_signature: null
    };

    const insertResult = await supabaseInsert('proofs', proofRecord);
    if (!insertResult) {
      console.warn('Failed to insert pending proof into Supabase — payment will still proceed');
    } else {
      console.log(`Pending proof inserted: ${proofId}`);
    }

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        proofId: proofId,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
      })
    };
  } catch (error) {
    console.error('create-payment-intent error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Payment initialization failed. Please try again.' })
    };
  }
};
