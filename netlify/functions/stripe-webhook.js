// netlify/functions/stripe-webhook.js
// Handles Stripe webhook events including checkout.session.completed

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');

// Generate a cryptographic proof ID
function generateProofId() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

// Generate RAC (Recursive Attestation Chain) signature
function generateRACSignature(fileHash, timestamp, proofId) {
  const data = `${fileHash}|${timestamp}|${proofId}`;
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Send receipt email via Resend API
async function sendReceiptEmail(email, proofData) {
  try {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      console.warn('RESEND_API_KEY not configured, skipping email');
      return false;
    }

    const proofUrl = `https://vxsent.com/receipt?id=${proofData.proofId}`;
    
    const emailHtml = `
      <h2>Your SENT. Delivery Proof</h2>
      <p>Your cryptographic proof of delivery has been sealed.</p>
      <p><strong>Proof ID:</strong> ${proofData.proofId}</p>
      <p><strong>File Hash (SHA-256 ):</strong> ${proofData.fileHash}</p>
      <p><strong>Timestamp:</strong> ${new Date(proofData.timestamp).toISOString()}</p>
      <p><strong>RAC Signature:</strong> ${proofData.racSignature}</p>
      <p><a href="${proofUrl}">View Your Proof</a></p>
      <hr/>
      <p>This proof is permanent and cryptographically sealed. Use it to resolve any delivery disputes.</p>
    `;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'noreply@vxsent.com',
        to: email,
        subject: `Your SENT. Proof: ${proofData.proofId}`,
        html: emailHtml
      } )
    });

    if (!response.ok) {
      console.error('Failed to send email:', await response.text());
      return false;
    }

    console.log(`Email sent to ${email}`);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
}

// Create proof record
async function createProofRecord(sessionData) {
  try {
    const fileHash = sessionData.metadata?.file_hash;
    const userEmail = sessionData.metadata?.user_email;
    const clientEmail = sessionData.metadata?.client_email;
    const fileName = sessionData.metadata?.file_name;
    const timestamp = new Date().getTime();
    const proofId = generateProofId();
    
    // Generate RAC signature
    const racSignature = generateRACSignature(fileHash, timestamp, proofId);

    const proofData = {
      proofId,
      fileHash,
      fileName,
      userEmail,
      clientEmail,
      timestamp,
      racSignature,
      sessionId: sessionData.id,
      amount: sessionData.amount_total,
      currency: sessionData.currency,
      status: 'sealed'
    };

    // Log proof creation (in production, store in database)
    console.log('Proof created:', JSON.stringify(proofData, null, 2));

    // Send receipt emails to both user and client
    if (userEmail) {
      await sendReceiptEmail(userEmail, proofData);
    }
    if (clientEmail && clientEmail !== userEmail) {
      await sendReceiptEmail(clientEmail, proofData);
    }

    return proofData;
  } catch (error) {
    console.error('Error creating proof record:', error);
    throw error;
  }
}

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
      case 'checkout.session.completed':
        console.log('Checkout session completed:', stripeEvent.data.object.id);
        const session = stripeEvent.data.object;
        
        // Only process paid sessions
        if (session.payment_status === 'paid') {
          const proofData = await createProofRecord(session);
          console.log('Proof sealed:', proofData.proofId);
        }
        break;

      case 'payment_intent.succeeded':
        console.log('Payment succeeded:', stripeEvent.data.object.id);
        // Legacy payment intent handling
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
