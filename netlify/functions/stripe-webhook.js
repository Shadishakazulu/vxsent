// netlify/functions/stripe-webhook.js
// Production-grade: verifies Stripe signature, updates proof in Supabase, sends receipt emails

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const crypto = require('crypto');

// ─── Supabase Helpers ───────────────────────────────────────────────────────

async function supabaseUpdate(table, matchColumn, matchValue, updates) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Supabase credentials not configured');
    return null;
  }

  const response = await fetch(
    `${url}/rest/v1/${table}?${matchColumn}=eq.${encodeURIComponent(matchValue)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(updates)
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Supabase update failed: ${response.status} ${errText}`);
    return null;
  }

  const data = await response.json();
  return data[0] || data;
}

async function supabaseQuery(table, matchColumn, matchValue) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error('Supabase credentials not configured');
    return null;
  }

  const response = await fetch(
    `${url}/rest/v1/${table}?${matchColumn}=eq.${encodeURIComponent(matchValue)}&limit=1`,
    {
      method: 'GET',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error(`Supabase query failed: ${response.status} ${errText}`);
    return null;
  }

  const data = await response.json();
  return data[0] || null;
}

// ─── Email Helper ───────────────────────────────────────────────────────────

async function sendReceiptEmail(toEmail, proofData, isRecipient = false) {
  try {
    const resendApiKey = process.env.RESEND_API_KEY;
    if (!resendApiKey) {
      console.warn('RESEND_API_KEY not configured, skipping email');
      return false;
    }

    const proofUrl = `https://vxsent.com/receipt?id=${proofData.proof_id}`;
    const roleLine = isRecipient
      ? 'A verified delivery proof has been created for a file sent to you.'
      : 'Your cryptographic proof of delivery has been sealed and verified.';

    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <span style="font-family: 'Bebas Neue', Impact, sans-serif; font-size: 28px; letter-spacing: 2px; color: #111;">● SENT.</span>
        </div>
        
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; text-align: center; margin-bottom: 24px;">
          <span style="color: #16a34a; font-weight: 700;">✓ DELIVERY VERIFIED</span>
        </div>

        <p style="color: #374151; line-height: 1.6;">${roleLine}</p>

        <table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Proof ID</td>
            <td style="padding: 12px 0; color: #111; font-weight: 600; font-family: monospace;">${proofData.proof_id}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">File</td>
            <td style="padding: 12px 0; color: #111;">${proofData.file_name}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Size</td>
            <td style="padding: 12px 0; color: #111;">${proofData.file_size}</td>
          </tr>
          <tr style="border-bottom: 1px solid #e5e7eb;">
            <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">Sealed At</td>
            <td style="padding: 12px 0; color: #16a34a; font-family: monospace;">${proofData.sealed_at}</td>
          </tr>
          <tr>
            <td style="padding: 12px 0; color: #6b7280; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">SHA-256</td>
            <td style="padding: 12px 0; color: #111; font-family: monospace; font-size: 11px; word-break: break-all;">${proofData.file_hash}</td>
          </tr>
        </table>

        <div style="text-align: center; margin: 32px 0;">
          <a href="${proofUrl}" style="display: inline-block; background: #00b356; color: #fff; padding: 14px 32px; border-radius: 4px; text-decoration: none; font-weight: 700; letter-spacing: 0.5px;">VIEW PROOF RECEIPT</a>
        </div>

        <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 40px;">
          This proof is permanent, independently verifiable, and cryptographically sealed.<br>
          <a href="https://vxsent.com" style="color: #00b356;">vxsent.com</a>
        </p>
      </div>
    `;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'SENT. <noreply@vxsent.com>',
        to: toEmail,
        subject: `SENT. Proof Sealed — ${proofData.file_name}`,
        html: emailHtml
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`Failed to send email to ${toEmail}: ${response.status} ${errBody}`);
      return false;
    }

    console.log(`Receipt email sent to ${toEmail}`);
    return true;
  } catch (error) {
    console.error('Error sending email:', error.message);
    return false;
  }
}

// ─── Webhook Handler ────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Webhook signature verification failed' })
    };
  }

  // Handle test events from Stripe dashboard
  if (stripeEvent.id.startsWith('evt_test_')) {
    console.log('[Webhook] Test event detected, returning verification response');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verified: true })
    };
  }

  try {
    switch (stripeEvent.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = stripeEvent.data.object;
        const proofId = paymentIntent.metadata?.proof_id;

        if (!proofId) {
          console.warn('payment_intent.succeeded without proof_id in metadata:', paymentIntent.id);
          break;
        }

        console.log(`Payment succeeded for proof: ${proofId}`);

        const now = new Date().toISOString();

        // Update proof record in Supabase to sealed/verified
        const updated = await supabaseUpdate('proofs', 'proof_id', proofId, {
          status: 'verified',
          is_valid: true,
          sealed_at: now,
          verified_at: now,
          stripe_payment_id: paymentIntent.id,
          updated_at: now
        });

        if (updated) {
          console.log(`Proof sealed: ${proofId}`);

          // Send receipt emails
          const userEmail = paymentIntent.metadata?.user_email;
          const recipientEmail = paymentIntent.metadata?.recipient_email;

          const proofData = {
            proof_id: proofId,
            file_name: paymentIntent.metadata?.file_name || 'Unknown file',
            file_size: paymentIntent.metadata?.file_size || 'Unknown',
            file_hash: paymentIntent.metadata?.file_hash || '',
            sealed_at: now
          };

          if (userEmail) {
            await sendReceiptEmail(userEmail, proofData, false);
          }
          if (recipientEmail && recipientEmail !== userEmail) {
            await sendReceiptEmail(recipientEmail, proofData, true);
          }
        } else {
          console.error(`Failed to update proof in Supabase: ${proofId}`);
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const failedIntent = stripeEvent.data.object;
        const failedProofId = failedIntent.metadata?.proof_id;
        console.log(`Payment failed: ${failedIntent.id}, proof: ${failedProofId || 'N/A'}`);

        if (failedProofId) {
          await supabaseUpdate('proofs', 'proof_id', failedProofId, {
            status: 'payment_failed',
            updated_at: new Date().toISOString()
          });
        }
        break;
      }

      case 'charge.refunded': {
        const charge = stripeEvent.data.object;
        const refundedIntent = charge.payment_intent;
        console.log(`Charge refunded: ${charge.id}, intent: ${refundedIntent}`);

        // Look up proof by stripe_payment_id
        if (refundedIntent) {
          const proof = await supabaseQuery('proofs', 'stripe_payment_id', refundedIntent);
          if (proof) {
            await supabaseUpdate('proofs', 'proof_id', proof.proof_id, {
              status: 'refunded',
              is_valid: false,
              updated_at: new Date().toISOString()
            });
            console.log(`Proof invalidated due to refund: ${proof.proof_id}`);
          }
        }
        break;
      }

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };
  } catch (error) {
    console.error('Webhook processing error:', error.message, error.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Webhook processing failed' })
    };
  }
};
