// netlify/functions/cancel-subscription.js

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
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
    let body;
    try {
      body = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid request body' })
      };
    }

    const { subscriptionId } = body;

    if (!subscriptionId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Subscription ID required' })
      };
    }

    // Cancel subscription
    const canceledSubscription = await stripe.subscriptions.del(subscriptionId);

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        success: true,
        subscriptionId: canceledSubscription.id,
        status: canceledSubscription.status,
        canceledAt: canceledSubscription.canceled_at
      })
    };
  } catch (error) {
    console.error('cancel-subscription error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Subscription cancellation failed' })
    };
  }
};
