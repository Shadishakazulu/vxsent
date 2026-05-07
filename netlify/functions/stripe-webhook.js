// netlify/functions/stripe-webhook.js
// Handles Stripe webhook events

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST' ) {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Webhook signature verification failed' })
    };
  }

  try {
    switch (stripeEvent.type) {
      case 'payment_intent.succeeded':
        console.log('Payment succeeded:', stripeEvent.data.object.id);
        // Handle successful payment
        break;

      case 'payment_intent.payment_failed':
        console.log('Payment failed:', stripeEvent.data.object.id);
        // Handle failed payment
        break;

      case 'charge.refunded':
        console.log('Charge refunded:', stripeEvent.data.object.id);
        // Handle refund
        break;

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };
  } catch (error) {
    console.error('Webhook processing error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Webhook processing failed' })
    };
  }
};
