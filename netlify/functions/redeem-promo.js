// netlify/functions/redeem-promo.js
// SENT. — 100%-off promo coupons (e.g. LAUNCH7).
//
// A "free_purchase" promo code makes the CURRENT one-time purchase free:
//   - Day Pass ($0.99 proof) → issued with NO Stripe charge
//   - Single Transfer ($4.99 verification fee) → sealed with NO Stripe charge
//     (only OUR fee is waived; the buyer/seller sale is untouched)
//
// This REUSES the existing promo system (promo_codes / promo_redemptions) for
// validation + one-redemption-per-customer enforcement, and the existing
// non-Stripe seal helpers (_proof-finalize-helper / _transfer-finalize-helper)
// that the Solo plan already uses to deliver a product without a payment.
//
// Two actions:
//   action:'validate' — the "Apply" button. Confirms the code is a valid,
//     unused, 100%-off coupon for this customer. Delivers nothing.
//   action:'redeem'   — the "Get it free" confirm. Claims the redemption
//     (unique (code,email) is the hard guard), then seals + delivers the
//     product with no Stripe charge.

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';
import { finalizeProof } from './_proof-finalize-helper.js';
import { finalizeTransfer } from './_transfer-finalize-helper.js';

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function generateProofId() {
  const year = new Date().getFullYear();
  const h = (n) => randomBytes(n).toString('hex').toUpperCase();
  return `SENT-${year}-${h(3)}-${h(2)}-${h(2)}-${h(2)}`;
}

function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
function normalizeEmail(email) { return (email || '').trim().toLowerCase(); }
function ok(body) { return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) }; }
function bad(error, code = 400) { return { statusCode: code, headers: CORS_HEADERS, body: JSON.stringify({ error }) }; }

// Validate a promo code against the SAME rules the existing promo system uses:
// exists, active, not expired, under any overall max_uses, and not already
// redeemed by this customer. Additionally requires it to be a 100%-off coupon.
// Returns { promo } when usable, or { error } with a clear inline message.
async function checkPromo(supabase, codeUpper, email) {
  const { data: rows, error: lookupErr } = await supabase
    .from('promo_codes').select('*').eq('code', codeUpper).limit(1);
  if (lookupErr) return { error: 'Could not check that code. Please try again.' };

  const promo = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!promo) return { error: 'That promo code isn’t valid.' };
  if (!promo.active) return { error: 'That promo code is no longer active.' };
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) return { error: 'That promo code has expired.' };
  if (promo.max_uses != null && (promo.times_used || 0) >= promo.max_uses) return { error: 'That promo code has reached its limit.' };

  const isFree = promo.kind === 'free_purchase' || (promo.percent_off != null && promo.percent_off >= 100);
  if (!isFree) return { error: 'That code can’t be applied to this purchase.' };

  // One redemption per customer (the unique (code,email) constraint is the
  // backstop; this is the friendly pre-check).
  const { data: red } = await supabase
    .from('promo_redemptions').select('id').eq('code', promo.code).eq('email', email).limit(1);
  if (Array.isArray(red) && red.length) return { error: 'You’ve already used this promo code.' };

  return { promo };
}

