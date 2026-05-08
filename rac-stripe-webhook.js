// netlify/functions/stripe-webhook.js
// Updated to pass RAC fields to guardedCommit() and store chain hash.

import Stripe from 'stripe';
import {
  getStripe, getSupabase,
  veridexGuardedCommit,
  sendReceiptEmail, sendHabitEmail, sendSubscriptionNudge,
  generateProofId
} from '../../src/lib/index.js';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const stripe = getStripe();
  const supabase = getSupabase();
  const sig = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  console.log(`Stripe event: ${stripeEvent.type}`);

  try {
    switch (stripeEvent.type) {

      case 'payment_intent.succeeded': {
        const pi = stripeEvent.data.object;
        const meta = pi.metadata;
        if (meta.product !== 'day_pass') break;

        const {
          proof_id: proofId,
          file_hash: fileHash,
          file_name: fileName,
          file_size: fileSize,
          timestamp,
          user_email: userEmail,
          recipient_email: recipientEmail,  // RAC: from metadata
          project_name: projectName         // RAC: from metadata
        } = meta;

        if (!proofId || !fileHash) { console.error('Missing proof metadata:', pi.id); break; }

        // Idempotency check
        const { data: existing } = await supabase
          .from('proofs').select('is_valid').eq('id', proofId).single();
        if (existing?.is_valid) { console.log('Already sealed:', proofId); break; }

        // ── CALL VERIDEX WITH FULL RAC CHAIN ──
        const veridexResult = await veridexGuardedCommit({
          proofId,
          fileHash,
          fileName,
          timestamp,
          paymentId: pi.id,
          // RAC fields — build the full authorization chain
          senderEmail: userEmail || null,
          recipientEmail: recipientEmail || null,
          projectName: projectName || null
        });

        // Store sealed proof with RAC chain hash
        await supabase.from('proofs').update({
          veridex_proof_id: veridexResult.proof_id || proofId,
          veridex_signature: veridexResult.signature,
          // RAC chain hash stored for display on receipt
          rac_chain_hash: veridexResult.rac_chain_hash || veridexResult.rac_receipt?.chain_hash || null,
          rac_enabled: !!veridexResult.rac_sealed,
          recipient_email: recipientEmail || null,
          is_valid: true,
          stripe_payment_id: pi.id
        }).eq('id', proofId);

        await supabase.from('payments').update({ status: 'succeeded' })
          .eq('stripe_payment_id', pi.id);

        // Send receipt email with RAC info
        if (userEmail) {
          await sendReceiptEmail({
            email: userEmail,
            proofId,
            fileName,
            fileSize,
            sealedAt: timestamp,
            recipientEmail: recipientEmail || null,
            racChainHash: veridexResult.rac_chain_hash || null
          });

          // Habit emails
          const { count: totalProofs } = await supabase
            .from('proofs').select('*', { count: 'exact', head: true })
            .eq('user_email', userEmail).eq('is_valid', true);

          if (totalProofs === 1) await sendHabitEmail({ email: userEmail });
          if (totalProofs === 2) await sendSubscriptionNudge({ email: userEmail, proofCount: 2 });
        }

        console.log('Proof sealed with RAC:', proofId, '| Recipient:', recipientEmail || 'unspecified');
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = stripeEvent.data.object;
        if (pi.metadata.product !== 'day_pass') break;
        await supabase.from('payments').update({ status: 'failed' }).eq('stripe_payment_id', pi.id);
        await supabase.from('proofs').delete().eq('stripe_payment_id', pi.id).eq('is_valid', false);
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const userEmail = subscription.metadata.user_email;
        if (!userEmail) break;

        const { data: user } = await supabase.from('users').select('id').eq('email', userEmail).single();
        if (user) {
          await supabase.from('users').update({
            plan: 'solo',
            plan_expires_at: new Date(subscription.current_period_end * 1000).toISOString()
          }).eq('id', user.id);

          await supabase.from('subscriptions').upsert({
            user_id: user.id,
            stripe_subscription_id: invoice.subscription,
            stripe_customer_id: invoice.customer,
            plan: 'solo', status: 'active',
            current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
            current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
          }, { onConflict: 'stripe_subscription_id' });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const userEmail = subscription.metadata.user_email;
        if (userEmail) {
          await supabase.from('users').update({ plan: 'none' }).eq('email', userEmail);
          await supabase.from('subscriptions').update({ status: 'past_due' })
            .eq('stripe_subscription_id', invoice.subscription);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = stripeEvent.data.object;
        const userEmail = sub.metadata.user_email;
        if (userEmail) {
          await supabase.from('users').update({ plan: 'none', plan_expires_at: null }).eq('email', userEmail);
          await supabase.from('subscriptions').update({ status: 'canceled', canceled_at: new Date().toISOString() })
            .eq('stripe_subscription_id', sub.id);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = stripeEvent.data.object;
        const userEmail = sub.metadata.user_email;
        if (userEmail && sub.status === 'active') {
          await supabase.from('users').update({
            plan_expires_at: new Date(sub.current_period_end * 1000).toISOString()
          }).eq('email', userEmail);
        }
        break;
      }

      default:
        console.log('Unhandled event:', stripeEvent.type);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (error) {
    console.error('Webhook error:', error);
    return { statusCode: 200, body: JSON.stringify({ received: true, error: error.message }) };
  }
};
