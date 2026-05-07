// netlify/functions/create-payment-intent.js

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS' ) {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  if (event.httpMethod !== 'POST' ) {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Check if Stripe key is available
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('STRIPE_SECRET_KEY not set');
      return {
        statusCode: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Payment service not configured. Please contact support.'
        })
      };
    }

    // Dynamically require stripe
    let stripe;
    try {
      stripe = require('stripe')(stripeKey);
    } catch (err) {
      console.error('Failed to initialize Stripe:', err);
      return {
        statusCode: 500,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          error: 'Payment service initialization failed'
        })
      };
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Invalid request body' })
      };
    }

    const {
      fileHash,
      fileName,
      fileSize,
      timestamp,
      email,
      recipientEmail,
      projectName
    } = body;

    // Validation
    if (!fileHash || fileHash.length !== 64) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Invalid file hash' })
      };
    }
    if (!fileName) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'File name required' })
      };
    }
    if (!fileSize) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'File size required' })
      };
    }
    if (!timestamp) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Timestamp required' })
      };
    }

    // Create Stripe Payment Intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 99, // $0.99 in cents
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        file_hash: fileHash,
        file_name: fileName.substring(0, 100),
        file_size: fileSize,
        timestamp,
        user_email: email || '',
        recipient_email: recipientEmail || '',
        project_name: (projectName || '').substring(0, 100),
        product: 'day_pass'
      },
      description: `SENT. delivery proof — ${fileName}`,
      receipt_email: email || undefined,
      statement_descriptor: 'SENT PROOF'
    });

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        clientSecret: paymentIntent.client_secret,
        publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
      })
    };
  } catch (error) {
    console.error('create-payment-intent error:', error.message, error.stack);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Payment initialization failed. Please try again.'
      })
    };
  }
};