// Increment the overall usage counter (best-effort; per-customer enforcement is
// handled by promo_redemptions, not this counter).
async function bumpTimesUsed(supabase, code) {
  try {
    const { data } = await supabase.from('promo_codes').select('times_used').eq('code', code).limit(1);
    const current = Array.isArray(data) && data.length ? (data[0].times_used || 0) : 0;
    await supabase.from('promo_codes').update({ times_used: current + 1 }).eq('code', code);
  } catch (e) {
    console.error('[redeem-promo] times_used bump failed (non-fatal):', e.message);
  }
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return bad('Method not allowed', 405);

  const supabase = getSupabase();
  if (!supabase) return bad('Service unavailable', 500);

  let body;
  try { body = JSON.parse(event.body); }
  catch { return bad('Invalid request body'); }

  const action = body.action === 'redeem' ? 'redeem' : 'validate';
  const product = body.product === 'single_transfer' ? 'single_transfer' : 'day_pass';
  const codeUpper = (body.code || '').trim().toUpperCase();
  const email = normalizeEmail(body.email);

  if (!codeUpper) return bad('Enter a promo code first.');
  if (!isValidEmail(email)) return bad('Add your email above, then apply the code.');

  // ── VALIDATE (Apply button) ────────────────────────────────────────────────
  if (action === 'validate') {
    const result = await checkPromo(supabase, codeUpper, email);
    if (result.error) return bad(result.error);
    return ok({
      valid: true,
      free: true,
      code: result.promo.code,
      percentOff: result.promo.percent_off != null ? result.promo.percent_off : 100,
      message: product === 'single_transfer'
        ? 'Applied — your verification fee is free.'
        : 'Applied — your Day Pass is free.'
    });
  }

  // ── REDEEM (Get it free confirm) ───────────────────────────────────────────
  // Re-validate authoritatively on the server before delivering anything.
  const result = await checkPromo(supabase, codeUpper, email);
  if (result.error) return bad(result.error);
  const promo = result.promo;
  const now = new Date().toISOString();

  // Resolve the reference id we'll seal, validating the request shape first.
  let proofId = null;
  let transferId = null;

  if (product === 'single_transfer') {
    transferId = body.transferId;
    if (!transferId || !String(transferId).startsWith('SENT-TX-')) return bad('Valid transfer ID required.');
    const { data: trows } = await supabase
      .from('transfers').select('id, is_valid, seller_email').eq('id', transferId).limit(1);
    const transfer = Array.isArray(trows) && trows.length ? trows[0] : null;
    if (!transfer) return bad('Transfer not found.', 404);
    if (transfer.is_valid) return bad('This transfer has already been sealed.');
  } else {
    // Day Pass — validate the proof inputs (mirror create-payment-intent).
    if (!body.fileHash || body.fileHash.length !== 64) return bad('Invalid file hash.');
    if (!body.fileName) return bad('File name required.');
    if (body.recipientEmail && !isValidEmail(body.recipientEmail)) return bad('Please enter a valid recipient email.');
    proofId = generateProofId();
  }

  // STEP 1 — Claim the redemption FIRST. The unique (code,email) constraint
  // genuinely enforces one free purchase per customer, even under a race: the
  // loser gets a 23505 and we deliver nothing for them.
  const referenceId = product === 'single_transfer' ? transferId : proofId;
  const { error: claimErr } = await supabase.from('promo_redemptions').insert({
    code: promo.code,
    email,
    product,
    reference_id: referenceId,
    redeemed_at: now
  });
  if (claimErr) {
    if (claimErr.code === '23505') return bad('You’ve already used this promo code.');
    console.error('[redeem-promo] claim insert failed:', claimErr.message);
    return bad('Could not apply that code. Please try again.', 500);
  }

  // STEP 2 — Deliver the product with NO Stripe charge, reusing the same seal
  // helpers the Solo plan uses. If anything fails, release the claim (and any
  // half-created proof) so the customer isn't locked out and nothing is orphaned.
  try {
    if (product === 'single_transfer') {
      await finalizeTransfer({ transferId });
      await bumpTimesUsed(supabase, promo.code);
      const baseUrl = process.env.URL || 'https://vxsent.com';
      return ok({ success: true, transferId, verifyUrl: `${baseUrl}/verify/${transferId}` });
    }

    // Day Pass — create the proof row, then seal it (proof-only, no charge).
    const recipientEmail = (body.recipientEmail || '').trim() || null;
    const sealedAt = body.timestamp || now;
    const deliveryMessage = (typeof body.deliveryMessage === 'string' && body.deliveryMessage.trim())
      ? body.deliveryMessage.trim().slice(0, 2000) : null;

    const { error: insertErr } = await supabase.from('proofs').insert({
      id: proofId,
      file_name: String(body.fileName).substring(0, 255),
      file_size: body.fileSize || null,
      file_hash: body.fileHash,
      sealed_at: sealedAt,
      stripe_payment_id: `promo_${promo.code}_${proofId}`,
      user_id: null,
      user_email: email,
      recipient_email: recipientEmail,
      project_name: (body.projectName || '').trim() || null,
      delivery_message: deliveryMessage,
      is_valid: false,
      rac_enabled: false,
      created_at: now,
      updated_at: now
    });
    if (insertErr) throw new Error(`proof insert failed: ${insertErr.message}`);

    await finalizeProof({
      proofId,
      user: { id: null, email },
      recipientEmail,
      fileName: body.fileName,
      fileSize: body.fileSize || '',
      fileHash: body.fileHash,
      projectName: (body.projectName || '').trim() || null,
      timestamp: sealedAt,
      hasFile: false,
      deliveryMessage: deliveryMessage || ''
    });

    await bumpTimesUsed(supabase, promo.code);
    const baseUrl = process.env.URL || 'https://vxsent.com';
    return ok({ success: true, proofId, receiptUrl: `${baseUrl}/receipt?id=${proofId}` });

  } catch (err) {
    console.error('[redeem-promo] delivery failed, rolling back claim:', err.message);
    // Release the per-customer claim so they can retry.
    await supabase.from('promo_redemptions').delete().eq('code', promo.code).eq('email', email);
    // Drop any pending proof we created so nothing is left half-finished.
    if (proofId) await supabase.from('proofs').delete().eq('id', proofId).eq('is_valid', false);
    return bad('Could not complete your free purchase. Please try again.', 500);
  }
};
