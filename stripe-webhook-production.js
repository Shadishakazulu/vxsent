const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Initialize Supabase client with service role key for admin operations
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://fjowiopznwafjqhdbrsv.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZqb3dpb3B6bndhZmpxaGRicnN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Nzg0OTcwNSwiZXhwIjoyMDkzNDI1NzA1fQ._nRE-09j8VxXSgXeUZMCxu5Cihxw-xjPjmqqUs5jv7Q'
);

/**
 * Generate a unique Proof ID
 * Format: PROOF-{timestamp}{random}
 */
function generateProofId() {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `PROOF-${timestamp}${random}`;
}

/**
 * Generate RAC (Recursive Attestation Chain) Signature
 * Combines file hash and timestamp for cryptographic proof
 */
function generateRACSignature(fileHash, timestamp) {
  const data = `${fileHash}:${timestamp}`;
  return crypto
    .createHash('sha256')
    .update(data)
    .digest('hex')
    .toUpperCase();
}

/**
 * Main webhook handler
 */
exports.handler = async (event) => {
  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ 
        error: 'Webhook signature verification failed',
        message: err.message 
      }),
    };
  }

  console.log(`[Webhook] Received event: ${stripeEvent.type} (ID: ${stripeEvent.id})`);

  // Handle checkout.session.completed event
  if (stripeEvent.type === 'checkout.session.completed') {
    return await handleCheckoutSessionCompleted(stripeEvent.data.object);
  }

  // Handle charge.failed event
  if (stripeEvent.type === 'charge.failed') {
    return await handleChargeFailed(stripeEvent.data.object);
  }

  // Handle charge.refunded event
  if (stripeEvent.type === 'charge.refunded') {
    return await handleChargeRefunded(stripeEvent.data.object);
  }

  // Default response for unhandled events
  return {
    statusCode: 200,
    body: JSON.stringify({ received: true, eventType: stripeEvent.type }),
  };
};

/**
 * Handle checkout.session.completed event
 * Creates a new proof record in Supabase
 */
async function handleCheckoutSessionCompleted(session) {
  try {
    console.log(`[Checkout] Processing session: ${session.id}`);

    // Extract metadata from session
    const clientReferenceId = session.client_reference_id;
    const metadata = session.metadata || {};
    
    const userId = metadata.user_id || clientReferenceId;
    const senderEmail = metadata.customer_email || session.customer_email || 'unknown@example.com';
    const recipientEmail = metadata.recipient_email || 'unknown@example.com';
    const fileName = metadata.file_name || 'document.pdf';
    const fileSize = metadata.file_size || '0 bytes';
    const fileHash = metadata.file_hash || crypto.randomBytes(32).toString('hex');

    console.log(`[Checkout] Metadata extracted:`);
    console.log(`   Sender: ${senderEmail}`);
    console.log(`   Recipient: ${recipientEmail}`);
    console.log(`   File: ${fileName}`);

    // Generate proof details
    const proofId = generateProofId();
    const timestamp = new Date().toISOString();
    const racSignature = generateRACSignature(fileHash, timestamp);

    console.log(`[Proof] Generated:`);
    console.log(`   Proof ID: ${proofId}`);
    console.log(`   Hash: ${fileHash.substring(0, 16)}...`);
    console.log(`   Signature: ${racSignature.substring(0, 16)}...`);

    // Store in Supabase
    const { data, error } = await supabase
      .from('proofs')
      .insert([
        {
          proof_id: proofId,
          file_hash: fileHash,
          timestamp: timestamp,
          rac_signature: racSignature,
          sender_email: senderEmail,
          recipient_email: recipientEmail,
          file_name: fileName,
          file_size: fileSize,
          status: 'verified',
          verified_at: timestamp,
        },
      ]);

    if (error) {
      console.error('❌ Supabase insert error:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({ 
          error: 'Failed to store proof',
          details: error.message 
        }),
      };
    }

    console.log(`✅ Proof stored successfully: ${proofId}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        proofId: proofId,
        message: 'Proof stored successfully',
        details: {
          sender: senderEmail,
          recipient: recipientEmail,
          file: fileName,
          timestamp: timestamp,
        },
      }),
    };
  } catch (err) {
    console.error('❌ Error processing checkout.session.completed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: err.message 
      }),
    };
  }
}

/**
 * Handle charge.failed event
 * Log failed payment attempts
 */
async function handleChargeFailed(charge) {
  try {
    console.log(`❌ Payment failed:`);
    console.log(`   Charge ID: ${charge.id}`);
    console.log(`   Amount: ${charge.amount / 100} ${charge.currency.toUpperCase()}`);
    console.log(`   Reason: ${charge.failure_message}`);
    console.log(`   Code: ${charge.failure_code}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        received: true,
        message: 'Payment failure logged' 
      }),
    };
  } catch (err) {
    console.error('❌ Error processing charge.failed:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}

/**
 * Handle charge.refunded event
 * Log refund transactions
 */
async function handleChargeRefunded(charge) {
  try {
    console.log(`💰 Refund processed:`);
    console.log(`   Charge ID: ${charge.id}`);
    console.log(`   Amount Refunded: ${charge.amount_refunded / 100} ${charge.currency.toUpperCase()}`);
    console.log(`   Reason: ${charge.refunded ? 'Full refund' : 'Partial refund'}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        received: true,
        message: 'Refund logged' 
      }),
    };
  } catch (err) {
    console.error('❌ Error processing charge.refunded:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
