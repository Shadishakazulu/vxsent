// netlify/functions/create-checkout-session.js

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS'  ) {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    };
  }

  if (event.httpMethod !== 'POST'  ) {
    return {
      statusCode: 405,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Check if Stripe key is available
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('[create-checkout-session] STRIPE_SECRET_KEY not set');
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

    // Parse request body
    let body;
    try {
      body = JSON.parse(event.body);
    } catch (err) {
      console.error('[create-checkout-session] Invalid JSON:', err.message);
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Invalid request body' })
      };
    }

    const { email, recipientEmail, fileName, fileHash } = body;

    // Validation
    if (!email) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Email is required' })
      };
    }

    if (!recipientEmail) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'Recipient email is required' })
      };
    }

    if (!fileName) {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error: 'File name is required' })
      };
    }

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

    // Initialize Stripe
    let stripe;
    try {
      stripe = require('stripe')(stripeKey);
      console.log('[create-checkout-session] Stripe initialized successfully');
    } catch (err) {
      console.error('[create-checkout-session] Failed to initialize Stripe:', err.message, err.stack);
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

    // Get the origin for redirect URLs
    const origin = event.headers.origin || 'https://vxsent.com';

    // Create Stripe Checkout Session
    console.log('[create-checkout-session] Creating checkout session for:', email, fileName  );
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'SENT. Delivery Proof',
              description: `Proof of delivery for: ${fileName}`
            },
            unit_amount: 99 // $0.99 in cents
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      customer_email: email,
      success_url: `${origin}/receipt?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?canceled=true`,
      metadata: {
        file_hash: fileHash,
        file_name: fileName.substring(0, 100),
        sender_email: email,
        recipient_email: recipientEmail,
        user_email: email
      }
    });

    console.log('[create-checkout-session] Session created:', session.id);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: session.url
      })
    };
  } catch (error) {
    console.error('[create-checkout-session] Error:', error.message);
    console.error('[create-checkout-session] Stack:', error.stack);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: error.message || 'Checkout session creation failed. Please try again.'
      })
    };
  }
};
