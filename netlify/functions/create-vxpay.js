// netlify/functions/create-vxpay.js
// VX Pay — create an escrowed payment agreement (buyer or seller opens it).
// Session auth via Supabase, agreement row persisted to the Netlify Database.
// Finalize (finalize-vxpay.js) seals it after evidence uploads complete.

import { randomBytes } from 'crypto';
import { getDb, verifySession, CORS_HEADERS } from './_vxpay-common.js';
import { finalizeVxpay } from './_vxpay-finalize-helper.js';

function generateVxpayId() {
  const year = new Date().getFullYear();
  return `VXPAY-${year}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const user = await verifySession(event);   // creator must be signed in
    const body = JSON.parse(event.body || '{}');

    const required = ['buyer_email', 'buyer_name', 'seller_email', 'seller_name', 'item_title', 'amount'];
    for (const f of required) {
      if (!body[f] && body[f] !== 0)
        return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `Missing field: ${f}` }) };
    }

    const db = getDb();
    const id = generateVxpayId();
    const createdByRole = body.created_by_role === 'seller' ? 'seller' : 'buyer';
    const categoryAttributes = JSON.stringify(body.category_attributes || {});

    await db.sql`
      INSERT INTO vxpay_agreements (
        id, user_id, created_by_role,
        buyer_email, buyer_name, buyer_phone,
        seller_email, seller_name, seller_phone,
        item_title, category, amount, currency, description,
        condition, condition_custom, provenance, category_attributes,
        location, notes, inspection_period_hours, release_conditions,
        sold_as_is, no_warranty,
        onchain_chain_id, onchain_vault_address, onchain_transaction_id,
        status, payment_ref
      ) VALUES (
        ${id}, ${user?.id ?? null}, ${createdByRole},
        ${body.buyer_email}, ${body.buyer_name}, ${body.buyer_phone || null},
        ${body.seller_email}, ${body.seller_name}, ${body.seller_phone || null},
        ${body.item_title}, ${body.category || 'general'}, ${body.amount}, ${body.currency || 'USD'}, ${body.description || null},
        ${body.condition || null}, ${body.condition_custom || null}, ${body.provenance || null}, ${categoryAttributes}::jsonb,
        ${body.location || null}, ${body.notes || null}, ${body.inspection_period_hours ?? 72}, ${body.release_conditions || null},
        ${!!body.sold_as_is}, ${!!body.no_warranty},
        ${body.onchain_chain_id ?? null}, ${body.onchain_vault_address || null}, ${body.onchain_transaction_id || null},
        ${'pending'}, ${body.payment_ref || null}
      )
    `;

    // ── Entitlement gate (mirrors create-transfer.js) ────────────────
    // Solo / Pro / Enterprise plans include unlimited escrow agreements:
    // seal for FREE immediately. Everyone else must pay $7.99 (the page then
    // calls /api/vxpay/create-payment and the webhook seals on payment).
    const planExpiry = user?.plan_expires_at ? new Date(user.plan_expires_at) : null;
    const hasPlan = !!user &&
      (user.plan === 'solo' || user.plan === 'pro' || user.plan === 'enterprise') &&
      planExpiry && planExpiry > new Date();

    if (hasPlan) {
      try {
        const sealed = await finalizeVxpay({ agreementId: id });
        // Tag payment_ref so the record shows it was plan-covered.
        await db.sql`UPDATE vxpay_agreements SET payment_ref = ${`${user.plan}_plan`} WHERE id = ${id}`;
        const baseUrl = process.env.URL || 'https://vxsent.com';
        return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({
          id, status: 'sealed', requiresPayment: false, sealed: true,
          rac_chain_hash: sealed.chainHash,
          verify_url: `${baseUrl}/verify/${id}`
        }) };
      } catch (e) {
        // If the free seal errors, fall through to the paid path rather than fail.
        console.error('[create-vxpay] plan auto-seal failed, falling back to payment:', e.message);
      }
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ id, status: 'pending', requiresPayment: true }) };
  } catch (err) {
    console.error('[create-vxpay]', err);
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message }) };
  }
}
